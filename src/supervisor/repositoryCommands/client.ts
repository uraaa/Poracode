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

  constructor(
    private readonly createWorker = () =>
      new Worker(join(__dirname, "repositoryCommandWorker.cjs")),
  ) {}

  run(command: RepositoryCommand): Promise<RepositoryCommandResult> {
    if (this.disposed) return Promise.reject(new Error("Repository command client is disposed"));
    return new Promise((resolve, reject) => {
      const worker = this.worker ?? this.startWorker();
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      worker.ref();
      try {
        worker.postMessage({
          version: REPOSITORY_COMMAND_PROTOCOL_VERSION,
          id,
          command,
          ambientEnv: { ...process.env },
          cacheGeneration: getExecutablePathCacheGeneration(),
        } satisfies RepositoryWorkerRequest);
      } catch (error) {
        this.pending.delete(id);
        if (this.pending.size === 0) worker.unref();
        reject(error);
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    if (!worker) return;
    this.failWorker(worker, new Error("Repository command client is disposed"));
    await new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
      worker.postMessage({
        version: REPOSITORY_COMMAND_PROTOCOL_VERSION,
        shutdown: true,
      } satisfies RepositoryWorkerRequest);
      worker.ref();
    });
  }

  private startWorker(): Worker {
    const worker = this.createWorker();
    this.worker = worker;
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
const interactiveCommands = new RepositoryCommandClient();

export function runRepositoryCommand(command: RepositoryCommand): Promise<RepositoryCommandResult> {
  const priority = getRepositoryCommandPriority();
  return scheduleRepositoryCommand(priority, JSON.stringify(command), () =>
    (priority === "background" ? backgroundCommands : interactiveCommands).run(command),
  );
}

export async function disposeRepositoryCommands(): Promise<void> {
  await Promise.all([backgroundCommands.dispose(), interactiveCommands.dispose()]);
}
