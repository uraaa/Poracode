import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { buildAgentCommand, resolveExecutablePathAsync } from "../agents/base";
import type { RepositoryCommand, RepositoryCommandResult } from "./protocol";

const execFileAsync = promisify(execFile);

/** Runs only on the command worker. Exported separately for command-shaping tests. */
export async function executeRepositoryCommand(
  request: RepositoryCommand,
  onChild?: (child: ChildProcess) => void,
): Promise<RepositoryCommandResult> {
  let { command, args } = request;
  let options = request.options;
  if (request.preparation) {
    const { location, shellEnv, direct, omitEnv } = request.preparation;
    const resolved =
      location.kind === "windows" ? await resolveExecutablePathAsync(command) : undefined;
    const spec = buildAgentCommand(location, command, args, resolved, shellEnv);
    // Machine-readable POSIX output must bypass login-shell banners. Windows
    // still uses the resolved executable/shim spec (and its refreshed PATH).
    if (!(direct && location.kind === "posix")) {
      command = spec.command;
      args = spec.args;
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
    for (const key of omitEnv ?? []) delete env[key];
    options = { ...options, cwd: spec.cwd ?? location.path, env: { ...env, ...options.env } };
  } else if (options.env) {
    options = { ...options, env: { ...process.env, ...options.env } };
  }
  if (request.input === undefined) {
    const pending = execFileAsync(command, args, options);
    if (pending.child) onChild?.(pending.child);
    return pending;
  }
  return execFileWithInput(command, args, options, request.input, onChild);
}

function execFileWithInput(
  command: string,
  args: string[],
  options: RepositoryCommand["options"],
  input: string,
  onChild?: (child: ChildProcess) => void,
): Promise<RepositoryCommandResult> {
  return new Promise((resolve, reject) => {
    let stdinError: Error | undefined;
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      const result = { stdout: String(stdout), stderr: String(stderr) };
      if (error) reject(Object.assign(error, result));
      else if (stdinError) reject(stdinError);
      else resolve(result);
    });
    onChild?.(child);
    if (!child.stdin) {
      child.kill();
      reject(new Error(`Unable to write stdin for ${command}.`));
      return;
    }
    // Early argv rejection can close stdin before the input was consumed.
    // Preserve the command's stderr instead of leaking an uncaught EPIPE.
    child.stdin.once("error", (error) => {
      stdinError = error;
    });
    child.stdin.end(input);
  });
}
