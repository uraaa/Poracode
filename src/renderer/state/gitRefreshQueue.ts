import type { ProjectLocation } from "@/shared/contracts";

export type GitRefreshReason = "initial" | "watcher" | "fetch" | "manual" | "poll";
export type GitRefreshMode = "status" | "full";

export interface GitRefreshOptions {
  /** Returns false to short-circuit after async awaits (lets callers cancel on unmount). */
  isActive?: () => boolean;
  /** If true, runs `git fetch origin` before an explicit snapshot refresh. */
  fetchRemote?: boolean;
}

export interface GitRefreshRequest {
  project: { id: string; location: ProjectLocation };
  reason: GitRefreshReason;
  mode: GitRefreshMode;
  options: GitRefreshOptions;
}

interface RefreshEntry {
  pending: Map<string, GitRefreshRequest>;
  completion: Promise<void>;
  lastWatcherAt: number;
  wake?: () => void;
}

const reasonPriority: Record<GitRefreshReason, number> = {
  manual: 5,
  initial: 4,
  watcher: 3,
  poll: 2,
  fetch: 1,
};
const WATCHER_QUIET_MS = 250;
const WATCHER_MIN_INTERVAL_MS = 2_000;
const CYCLE_TIMEOUT_MS = 30_000;
const isActive = (request: GitRefreshRequest) => request.options.isActive?.() ?? true;

/** Coalesces project work, bounds hung generations, and waits for watcher quiet. */
export class GitRefreshQueue {
  private readonly entries = new Map<string, RefreshEntry>();
  private readonly lastStartedAt = new Map<string, number>();

  constructor(private readonly run: (request: GitRefreshRequest) => Promise<void>) {}

  enqueue(request: GitRefreshRequest): Promise<void> {
    if (!isActive(request)) return Promise.resolve();
    const existing = this.entries.get(request.project.id);
    if (existing) {
      this.addPending(existing, request);
      existing.wake?.();
      return existing.completion;
    }
    const completion = Promise.withResolvers<void>();
    const entry: RefreshEntry = {
      pending: new Map(),
      completion: completion.promise,
      lastWatcherAt: 0,
    };
    this.addPending(entry, request);
    this.entries.set(request.project.id, entry);
    void this.drain(entry, request.project.id).then(completion.resolve, completion.reject);
    return entry.completion;
  }

  clearInactive(activeProjectIds: ReadonlySet<string>): void {
    for (const [projectId, entry] of this.entries) {
      if (!activeProjectIds.has(projectId)) {
        entry.pending.clear();
        entry.wake?.();
      }
    }
    for (const projectId of this.lastStartedAt.keys()) {
      if (!activeProjectIds.has(projectId)) this.lastStartedAt.delete(projectId);
    }
  }

  private addPending(entry: RefreshEntry, request: GitRefreshRequest): void {
    const key = `${request.reason}:${request.mode}:${!!request.options.fetchRemote}`;
    const previous = entry.pending.get(key);
    if (!previous || previous.options.isActive) entry.pending.set(key, request);
    if (request.reason === "watcher") entry.lastWatcherAt = Date.now();
  }

  private async runGeneration(request: GitRefreshRequest): Promise<void> {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        active = false;
        resolve();
      }, CYCLE_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        this.run({
          ...request,
          options: { ...request.options, isActive: () => active && isActive(request) },
        }),
        timeout,
      ]);
    } finally {
      active = false;
      clearTimeout(timer);
    }
  }

  private async drain(entry: RefreshEntry, projectId: string): Promise<void> {
    let failed = false;
    let failure: unknown;
    try {
      while (true) {
        const requests = [...entry.pending.values()].filter(isActive);
        const strongest = requests.sort(
          (left, right) => reasonPriority[right.reason] - reasonPriority[left.reason],
        )[0];
        if (!strongest) break;
        if (strongest.reason === "watcher") {
          const delay =
            Math.max(
              entry.lastWatcherAt + WATCHER_QUIET_MS,
              (this.lastStartedAt.get(projectId) ?? -Infinity) + WATCHER_MIN_INTERVAL_MS,
            ) - Date.now();
          if (delay > 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delay);
              entry.wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            delete entry.wake;
            continue;
          }
        }
        entry.pending.clear();
        this.lastStartedAt.set(projectId, Date.now());
        try {
          await this.runGeneration({
            ...strongest,
            mode: requests.some((request) => request.mode === "full") ? "full" : "status",
            options: {
              isActive: () => requests.some(isActive),
              fetchRemote: requests.some((request) => request.options.fetchRemote),
            },
          });
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    } finally {
      if (this.entries.get(projectId) === entry) this.entries.delete(projectId);
    }
    if (failed) throw failure;
  }
}
