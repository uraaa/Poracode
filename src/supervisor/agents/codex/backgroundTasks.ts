import type { BackgroundTask, RuntimeEvent } from "@/shared/contracts";

type Terminal = { itemId: string; processId: string; command: string };
type ReadTerminals = (
  threadId: string,
  cursor?: string,
) => Promise<{
  data: readonly Terminal[];
  nextCursor: string | null;
}>;

/** Normalizes the provider's live process inventory and interruptible waits. */
export class CodexBackgroundTasks {
  private threadId: string | undefined;
  private generation = 0;
  private revision = 0;
  private disposed = false;
  private supported = true;
  private terminals: readonly Terminal[] = [];
  private waits = new Map<string, BackgroundTask>();
  private pending: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastKey = "[]";

  constructor(
    private readonly localThreadId: string,
    private readonly read: ReadTerminals,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {}

  setThread(threadId: string): void {
    if (this.threadId === threadId) return;
    this.generation++;
    this.threadId = threadId;
    this.pending = undefined;
    this.terminals = [];
    this.waits.clear();
    this.stopTimer();
    this.publish();
  }

  getTasks(): readonly BackgroundTask[] {
    return [
      ...this.terminals.map((terminal): BackgroundTask => ({
        taskId: `codex:process:${terminal.processId}`,
        kind: "command",
        description: terminal.command,
      })),
      ...this.waits.values(),
    ];
  }

  observe(method: string, params: Record<string, unknown> | undefined): void {
    if (this.disposed) return;
    const item = params?.item as Record<string, unknown> | undefined;
    if (item?.type === "sleep" && typeof item.id === "string") {
      if (method === "item/started") {
        const duration = typeof item.durationMs === "number" ? item.durationMs : 0;
        this.waits.set(item.id, {
          taskId: `codex:sleep:${item.id}`,
          kind: "other",
          description: `clock.sleep (${duration} ms)`,
        });
      } else if (method === "item/completed") {
        this.waits.delete(item.id);
      }
      this.publish();
      return;
    }
    if (method === "item/completed" && item?.type === "commandExecution") {
      // A snapshot requested before this bookend must not restore an exited process.
      this.revision++;
      this.terminals = this.terminals.filter((terminal) => terminal.itemId !== item.id);
      this.publish();
      void this.refresh();
    }
    if (method === "turn/completed" || method === "turn/aborted") {
      this.waits.clear();
      this.publish();
      void this.refresh();
    }
    if (method === "item/commandExecution/terminalInteraction") void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.disposed || !this.threadId || !this.supported) return Promise.resolve();
    if (this.pending) return this.pending;
    this.stopTimer();
    const threadId = this.threadId;
    const generation = this.generation;
    const revision = this.revision;
    const pending = (async () => {
      try {
        const terminals: Terminal[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const result = await this.read(threadId, cursor);
          if (!Array.isArray(result?.data)) return;
          terminals.push(...result.data);
          cursor = result.nextCursor ?? undefined;
          if (cursor && cursors.has(cursor)) throw new Error("Repeated background terminal cursor");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        if (this.disposed || generation !== this.generation || revision !== this.revision) return;
        this.terminals = terminals;
        this.publish();
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === -32601) {
          this.supported = false;
        }
        // Inventory is best effort; a transient failure must not fail a chat turn.
      }
    })().finally(() => {
      if (this.pending !== pending) return;
      this.pending = undefined;
      if (this.disposed || generation !== this.generation) return;
      if (revision !== this.revision) {
        void this.refresh();
      } else if (this.terminals.length > 0 && this.supported) {
        // Silent processes may exit without another model turn or output delta.
        this.timer = setTimeout(() => {
          void this.refresh();
        }, 1_000);
        this.timer.unref?.();
      }
    });
    this.pending = pending;
    return pending;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.stopTimer();
    this.terminals = [];
    this.waits.clear();
    this.publish();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(): void {
    const tasks = this.getTasks();
    const key = JSON.stringify(tasks);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.emit({
      type: "background_tasks.changed",
      threadId: this.localThreadId,
      tasks: [...tasks],
    });
  }
}
