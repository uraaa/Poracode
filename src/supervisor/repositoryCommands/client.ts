import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { getExecutablePathCacheGeneration } from "../agents/base/processRuntime";
import { getRepositoryCommandPriority, scheduleRepositoryCommand } from "./scheduling";
import {
  REPOSITORY_COMMAND_PROTOCOL_VERSION,
  type RepositoryCommand,
  type RepositoryCommandResult,
  type RepositoryWorkerReply,
  type RepositoryWorkerRequest,
} from "./protocol";

interface PendingCommand {
  resolve(result: RepositoryCommandResult): void;
  reject(error: Error): void;
}

/** One persistent spawn owner. Failed commands are never automatically replayed. */
export class RepositoryCommandClient {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, PendingCommand>();
  private nextId = 0;
  private disposed = false;
  private environmentGeneration = -1;
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly createWorker = () =>
      new Worker(join(__dirname, "repositoryCommandWorker.cjs")),
    private readonly options: { drainOnShutdown?: boolean } = {},
  ) {}

  run(command: RepositoryCommand): Promise<RepositoryCommandResult> {
    if (this.disposed) return Promise.reject(new Error("Repository command client is disposed"));
    return new Promise((resolve, reject) => {
      const worker = this.worker ?? this.startWorker();
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      worker.ref();
      try {
        const cacheGeneration = getExecutablePathCacheGeneration();
        const ambientEnv =
          this.environmentGeneration !== cacheGeneration ? { ...process.env } : undefined;
        worker.postMessage({
          version: REPOSITORY_COMMAND_PROTOCOL_VERSION,
          id,
          command,
          ...(ambientEnv ? { ambientEnv } : {}),
          cacheGeneration,
        } satisfies RepositoryWorkerRequest);
        this.environmentGeneration = cacheGeneration;
      } catch (error) {
        this.pending.delete(id);
        if (this.pending.size === 0) worker.unref();
        reject(error);
      }
    });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const worker = this.worker;
    if (!worker) return Promise.resolve();
    if (!this.options.drainOnShutdown)
      this.failWorker(worker, new Error("Repository command client is disposed"));
    this.disposal = new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
      worker.postMessage({
        version: REPOSITORY_COMMAND_PROTOCOL_VERSION,
        shutdown: true,
        drain: this.options.drainOnShutdown ?? false,
      } satisfies RepositoryWorkerRequest);
      worker.ref();
    });
    return this.disposal;
  }

  private startWorker(): Worker {
    const worker = this.createWorker();
    this.worker = worker;
    this.environmentGeneration = -1;
    worker.on("message", (reply: RepositoryWorkerReply) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (this.pending.size === 0) worker.unref();
      if ("error" in reply) {
        pending.reject(Object.assign(new Error(reply.error.message), reply.error));
      } else pending.resolve(reply.result);
    });
    worker.on("error", (error) =>
      this.failWorker(worker, error instanceof Error ? error : new Error(String(error))),
    );
    worker.on("exit", (code) =>
      this.failWorker(worker, new Error(`Repository command worker exited (${code})`)),
    );
    worker.unref();
    return worker;
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

// A separate interactive lane reserves a spawn owner for mutations and
// agent-critical repository work even while the polling worker is in CreateProcess.
const backgroundCommands = new RepositoryCommandClient();
// Fetch updates remote refs, so it receives the same graceful exit as mutations.
const networkCommands = new RepositoryCommandClient(undefined, { drainOnShutdown: true });
const interactiveCommands = new RepositoryCommandClient(undefined, { drainOnShutdown: true });

export function runRepositoryCommand(command: RepositoryCommand): Promise<RepositoryCommandResult> {
  const priority = getRepositoryCommandPriority();
  // Interactive commands may carry multi-megabyte patch input. They are never
  // deduplicated, so serializing them on the supervisor has no purpose.
  const key = priority === "interactive" ? "" : JSON.stringify(command);
  return scheduleRepositoryCommand(priority, key, () =>
    (priority === "background"
      ? backgroundCommands
      : priority === "network"
        ? networkCommands
        : interactiveCommands
    ).run(command),
  );
}

export async function disposeRepositoryCommands(): Promise<void> {
  await Promise.all([
    backgroundCommands.dispose(),
    networkCommands.dispose(),
    interactiveCommands.dispose(),
  ]);
}
