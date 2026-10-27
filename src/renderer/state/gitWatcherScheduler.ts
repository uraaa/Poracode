interface PendingRefresh {
  paths: Set<string>;
  all: boolean;
  first: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Background invalidations only. User reads never enter this scheduler. */
export class GitWatcherScheduler {
  private readonly pending = new Map<string, PendingRefresh>();
  private readonly lastStarted = new Map<string, number>();
  private readonly running = new Set<string>();
  private disposed = false;

  constructor(
    private readonly refresh: (
      projectId: string,
      paths: string[],
      wholeProject: boolean,
    ) => Promise<void>,
  ) {}

  schedule(projectId: string, worktreePath?: string): void {
    if (this.disposed) return;
    const entry = this.pending.get(projectId) ?? {
      paths: new Set<string>(),
      all: false,
      first: Date.now(),
      timer: undefined,
    };
    if (worktreePath) entry.paths.add(worktreePath);
    else entry.all = true;
    this.pending.set(projectId, entry);
    this.arm(projectId, entry);
  }

  private arm(projectId: string, entry: PendingRefresh): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (this.running.has(projectId)) return;
    const now = Date.now();
    const due = Math.max(
      Math.min(now + 500, entry.first + 30_000),
      (this.lastStarted.get(projectId) ?? -Infinity) + 30_000,
    );
    entry.timer = setTimeout(
      () => {
        this.pending.delete(projectId);
        this.lastStarted.set(projectId, Date.now());
        this.running.add(projectId);
        void this.refresh(projectId, [...entry.paths].sort(), entry.all)
          .catch((error) => console.warn("[git-refresh] watcher refresh failed", error))
          .finally(() => {
            this.running.delete(projectId);
            const next = this.pending.get(projectId);
            if (next && !this.disposed) this.arm(projectId, next);
          });
      },
      Math.max(0, due - now),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) if (entry.timer) clearTimeout(entry.timer);
    this.pending.clear();
  }
}
