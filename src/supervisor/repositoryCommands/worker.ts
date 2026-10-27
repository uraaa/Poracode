import type { ChildProcess } from "node:child_process";
import { parentPort } from "node:worker_threads";
import { invalidateExecutablePathCache } from "../agents/base/processRuntime";
import { executeRepositoryCommand } from "./execute";
import {
  REPOSITORY_COMMAND_PROTOCOL_VERSION,
  type RepositoryCommandError,
  type RepositoryWorkerReply,
  type RepositoryWorkerRequest,
} from "./protocol";

if (!parentPort) throw new Error("Repository command worker requires a parent port");
const port = parentPort;
const children = new Set<ChildProcess>();
let cacheGeneration = -1;
let shuttingDown = false;
let drainOnShutdown = false;
let activeCommands = 0;

function trackChild(child: ChildProcess): void {
  children.add(child);
  child.once("close", () => children.delete(child));
  if (shuttingDown && !drainOnShutdown) child.kill();
}

function serializeError(error: unknown): RepositoryCommandError {
  const value = error instanceof Error ? error : new Error(String(error));
  // Structured cloning Error drops execFile's custom properties, including the
  // stdout/exit code used by git's acceptedExitCodes handling.
  const result: RepositoryCommandError = { message: value.message, name: value.name };
  if (value.stack) result.stack = value.stack;
  for (const key of ["code", "signal", "killed", "stdout", "stderr"] as const) {
    if (key in value) Object.assign(result, { [key]: value[key as keyof typeof value] });
  }
  return result;
}

port.on("message", (request: RepositoryWorkerRequest) => {
  if (request.version !== REPOSITORY_COMMAND_PROTOCOL_VERSION) {
    throw new Error("Incompatible repository command worker protocol");
  }
  if ("shutdown" in request) {
    shuttingDown = true;
    drainOnShutdown = request.drain;
    if (!drainOnShutdown) for (const child of children) child.kill();
    if (!drainOnShutdown || activeCommands === 0) port.close();
    return;
  }
  if (shuttingDown) return;
  // Workers get an isolated environment snapshot at creation. Refresh it so an
  // explicit PATH/install refresh also reaches registry fallback and lookups.
  if (request.ambientEnv) {
    for (const key of Object.keys(process.env)) {
      if (!(key in request.ambientEnv)) delete process.env[key];
    }
    Object.assign(process.env, request.ambientEnv);
  }
  if (cacheGeneration !== request.cacheGeneration) {
    invalidateExecutablePathCache();
    cacheGeneration = request.cacheGeneration;
  }
  activeCommands += 1;
  void executeRepositoryCommand(request.command, trackChild)
    .then(
      (result) => {
        if (!shuttingDown || drainOnShutdown)
          port.postMessage({ id: request.id, result } satisfies RepositoryWorkerReply);
      },
      (error: unknown) => {
        if (!shuttingDown || drainOnShutdown)
          port.postMessage({
            id: request.id,
            error: serializeError(error),
          } satisfies RepositoryWorkerReply);
      },
    )
    .finally(() => {
      activeCommands -= 1;
      if (shuttingDown && activeCommands === 0) port.close();
    });
});
