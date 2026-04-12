import { spawn, spawnSync } from "child_process";
import { awaitPaneIdle } from "../terminal/activity";
import type { PaneActivityOptions, ActivityResult } from "../terminal/activity";

export interface TmuxWindowSummary {
  windowId: string;
  paneId: string;
  windowName: string;
  paneCurrentPath?: string;
  windowActivity?: string;
  panePid?: number;
}

async function tmux(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-lc", shellCommand("tmux", ...args)]);
    const out: string[] = [];
    const err: string[] = [];
    proc.stdout.on("data", (d: Buffer) => out.push(d.toString()));
    proc.stderr.on("data", (d: Buffer) => err.push(d.toString()));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: out.join(""), stderr: err.join("") });
      } else {
        reject(
          new Error(
            `tmux ${args.join(" ")}: exit ${code} (stderr=${err.join("")})`,
          ),
        );
      }
    });
    proc.on("error", reject);
  });
}

function shellCommand(...args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function hasSession(name: string): boolean {
  return (
    spawnSync("bash", ["-lc", shellCommand("tmux", "has-session", "-t", name)], {
      stdio: "pipe",
    }).status === 0
  );
}

function hasPane(id: string): boolean {
  return (
    spawnSync(
      "bash",
      ["-lc", shellCommand("tmux", "display-message", "-p", "-t", id, "#{pane_id}")],
      { stdio: "pipe" },
    ).status === 0
  );
}

function windowTarget(sessionName: string, windowName: string): string {
  return `${sessionName}:${windowName}`;
}

export async function killSession(name: string): Promise<void> {
  if (!hasSession(name)) return;
  await tmux("kill-session", "-t", name);
}

export async function listWindows(name: string): Promise<TmuxWindowSummary[]> {
  if (!hasSession(name)) return [];

  const result = await tmux(
    "list-windows",
    "-t",
    name,
    "-F",
    "#{window_id}\t#{pane_id}\t#{window_name}\t#{pane_current_path}\t#{window_activity}\t#{pane_pid}",
  );

  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [
        windowId,
        paneId,
        windowName,
        paneCurrentPath,
        windowActivity,
        panePid,
      ] = line.split("\t", 6);
      return {
        windowId,
        paneId,
        windowName,
        paneCurrentPath: paneCurrentPath || undefined,
        windowActivity: windowActivity || undefined,
        panePid: panePid ? parseInt(panePid, 10) : undefined,
      };
    })
    .filter((window) => window.windowId && window.paneId && window.windowName);
}

export interface CaptureOpts {
  withEscapes?: boolean;
  includeScrollback?: boolean;
}

export class Session {
  readonly name: string;
  readonly command: string[];
  readonly windowId: string;
  readonly paneId: string;

  private constructor(
    name: string,
    command: string[],
    windowId: string,
    paneId: string,
  ) {
    this.name = name;
    this.command = command;
    this.windowId = windowId;
    this.paneId = paneId;
  }

  static async newSession(
    name: string,
    width: number,
    height: number,
    workingDir: string,
    command: string[],
    windowName: string,
  ): Promise<Session> {
    if (command.length === 0) {
      throw new Error("tmuxctl: command is required");
    }

    const format = "#{window_id}\t#{pane_id}";
    const target = windowTarget(name, windowName);
    const result = hasSession(name)
      ? await tmux(
        "new-window",
        "-P",
        "-F",
        format,
        "-t",
        name,
        "-n",
        windowName,
        ...(workingDir ? ["-c", workingDir] : []),
        ...command,
        ";",
        "set-option",
        "-q",
        "-t",
        name,
        "destroy-unattached",
        "off",
        ";",
        "set-option",
        "-q",
        "-t",
        name,
        "status",
        "off",
        ";",
        "resize-window",
        "-t",
        target,
        "-x",
        String(width),
        "-y",
        String(height),
      )
      : await tmux(
        "new-session",
        "-d",
        "-P",
        "-F",
        format,
        "-s",
        name,
        "-n",
        windowName,
        "-x",
        String(width),
        "-y",
        String(height),
        ...(workingDir ? ["-c", workingDir] : []),
        ...command,
        ";",
        "set-option",
        "-q",
        "-t",
        name,
        "destroy-unattached",
        "off",
        ";",
        "set-option",
        "-q",
        "-t",
        name,
        "status",
        "off",
        ";",
        "resize-window",
        "-t",
        target,
        "-x",
        String(width),
        "-y",
        String(height),
      );

    const [windowId, paneId] = result.stdout.trim().split(/\s+/, 2);
    if (!windowId || !paneId) {
      throw new Error(`tmuxctl: failed to parse tmux target ids: ${result.stdout}`);
    }

    return new Session(name, command, windowId, paneId);
  }

  /**
   * Find an existing tmux window by session name and window name.
   * Returns a Session if the window is alive, null otherwise.
   */
  static async find(
    sessionName: string,
    windowName: string,
  ): Promise<Session | null> {
    if (!hasSession(sessionName)) return null;
    try {
      const result = await tmux(
        "list-windows",
        "-t",
        sessionName,
        "-F",
        "#{window_id}\t#{pane_id}\t#{window_name}",
      );
      for (const line of result.stdout.trim().split("\n")) {
        const [windowId, paneId, name] = line.split("\t", 3);
        if (name === windowName && windowId && paneId) {
          const session = new Session(sessionName, [], windowId, paneId);
          if (session.isAlive) return session;
        }
      }
    } catch {
      // Session might not exist or list-windows failed.
    }
    return null;
  }

  async kill(): Promise<void> {
    if (!this.isAlive) return;
    await tmux("kill-window", "-t", this.windowId);
  }

  get isAlive(): boolean {
    return hasPane(this.paneId);
  }

  async resize(width: number, height: number): Promise<void> {
    await tmux(
      "resize-window",
      "-t",
      this.windowId,
      "-x",
      String(width),
      "-y",
      String(height),
    );
  }

  async sendKeys(input: string): Promise<void> {
    if (!input) return;
    await tmux("send-keys", "-t", this.paneId, "-l", "--", input);
  }

  async sendLine(input: string): Promise<void> {
    if (input) {
      await this.sendKeys(input);
    }
    await this.sendSpecial("Enter");
  }

  async sendSpecial(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await tmux("send-keys", "-t", this.paneId, ...keys);
  }

  async interrupt(): Promise<void> {
    await this.sendSpecial("C-c");
  }

  async capturePane(opts: CaptureOpts = {}): Promise<string> {
    const args = ["capture-pane", "-p", "-t", this.paneId];
    if (opts.withEscapes) {
      args.push("-e");
    }
    if (opts.includeScrollback) {
      args.push("-S", "-");
    }
    args.push("-J");

    const result = await tmux(...args);
    return result.stdout;
  }

  async awaitIdle(options?: PaneActivityOptions): Promise<ActivityResult> {
    return awaitPaneIdle(() => this.capturePane(), options);
  }

  async panePID(): Promise<number> {
    const result = await tmux(
      "display-message",
      "-p",
      "-t",
      this.paneId,
      "#{pane_pid}",
    );
    return parseInt(result.stdout.trim(), 10);
  }
}
