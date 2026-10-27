import { AsyncLocalStorage } from "node:async_hooks";

export type RepositoryCommandPriority = "background" | "interactive";

const priorityContext = new AsyncLocalStorage<RepositoryCommandPriority>();
const backgroundCommands = new Map<string, Promise<unknown>>();
const pollingRequests = new Map<string, Promise<unknown>>();
const backgroundQueue: Array<() => void> = [];
const backgroundCommandLimit = 2;
let runningBackgroundCommands = 0;

export function getRepositoryCommandPriority(): RepositoryCommandPriority {
  return priorityContext.getStore() ?? "interactive";
}

function drainBackgroundCommands(): void {
  while (runningBackgroundCommands < backgroundCommandLimit && backgroundQueue.length > 0) {
    runningBackgroundCommands += 1;
    backgroundQueue.shift()!();
  }
}

/** Bound background process creation while reserving an independent interactive lane. */
export function scheduleRepositoryCommand<T>(
  priority: RepositoryCommandPriority,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  if (priority === "interactive") {
    return priorityContext.run(priority, () => Promise.resolve().then(task));
  }
  const existing = backgroundCommands.get(key);
  if (existing) return existing as Promise<T>;

  const result = Promise.withResolvers<T>();
  backgroundCommands.set(key, result.promise);
  backgroundQueue.push(() => {
    const release = () => {
      backgroundCommands.delete(key);
      runningBackgroundCommands -= 1;
      drainBackgroundCommands();
    };
    void priorityContext
      .run(priority, () => Promise.resolve().then(task))
      .then(
        (value) => {
          release();
          result.resolve(value);
        },
        (error: unknown) => {
          release();
          result.reject(error);
        },
      );
  });
  drainBackgroundCommands();
  return result.promise;
}

/**
 * Share an overlapping polling RPC and mark the commands it issues as background.
 * The RPC itself owns no command slot: snapshots can fan out into scheduled commands.
 * Entries exist only while pending, so the next refresh always reads fresh state.
 */
export function pollingRepositoryRequest<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = pollingRequests.get(key);
  if (existing) return existing as Promise<T>;

  const result = Promise.withResolvers<T>();
  pollingRequests.set(key, result.promise);
  void priorityContext
    .run("background", () => Promise.resolve().then(task))
    .then(
      (value) => {
        pollingRequests.delete(key);
        result.resolve(value);
      },
      (error: unknown) => {
        pollingRequests.delete(key);
        result.reject(error);
      },
    );
  return result.promise;
}
