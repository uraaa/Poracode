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
  private readonly coveredProjects = new Set<string>();
  private disposed = false;

  constructor(
    private readonly refresh: (
      projectId: string,
      paths: string[],
      wholeProject: boolean,
    ) => Promise<void>,
    private readonly minimumIntervalMs = 30_000,
  ) {}

  schedule(projectId: string, worktreePath?: string): void {
    if (this.disposed) return;
    if (!worktreePath && this.coveredProjects.has(projectId)) return;
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

  /** Drain fetch notifications before the covering reads; preserve events during those reads. */
  async coverProjectRefresh(
    projectId: string,
    update: () => Promise<void>,
    refresh: () => Promise<void>,
  ): Promise<void> {
    this.coveredProjects.add(projectId);
    this.lastStarted.set(projectId, Date.now());
    const pending = this.pending.get(projectId);
    if (pending) {
      pending.all = false;
      if (pending.paths.size === 0) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(projectId);
      } else this.arm(projectId, pending);
    }
    try {
      await update();
      // Native/WSL watchers debounce for 300 ms. The later snapshot sees all absorbed changes.
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    } finally {
      this.coveredProjects.delete(projectId);
      if (!this.disposed) {
        this.lastStarted.set(projectId, Date.now());
        const next = this.pending.get(projectId);
        if (next) this.arm(projectId, next);
      }
    }
    await refresh();
  }

  private arm(projectId: string, entry: PendingRefresh): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (this.running.has(projectId)) return;
    const now = Date.now();
    const due = Math.max(
      Math.min(now + 500, entry.first + this.minimumIntervalMs),
      (this.lastStarted.get(projectId) ?? -Infinity) + this.minimumIntervalMs,
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
    this.coveredProjects.clear();
  }
}
