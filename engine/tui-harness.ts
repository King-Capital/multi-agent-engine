export interface TmuxTuiSession {
  name: string;
  capture(): Promise<string>;
  sendKeys(...keys: string[]): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  stop(): Promise<void>;
}

interface TmuxCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runTmux(args: string[], opts?: { allowFailure?: boolean }): Promise<TmuxCommandResult> {
  const quoted = ["tmux", ...args].map(shQuote).join(" ");
  const proc = Bun.spawn(["/bin/bash", "-lc", quoted], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0 && !opts?.allowFailure) {
    throw new Error(`tmux ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return { code, stdout, stderr };
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function tmuxAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["/usr/bin/env", "bash", "-lc", "command -v tmux"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited === 0;
}

export async function startTuiSession(
  command: string,
  opts?: { name?: string; width?: number; height?: number; waitMs?: number; cwd?: string },
): Promise<TmuxTuiSession> {
  if (!(await tmuxAvailable())) throw new Error("tmux is not available on PATH");

  const name = opts?.name ?? `mae-tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const width = String(opts?.width ?? 100);
  const height = String(opts?.height ?? 30);
  const cwd = opts?.cwd ?? process.cwd();

  await runTmux(["new-session", "-d", "-s", name, "-c", cwd, "-x", width, "-y", height, command]);
  if (opts?.waitMs) await Bun.sleep(opts.waitMs);

  return {
    name,
    async capture() {
      const result = await runTmux(["capture-pane", "-pt", name, "-S", "-2000"], { allowFailure: true });
      return result.stdout;
    },
    async sendKeys(...keys: string[]) {
      await runTmux(["send-keys", "-t", name, ...keys]);
    },
    async type(text: string) {
      await runTmux(["send-keys", "-t", name, "-l", text]);
    },
    async key(key: string) {
      await runTmux(["send-keys", "-t", name, key]);
    },
    async stop() {
      await runTmux(["kill-session", "-t", name], { allowFailure: true });
    },
  };
}
