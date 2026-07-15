import { spawn, execSync, ChildProcess } from "child_process";
import { Logger } from "./logger.js";
import { CLI, ENV } from "../constants.js";

const activeChildProcesses = new Set<ChildProcess>();

function waitForClose(childProcess: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      childProcess.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    timeout.unref();

    const onClose = () => {
      clearTimeout(timeout);
      resolve(true);
    };

    childProcess.once("close", onClose);
  });
}

function signalChildProcess(childProcess: ChildProcess, signal: NodeJS.Signals): void {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;

  try {
    if (process.platform !== "win32" && childProcess.pid) {
      process.kill(-childProcess.pid, signal);
    } else {
      childProcess.kill(signal);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      Logger.error(`Failed to signal child process: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function getActiveCommandCount(): number {
  return activeChildProcesses.size;
}

export async function terminateActiveCommands(graceMs: number = 2000): Promise<void> {
  const childProcesses = Array.from(activeChildProcesses);
  if (childProcesses.length === 0) return;

  Logger.warn(`Terminating ${childProcesses.length} active command process(es)`);

  for (const childProcess of childProcesses) {
    signalChildProcess(childProcess, "SIGTERM");
  }

  const settled = await Promise.all(childProcesses.map((childProcess) => waitForClose(childProcess, graceMs)));
  const remaining = childProcesses.filter((_childProcess, index) => !settled[index]);

  for (const childProcess of remaining) {
    signalChildProcess(childProcess, "SIGKILL");
  }

  if (remaining.length > 0) {
    await Promise.all(remaining.map((childProcess) => waitForClose(childProcess, graceMs)));
  }
}

// Quote a single argument for cmd.exe (used by spawn's shell:true on Windows).
// Embedded quotes are doubled and backslash runs before a quote (or the closing
// quote) are doubled so they don't escape it, per CommandLineToArgvW rules. Note
// cmd still expands %VAR%/!VAR! inside quotes — an env read at worst, not RCE.
export function quoteForCmd(arg: string): string {
  const body = String(arg).replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1');
  return `"${body}"`;
}

export function selectWindowsCodexCandidate(candidates: string[], command: string = CLI.COMMANDS.CODEX): string {
  const byExt = (ext: string) => candidates.find((c) => c.toLowerCase().endsWith(ext));
  return byExt(".cmd") || byExt(".exe") || byExt(".bat") || `${command}.cmd`;
}

// Windows-only: find the real executable for the codex command. The MCP server
// often runs without the user's interactive PATH, so we (1) honour an explicit
// CODEX_CLI_PATH override, then (2) ask `where` and prefer shims that cmd.exe
// can actually launch. PowerShell shims and extensionless shell scripts are not
// selected as fallbacks. Resolution is cached per command for the life of the process.
const resolveCache = new Map<string, string>();
export function resolveCommandForExecution(command: string): string {
  if (process.platform !== "win32" || command !== CLI.COMMANDS.CODEX) return command;

  const cached = resolveCache.get(command);
  if (cached) return cached;

  let resolved: string = command;
  const override = process.env[ENV.CODEX_CLI_PATH]?.trim();
  if (override) {
    resolved = override;
  } else {
    try {
      const out = execSync(`where ${command}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      resolved = selectWindowsCodexCandidate(candidates, command);
    } catch {
      resolved = `${command}.cmd`;
    }
  }

  resolveCache.set(command, resolved);
  return resolved;
}

// Actionable guidance when the executable can't be found (ENOENT). The most
// common cause is the MCP server not inheriting the user's interactive PATH.
export function buildEnoentErrorMessage(command: string): string {
  const isWindows = process.platform === "win32";
  const lines = [
    `Could not find the "${command}" executable.`,
    `The MCP server runs in its own process and may not inherit your shell's PATH.`,
    `• Verify it is installed and resolvable: \`${isWindows ? "where" : "which"} ${command}\`.`,
  ];
  if (command === CLI.COMMANDS.CODEX) {
    lines.push(
      `• Install it: \`npm install -g @openai/codex\` (or see https://developers.openai.com/codex).`,
      isWindows
        ? `• Or set ${ENV.CODEX_CLI_PATH} to the full path of the codex shim (e.g. C:\\path\\to\\codex.cmd).`
        : `• Or set ${ENV.CODEX_CLI_PATH} to the full path of the codex executable.`,
    );
  }
  return lines.join("\n");
}

/**
 * Thrown when a spawned command exits non-zero. Carries the captured stdout,
 * stderr and exit code so codex-aware callers can parse codex's JSON event
 * stream (written to stdout) for the real failure reason, instead of the
 * generic, stderr-derived message — codex prints a benign "Reading additional
 * input from stdin..." banner to stderr that would otherwise mask the actual
 * error (e.g. a `turn.failed` "high demand" event on stdout).
 */
export class CommandError extends Error {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  constructor(message: string, exitCode: number | null, stdout: string, stderr: string) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export async function executeCommand(
  command: string,
  args: string[],
  onProgress?: (newOutput: string) => void,
  stdinData?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    Logger.commandExecution(command, args, startTime);

    const isWindows = process.platform === "win32";
    const resolvedCommand = resolveCommandForExecution(command);

    // Windows quirk: Node 22+ blocks spawning `.cmd` / `.bat` shims without
    // `shell: true` (CVE-2024-27980). But shell:true routes the command through
    // cmd.exe, which re-parses the joined line — so EVERY argument must be
    // quoted, not just those with whitespace. cmd metacharacters (& | < > ^ ( ))
    // trigger command injection even in tokens without spaces (e.g. a prompt
    // `a&calc`); wrapping each arg in double quotes makes them inert. This is a
    // no-op on macOS / Linux, where shell:false passes argv directly.
    const safeArgs = isWindows ? args.map(quoteForCmd) : args;
    // A resolved full path may contain spaces; quote it for cmd.exe. A bare
    // command name (no whitespace) passes through unchanged to preserve the
    // exact, already-tested shim-launch behaviour.
    const spawnCommand =
      isWindows && /\s/.test(resolvedCommand) ? `"${resolvedCommand}"` : resolvedCommand;

    // The Codex prompt is passed as an argv argument (never stdin) so that codex
    // does not print "Reading additional input from stdin..." and append an empty
    // <stdin> block. stdin is therefore "ignore" unless a caller explicitly pipes
    // data. windowsHide suppresses the popup console window on Windows.
    const childProcess = spawn(spawnCommand, safeArgs, {
      env: process.env,
      detached: !isWindows,
      shell: isWindows,
      windowsHide: true,
      stdio: [stdinData !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    activeChildProcesses.add(childProcess);

    if (stdinData !== undefined && childProcess.stdin) {
      // If the child has already exited/closed its stdin, write() emits EPIPE on
      // the stream; without this listener that becomes an uncaught exception and
      // crashes the (long-lived) MCP server.
      childProcess.stdin.on("error", (err) => {
        Logger.error(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      childProcess.stdin.write(stdinData);
      childProcess.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let isResolved = false;
    let lastReportedLength = 0;

    childProcess.stdout?.on("data", (data) => {
      stdout += data.toString();

      // Report new content if callback provided
      if (onProgress && stdout.length > lastReportedLength) {
        const newContent = stdout.substring(lastReportedLength);
        lastReportedLength = stdout.length;
        onProgress(newContent);
      }
    });

    childProcess.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    childProcess.on("error", (error) => {
      activeChildProcesses.delete(childProcess);
      if (isResolved) return;
      isResolved = true;
      Logger.error(`Process error:`, error);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(new Error(buildEnoentErrorMessage(command)));
      } else {
        reject(new Error(`Failed to spawn command: ${error.message}`));
      }
    });
    childProcess.on("close", (code) => {
      activeChildProcesses.delete(childProcess);
      if (isResolved) return;
      isResolved = true;
      if (code === 0) {
        Logger.commandComplete(startTime, code, stdout.length);
        resolve(stdout.trim());
      } else {
        Logger.commandComplete(startTime, code);
        Logger.error(`Failed with exit code ${code}`);
        // Codex writes its JSON events to stdout; on failure the useful detail is
        // often there (or merged into stderr). Keep the stderr-first message for
        // generic callers, but attach the raw streams (CommandError) so codex-aware
        // callers can recover the real reason from the stdout event stream.
        const errorMessage = stderr.trim() || stdout.trim() || "Unknown error";
        reject(
          new CommandError(`Command failed with exit code ${code}: ${errorMessage}`, code, stdout, stderr),
        );
      }
    });
  });
}
