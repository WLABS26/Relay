import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Sandboxed execution of media binaries.
 *
 *  - argv arrays only: no shell, no interpolation;
 *  - a minimal environment (PATH only) so credentials never reach the child;
 *  - stdin closed; stdout/stderr capped;
 *  - its own process group, killed as a group on timeout or abort;
 *  - optional prlimit caps on address space, CPU time and output file size.
 */

export interface RunLimits {
  timeoutMs: number;
  /** Address-space cap for the child (prlimit --as). */
  memoryLimitMb?: number;
  /** Maximum size of any file the child writes (prlimit --fsize). */
  maxFileBytes?: number;
  cpuSeconds?: number;
  usePrlimit?: boolean;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

const PRLIMIT_PATHS = ['/usr/bin/prlimit', '/bin/prlimit'];
let prlimitPath: string | null | undefined;

function findPrlimit(): string | null {
  if (prlimitPath === undefined) prlimitPath = PRLIMIT_PATHS.find((p) => existsSync(p)) ?? null;
  return prlimitPath;
}

/** Whether prlimit (util-linux) is available for memory/CPU caps on media tools. */
export function prlimitAvailable(): boolean {
  return findPrlimit() !== null;
}

export async function runTool(
  command: string,
  args: readonly string[],
  limits: RunLimits,
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<RunResult> {
  let file = command;
  let argv = [...args];
  const prlimit = limits.usePrlimit === false ? null : findPrlimit();
  if (prlimit) {
    const caps: string[] = [];
    if (limits.memoryLimitMb) caps.push(`--as=${limits.memoryLimitMb * 1024 * 1024}`);
    if (limits.maxFileBytes) caps.push(`--fsize=${limits.maxFileBytes}`);
    if (limits.cpuSeconds) caps.push(`--cpu=${limits.cpuSeconds}`);
    if (caps.length > 0) {
      argv = [...caps, '--', command, ...args];
      file = prlimit;
    }
  }

  const maxOut = limits.maxStdoutBytes ?? 4 * 1024 * 1024;
  const maxErr = limits.maxStderrBytes ?? 64 * 1024;
  const started = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(file, argv, {
      cwd: options.cwd,
      // Minimal environment: no credentials or config reach the media binary.
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        LC_ALL: 'C',
      } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so the whole tree can be killed
      shell: false,
      windowsHide: true,
    });

    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    let timedOut = false;
    let settled = false;

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already exited
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, limits.timeoutMs);
    const onAbort = () => killGroup();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (outLen + chunk.length > maxOut) {
        killGroup();
        return;
      }
      out.push(chunk);
      outLen += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < maxErr) err += chunk.toString('utf8').slice(0, maxErr - err.length);
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr: err,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

export async function runToolOrThrow(
  command: string,
  args: readonly string[],
  limits: RunLimits,
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const result = await runTool(command, args, limits, options);
  if (result.timedOut)
    throw new ToolError(`${command} timed out after ${limits.timeoutMs} ms`, result);
  if (result.code !== 0) {
    throw new ToolError(
      `${command} exited with ${result.code ?? result.signal}: ${result.stderr.trim().slice(0, 300)}`,
      result,
    );
  }
  return result;
}
