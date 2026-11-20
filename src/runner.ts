import { spawn } from "child_process";

export interface RunResult {
  /** Null when the process was killed or never started. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set when the run was cancelled because a newer one superseded it. */
  cancelled: boolean;
  /** Set when the process could not be started at all. */
  spawnError?: Error;
  timedOut: boolean;
}

export interface Run {
  readonly result: Promise<RunResult>;
  cancel(): void;
}

export type Logger = (line: string) => void;

/**
 * Run kv-cli without a shell. Colour is turned off through the environment
 * rather than a flag, so the same call works on every supported release.
 */
export function runKvCli(
  command: string,
  args: string[],
  cwd: string,
  log: Logger,
  timeoutMs = 60_000,
): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.CLICOLOR_FORCE;
  delete env.FORCE_COLOR;

  const started = Date.now();
  log(`$ ${[command, ...args].map(quote).join(" ")}    (in ${cwd})`);

  let cancelled = false;
  let timedOut = false;
  let kill: () => void = () => {};

  const result = new Promise<RunResult>((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    } catch (err) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: "", cancelled, timedOut, spawnError: err as Error });
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => errOut.push(d));
    kill = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    let spawnError: Error | undefined;
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const r: RunResult = {
        exitCode: code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errOut).toString("utf8"),
        cancelled,
        timedOut,
        spawnError,
      };
      log(
        cancelled
          ? `  cancelled (superseded) after ${Date.now() - started} ms`
          : `  exit ${code ?? signal ?? spawnError?.message} in ${Date.now() - started} ms`,
      );
      resolve(r);
    });
  });

  return {
    result,
    cancel() {
      cancelled = true;
      kill();
    },
  };
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Strip ANSI escapes, in case a user's environment forces colour anyway. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
