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

function trackChild(child: ChildProcess): void {
  children.add(child);
  child.once("close", () => children.delete(child));
  if (shuttingDown) child.kill();
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
    for (const child of children) child.kill();
    port.close();
    return;
  }
  if (shuttingDown) return;
  // Workers get an isolated environment snapshot at creation. Refresh it so an
  // explicit PATH/install refresh also reaches registry fallback and lookups.
  for (const key of Object.keys(process.env)) {
    if (!(key in request.ambientEnv)) delete process.env[key];
  }
  Object.assign(process.env, request.ambientEnv);
  if (cacheGeneration !== request.cacheGeneration) {
    invalidateExecutablePathCache();
    cacheGeneration = request.cacheGeneration;
  }
  void executeRepositoryCommand(request.command, trackChild).then(
    (result) => port.postMessage({ id: request.id, result } satisfies RepositoryWorkerReply),
    (error: unknown) =>
      port.postMessage({
        id: request.id,
        error: serializeError(error),
      } satisfies RepositoryWorkerReply),
  );
});
