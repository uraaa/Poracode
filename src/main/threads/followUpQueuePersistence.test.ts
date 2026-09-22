import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread, ThreadFollowUpQueueState } from "@/shared/contracts";
import { closeDatabase, initDatabase } from "@/main/db/connection";
import { dbGetThreadFollowUpQueues, dbReplaceThreadFollowUpQueue } from "@/main/db/followUpQueue";
import { dbUpsertProject, dbUpsertThread } from "@/main/db/projectsThreads";
import {
  persistFollowUpQueueEvent,
  restorePersistedFollowUpQueues,
} from "./followUpQueuePersistence";

const serverNativeBinding = join(process.cwd(), "dist", "server-native", "better_sqlite3.node");
let nativeBindingEnv: string | undefined;
let sqliteAvailable = true;
try {
  new Database(":memory:").close();
} catch {
  if (existsSync(serverNativeBinding)) {
    nativeBindingEnv = serverNativeBinding;
  } else {
    sqliteAvailable = false;
  }
}

function thread(id: string): Thread {
  return {
    id,
    projectId: "project-1",
    title: "Queue thread",
    agentKind: "codex",
    config: { model: "gpt-5.6" },
    status: "working",
    attention: "none",
    canResumeWithConfig: true,
    presentationMode: "gui",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
  } as unknown as Thread;
}

describe.skipIf(!sqliteAvailable)("follow-up queue persistence wiring", () => {
  let dir: string;

  beforeEach(() => {
    if (nativeBindingEnv) {
      process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING = nativeBindingEnv;
    }
    dir = mkdtempSync(join(tmpdir(), "poracode-follow-up-wiring-"));
    initDatabase(join(dir, "state.sqlite"));
    dbUpsertProject(
      {
        id: "project-1",
        name: "Poracode",
        location: { kind: "posix", path: "/repo" },
        createdAt: "2026-09-22T00:00:00.000Z",
      },
      0,
    );
    dbUpsertThread(thread("thread-1"), 0);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING;
  });

  it("stores the queue carried by a supervisor event", () => {
    persistFollowUpQueueEvent({
      type: "thread-follow-up-queue",
      threadId: "thread-1",
      queue: { paused: false, items: [{ id: "a", prompt: "keep me", stagedAt: 7 }] },
    });

    expect(dbGetThreadFollowUpQueues().get("thread-1")).toEqual({
      paused: false,
      items: [{ id: "a", prompt: "keep me", stagedAt: 7 }],
    });
  });

  it("ignores every other supervisor event", () => {
    persistFollowUpQueueEvent({
      type: "thread-state",
      threadId: "thread-1",
      status: "idle",
      attention: "none",
      canResumeWithConfig: false,
    });

    expect(dbGetThreadFollowUpQueues().size).toBe(0);
  });

  it("hands every stored queue back to a fresh supervisor", async () => {
    dbReplaceThreadFollowUpQueue("thread-1", {
      paused: true,
      items: [{ id: "kept", prompt: "survived restart", stagedAt: 42 }],
    });
    const restore = vi.fn<
      (input: { threadId: string; queue: ThreadFollowUpQueueState }) => Promise<void>
    >(async () => {});

    await restorePersistedFollowUpQueues(restore);

    expect(restore).toHaveBeenCalledWith({
      threadId: "thread-1",
      queue: { paused: true, items: [{ id: "kept", prompt: "survived restart", stagedAt: 42 }] },
    });
  });

  it("keeps the stored queue when one thread fails to restore", async () => {
    dbUpsertThread(thread("thread-2"), 1);
    dbReplaceThreadFollowUpQueue("thread-1", {
      paused: false,
      items: [{ id: "a", prompt: "first", stagedAt: 1 }],
    });
    dbReplaceThreadFollowUpQueue("thread-2", {
      paused: false,
      items: [{ id: "b", prompt: "second", stagedAt: 2 }],
    });
    const restore = vi
      .fn<(input: { threadId: string; queue: ThreadFollowUpQueueState }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("thread is not running"))
      .mockResolvedValueOnce(undefined);

    await restorePersistedFollowUpQueues(restore);

    expect(restore).toHaveBeenCalledTimes(2);
    expect(dbGetThreadFollowUpQueues().size).toBe(2);
  });
});
