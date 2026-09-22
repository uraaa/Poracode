import type { ThreadFollowUpQueueState } from "@/shared/contracts";
import type { SupervisorEvent } from "@/shared/ipc";
import { dbGetThreadFollowUpQueues, dbReplaceThreadFollowUpQueue } from "@/main/db/followUpQueue";

/**
 * Mirror a queue change into the database as the event passes through, before
 * the renderer ever sees it. Durable first: a crash between "accepted in the
 * UI" and delivery must not lose what the user typed.
 */
export function persistFollowUpQueueEvent(event: SupervisorEvent): void {
  if (event.type !== "thread-follow-up-queue") return;
  dbReplaceThreadFollowUpQueue(event.threadId, event.queue);
}

/**
 * Hand every stored queue back to a supervisor that just (re)started. Threads
 * are restored independently: one that refuses — its session may be gone —
 * must not stop the rest, and its rows stay in the database for the next
 * attempt rather than being dropped on the floor.
 */
export async function restorePersistedFollowUpQueues(
  restore: (input: { threadId: string; queue: ThreadFollowUpQueueState }) => Promise<void>,
): Promise<void> {
  for (const [threadId, queue] of dbGetThreadFollowUpQueues()) {
    try {
      await restore({ threadId, queue });
    } catch (error) {
      console.error("[main] failed to restore the follow-up queue for", threadId, error);
    }
  }
}
