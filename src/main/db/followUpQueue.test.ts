import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Thread } from "@/shared/contracts";
import { closeDatabase, initDatabase } from "./connection";
import { dbUpsertProject, dbUpsertThread } from "./projectsThreads";
import { dbGetThreadFollowUpQueues, dbReplaceThreadFollowUpQueue } from "./followUpQueue";

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

describe.skipIf(!sqliteAvailable)("follow-up queue persistence", () => {
  let dir: string;

  beforeEach(() => {
    if (nativeBindingEnv) {
      process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING = nativeBindingEnv;
    }
    dir = mkdtempSync(join(tmpdir(), "poracode-follow-up-queue-"));
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

  it("stores and reads back a thread's queue in order", () => {
    dbReplaceThreadFollowUpQueue("thread-1", {
      paused: true,
      items: [
        { id: "a", prompt: "first", stagedAt: 10 },
        {
          id: "b",
          prompt: "second",
          stagedAt: 20,
          segments: [{ kind: "text", content: "second" }],
        },
      ],
    });

    expect(dbGetThreadFollowUpQueues().get("thread-1")).toEqual({
      paused: true,
      items: [
        { id: "a", prompt: "first", stagedAt: 10 },
        {
          id: "b",
          prompt: "second",
          stagedAt: 20,
          segments: [{ kind: "text", content: "second" }],
        },
      ],
    });
  });

  it("replaces the stored queue instead of appending to it", () => {
    dbReplaceThreadFollowUpQueue("thread-1", {
      paused: false,
      items: [{ id: "a", prompt: "first", stagedAt: 10 }],
    });
    dbReplaceThreadFollowUpQueue("thread-1", {
      paused: false,
      items: [{ id: "b", prompt: "only this one", stagedAt: 30 }],
    });

    expect(dbGetThreadFollowUpQueues().get("thread-1")).toEqual({
      paused: false,
      items: [{ id: "b", prompt: "only this one", stagedAt: 30 }],
    });
  });

  it("ignores a queue for a thread that is already gone", () => {
    // `dbDeleteThread` runs before the supervisor's closeThread reaches
    // `emitQueueState`, so a queue event for a deleted thread is ordinary. The
    // insert would violate the thread_id foreign key and throw out of the
    // main-process event handler, taking the window down with it.
    expect(() =>
      dbReplaceThreadFollowUpQueue("thread-gone", {
        paused: false,
        items: [{ id: "a", prompt: "orphan", stagedAt: 10 }],
      }),
    ).not.toThrow();
    expect(dbGetThreadFollowUpQueues().has("thread-gone")).toBe(false);
  });

  it("drops the row set when the queue is emptied", () => {
    dbReplaceThreadFollowUpQueue("thread-1", {
      paused: false,
      items: [{ id: "a", prompt: "first", stagedAt: 10 }],
    });
    dbReplaceThreadFollowUpQueue("thread-1", null);

    expect(dbGetThreadFollowUpQueues().has("thread-1")).toBe(false);
  });
});
