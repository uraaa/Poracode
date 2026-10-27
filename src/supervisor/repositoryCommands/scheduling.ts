import { AsyncLocalStorage } from "node:async_hooks";

export type RepositoryCommandPriority = "background" | "network" | "interactive";

const priorityContext = new AsyncLocalStorage<RepositoryCommandPriority>();
const backgroundCommands = new Map<string, Promise<unknown>>();
const networkCommands = new Map<string, Promise<unknown>>();
const pollingRequests = new Map<string, Promise<unknown>>();
const backgroundQueue: Array<() => void> = [];
const networkQueue: Array<() => void> = [];
const backgroundCommandLimit = 2;
let runningBackgroundCommands = 0;
let runningNetworkCommands = 0;
let repositoryReadEpoch = 0;
const activeMutations = new Set<Promise<unknown>>();

/** Global invalidation also covers linked worktrees sharing one Git directory. */
export function getRepositoryReadEpoch(): number {
  return repositoryReadEpoch;
}
export function invalidateRepositoryReads(): void {
  repositoryReadEpoch++;
}

export function repositoryMutation<T>(task: () => Promise<T>): Promise<T> {
  invalidateRepositoryReads();
  const result = (async () => {
    try {
      return await task();
    } finally {
      invalidateRepositoryReads();
    }
  })();
  activeMutations.add(result);
  const release = () => {
    activeMutations.delete(result);
  };
  void result.then(release, release);
  return result;
}

/** RPC admission must be closed before draining multi-command mutation scopes. */
export async function drainRepositoryMutations(): Promise<void> {
  while (activeMutations.size > 0) await Promise.allSettled([...activeMutations]);
}

export function getRepositoryCommandPriority(): RepositoryCommandPriority {
  return priorityContext.getStore() ?? "interactive";
}

function drainBackgroundCommands(): void {
  while (runningBackgroundCommands < backgroundCommandLimit && backgroundQueue.length > 0) {
    runningBackgroundCommands += 1;
    backgroundQueue.shift()!();
  }
}

function drainNetworkCommands(): void {
  if (runningNetworkCommands < 1 && networkQueue.length > 0) {
    runningNetworkCommands++;
    networkQueue.shift()!();
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
  const commands = priority === "network" ? networkCommands : backgroundCommands;
  const queue = priority === "network" ? networkQueue : backgroundQueue;
  const drain = priority === "network" ? drainNetworkCommands : drainBackgroundCommands;
  const epochKey = `${repositoryReadEpoch}:${key}`;
  const existing = commands.get(epochKey);
  if (existing) return existing as Promise<T>;

  const result = Promise.withResolvers<T>();
  commands.set(epochKey, result.promise);
  queue.push(() => {
    const release = () => {
      commands.delete(epochKey);
      if (priority === "network") runningNetworkCommands--;
      else runningBackgroundCommands--;
      drain();
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
  drain();
  return result.promise;
}

/**
 * Share an overlapping polling RPC and mark the commands it issues as background.
 * The RPC itself owns no command slot: snapshots can fan out into scheduled commands.
 * Entries exist only while pending, so the next refresh always reads fresh state.
 */
export function pollingRepositoryRequest<T>(
  key: string,
  task: () => Promise<T>,
  priority: "background" | "network" = "background",
): Promise<T> {
  const epochKey = `${repositoryReadEpoch}:${key}`;
  const existing = pollingRequests.get(epochKey);
  if (existing) return existing as Promise<T>;

  const result = Promise.withResolvers<T>();
  pollingRequests.set(epochKey, result.promise);
  const cleanup = () => {
    clearTimeout(timer);
    if (pollingRequests.get(epochKey) === result.promise) pollingRequests.delete(epochKey);
  };
  // A hung IPC must not hold the per-project refresh lock until the transport's
  // ten-minute backstop. Late completion cannot evict a replacement request.
  const timer = setTimeout(() => {
    cleanup();
    invalidateRepositoryReads();
    result.reject(new Error("Repository polling request timed out"));
  }, 30_000);
  timer.unref?.();
  void priorityContext
    .run(priority, () => Promise.resolve().then(task))
    .then(
      (value) => {
        cleanup();
        result.resolve(value);
      },
      (error: unknown) => {
        cleanup();
        result.reject(error);
      },
    );
  return result.promise;
}
