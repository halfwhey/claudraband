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

  private constructor(name: string, command: string[]) {
    this.name = name;
    this.command = command;
  }

  static async newSession(
    name: string,
    width: number,
    height: number,
    workingDir: string,
    command: string[],
  ): Promise<Session> {
    if (command.length === 0) {
      throw new Error("tmuxctl: command is required");
    }
    if (hasSession(name)) {
      await killSession(name);
    }

    const args = [
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      String(width),
      "-y",
      String(height),
    ];
    if (workingDir) {
      args.push("-c", workingDir);
    }
    args.push(...command);

    await tmux(...args);
    try {
      await tmux("set-option", "-t", name, "status", "off");
    } catch {
      // non-fatal
    }

    return new Session(name, command);
  }

  async kill(): Promise<void> {
    await killSession(this.name);
  }

  get isAlive(): boolean {
    return hasSession(this.name);
  }

  private target(): string {
    return `${this.name}:0.0`;
  }

  async resize(width: number, height: number): Promise<void> {
    await tmux(
      "resize-window",
      "-t",
      this.name,
      "-x",
      String(width),
      "-y",
      String(height),
    );
  }

  async sendKeys(input: string): Promise<void> {
    if (!input) return;
    await tmux("send-keys", "-t", this.target(), "-l", "--", input);
  }

  async sendLine(input: string): Promise<void> {
    if (input) {
      await this.sendKeys(input);
    }
    await this.sendSpecial("Enter");
  }

  async sendSpecial(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await tmux("send-keys", "-t", this.target(), ...keys);
  }

  async interrupt(): Promise<void> {
    await this.sendSpecial("C-c");
  }

  async capturePane(opts: CaptureOpts = {}): Promise<string> {
    const args = ["capture-pane", "-p", "-t", this.target()];
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
      this.target(),
      "#{pane_pid}",
    );
    return parseInt(result.stdout.trim(), 10);
  }
}
