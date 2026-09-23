import type { ThreadConfig, ThreadFollowUpQueueState } from "@/shared/contracts";
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

export interface FollowUpQueueSupervisorHooksDeps {
  /** Every thread the renderer may currently be showing a queue for. */
  listThreadIds(): string[];
  /**
   * The thread's *current* config. A message that waited through a restart
   * should go to the model the thread is set to now, not the one it was
   * queued with.
   */
  getThreadConfig(threadId: string): ThreadConfig | undefined;
  restore(input: {
    threadId: string;
    queue: ThreadFollowUpQueueState;
    config: ThreadConfig;
  }): Promise<void>;
  emitToRenderer(event: SupervisorEvent): void;
}

export interface FollowUpQueueSupervisorHooks {
  /** Wire into `SupervisorClient.onReset`. */
  onSupervisorReset(): void;
  /** Wire into `SupervisorClient.onStarted`. */
  onSupervisorStarted(): void;
}

/**
 * The two halves of a supervisor restart, kept together so the hook each one
 * belongs to is part of the contract rather than a detail of `main.ts`.
 */
export function createFollowUpQueueSupervisorHooks(
  deps: FollowUpQueueSupervisorHooksDeps,
): FollowUpQueueSupervisorHooks {
  const replay = (): void => {
    void restorePersistedFollowUpQueues(async ({ threadId, queue }) => {
      const config = deps.getThreadConfig(threadId);
      if (!config) return;
      await deps.restore({ threadId, queue, config });
    });
  };

  return {
    // `onReset` runs from the supervisor's `exit` handler, with the child
    // already detached: nothing can be sent from here. All it can honestly do
    // is stop the renderer from showing rows no process is holding — every
    // edit, remove or steer on them would fail with item-not-found until the
    // replay lands on the next spawn.
    onSupervisorReset: () => {
      for (const threadId of deps.listThreadIds()) {
        deps.emitToRenderer({ type: "thread-follow-up-queue", threadId, queue: null });
      }
    },
    // `onStarted` is the first moment requests can be sent, so this is where
    // the stored rows go back — including on the very first spawn, which
    // recovers a queue left behind by a previous run of the app.
    onSupervisorStarted: replay,
  };
}
