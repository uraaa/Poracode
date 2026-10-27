import type { ProjectLocation } from "@/shared/contracts";

export type GitRefreshReason = "initial" | "watcher" | "fetch" | "manual" | "poll";
export type GitRefreshMode = "status" | "full";

export interface GitRefreshOptions {
  /** Returns false to short-circuit after async awaits (lets callers cancel on unmount). */
  isActive?: () => boolean;
  /** If true, runs `git fetch origin` before the snapshot refresh. */
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
}

const reasonPriority: Record<GitRefreshReason, number> = {
  manual: 5,
  initial: 4,
  watcher: 3,
  poll: 2,
  fetch: 1,
};

const isActive = (request: GitRefreshRequest) => request.options.isActive?.() ?? true;

/** One real cycle and one coalesced follow-up per project, regardless of caller timeouts. */
export class GitRefreshQueue {
  private readonly entries = new Map<string, RefreshEntry>();

  constructor(private readonly run: (request: GitRefreshRequest) => Promise<void>) {}

  enqueue(request: GitRefreshRequest): Promise<void> {
    if (!isActive(request)) return Promise.resolve();
    const existing = this.entries.get(request.project.id);
    if (existing) {
      // Keep one caller per kind of request: repeated polls and watcher events
      // cannot grow a backlog or discard a manual/full/fetch upgrade.
      const key = `${request.reason}:${request.mode}:${!!request.options.fetchRemote}`;
      const previous = existing.pending.get(key);
      // An unmountable UI caller must not cancel an explicit, independent request.
      if (!previous || previous.options.isActive) existing.pending.set(key, request);
      return existing.completion;
    }
    const completion = Promise.withResolvers<void>();
    const entry: RefreshEntry = { pending: new Map(), completion: completion.promise };
    this.entries.set(request.project.id, entry);
    void this.drain(entry, request).then(completion.resolve, completion.reject);
    return entry.completion;
  }

  clearInactive(activeProjectIds: ReadonlySet<string>): void {
    for (const [projectId, entry] of this.entries) {
      // Unmounting cancels queued work, but cannot release a lock held by real IPC work.
      if (!activeProjectIds.has(projectId)) entry.pending.clear();
    }
  }

  private async drain(entry: RefreshEntry, first: GitRefreshRequest): Promise<void> {
    let current: GitRefreshRequest | undefined = first;
    let failed = false;
    let failure: unknown;
    try {
      while (current) {
        try {
          if (isActive(current)) await this.run(current);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
        const requests = [...entry.pending.values()].filter(isActive);
        entry.pending.clear();
        const strongest = requests.sort(
          (left, right) => reasonPriority[right.reason] - reasonPriority[left.reason],
        )[0];
        current = strongest && {
          ...strongest,
          mode: requests.some((request) => request.mode === "full") ? "full" : "status",
          options: {
            isActive: () => requests.some(isActive),
            fetchRemote: requests.some((request) => request.options.fetchRemote),
          },
        };
      }
    } finally {
      this.entries.delete(first.project.id);
    }
    if (failed) throw failure;
  }
}
