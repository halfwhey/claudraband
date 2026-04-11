import { spawn, execSync } from "child_process";

async function tmux(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tmux", args);
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

export function hasSession(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${name}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function hasPane(id: string): boolean {
  try {
    execSync(`tmux display-message -p -t ${id} '#{pane_id}'`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export async function killSession(name: string): Promise<void> {
  if (!hasSession(name)) return;
  await tmux("kill-session", "-t", name);
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
      );

    const [windowId, paneId] = result.stdout.trim().split(/\s+/, 2);
    if (!windowId || !paneId) {
      throw new Error(`tmuxctl: failed to parse tmux target ids: ${result.stdout}`);
    }

    try {
      await tmux("set-option", "-t", name, "status", "off");
    } catch {
      // non-fatal
    }

    await tmux(
      "resize-window",
      "-t",
      windowId,
      "-x",
      String(width),
      "-y",
      String(height),
    );

    return new Session(name, command, windowId, paneId);
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
