import type { PendingSteerState, ThreadFollowUpQueueState } from "@/shared/contracts";
import { getSqlite } from "./connection";
import { safeParse } from "./rowMappers";

// ── Queued follow-ups ───────────────────────────────────────────────
//
// The supervisor owns the live queue; this table is its durable shadow. It
// exists so a crash or a restart does not silently drop messages the user
// already handed over: every queue change is mirrored here as its event
// passes through the main process, and the rows are replayed into a fresh
// supervisor.
//
// What it does not cover: the item currently being dispatched. The coordinator
// removes it from the public queue and emits — which deletes its row — before
// the turn is started, so a crash in that window loses it. That ordering is
// what keeps the table from ever redelivering a message the agent already
// received; the window is the price. Durability here means "queued", not
// "queued or in flight".

interface FollowUpQueueRow {
  thread_id: string;
  item_id: string;
  staged_at: number;
  paused: number;
  payload: string;
}

/** Replace a thread's stored queue. `null` clears it. */
export function dbReplaceThreadFollowUpQueue(
  threadId: string,
  queue: ThreadFollowUpQueueState | null,
): void {
  const sqlite = getSqlite();
  const replace = sqlite.transaction(() => {
    // A queue event can outlive its thread: `dbDeleteThread` runs before the
    // supervisor's closeThread reaches `emitQueueState`. The rows went with
    // the thread via ON DELETE CASCADE, so there is nothing left to write —
    // and the insert would fail the thread_id foreign key.
    if (!threadExistsInSqlite(sqlite, threadId)) return;
    sqlite.prepare("DELETE FROM thread_follow_up_queue WHERE thread_id = ?").run(threadId);
    if (!queue || queue.items.length === 0) return;
    const insert = sqlite.prepare(
      "INSERT INTO thread_follow_up_queue " +
        "(thread_id, item_id, position, staged_at, paused, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    queue.items.forEach((item, position) => {
      insert.run(
        threadId,
        item.id,
        position,
        item.stagedAt,
        queue.paused ? 1 : 0,
        JSON.stringify({
          prompt: item.prompt,
          ...(item.segments ? { segments: item.segments } : {}),
        }),
      );
    });
  });
  replace();
}

/** Same guard the runtime-item writer uses: never write for a vanished thread. */
function threadExistsInSqlite(sqlite: ReturnType<typeof getSqlite>, threadId: string): boolean {
  return sqlite.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId) !== undefined;
}

/**
 * Every stored queue, keyed by thread, rows in their queued order.
 *
 * Deliberately uncapped. It is read once per supervisor start, and its size is
 * bounded by what the user themselves typed and has not yet had delivered —
 * tens of short prompts at the outside. A cap here would mean silently
 * dropping exactly the messages this table exists to protect.
 */
export function dbGetThreadFollowUpQueues(): Map<string, ThreadFollowUpQueueState> {
  const rows = getSqlite()
    .prepare(
      "SELECT thread_id, item_id, staged_at, paused, payload FROM thread_follow_up_queue " +
        "ORDER BY thread_id, position",
    )
    .all() as FollowUpQueueRow[];
  const queues = new Map<string, ThreadFollowUpQueueState>();
  for (const row of rows) {
    const parsed = safeParse(row.payload) as { prompt?: unknown; segments?: unknown } | null;
    if (!parsed || typeof parsed.prompt !== "string") continue;
    const segments = Array.isArray(parsed.segments)
      ? (parsed.segments as NonNullable<PendingSteerState["segments"]>)
      : undefined;
    const item: PendingSteerState = {
      id: row.item_id,
      prompt: parsed.prompt,
      stagedAt: row.staged_at,
      ...(segments ? { segments } : {}),
    };
    const queue = queues.get(row.thread_id);
    if (queue) queue.items.push(item);
    else queues.set(row.thread_id, { paused: row.paused === 1, items: [item] });
  }
  return queues;
}
