import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread, ThreadFollowUpQueueState } from "@/shared/contracts";
import type { SupervisorEvent } from "@/shared/ipc";
import { closeDatabase, initDatabase } from "@/main/db/connection";
import { dbGetThreadFollowUpQueues, dbReplaceThreadFollowUpQueue } from "@/main/db/followUpQueue";
import { dbUpsertProject, dbUpsertThread } from "@/main/db/projectsThreads";

const forkMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: forkMock };
});

vi.mock("@/shared/processTree", () => ({ terminateChildProcessTree: vi.fn<() => void>() }));

import { SupervisorClient } from "@/main/supervisor/SupervisorClient";
import {
  createFollowUpQueueSupervisorHooks,
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

/**
 * The supervisor hooks are wired into a real `SupervisorClient` driven by a
 * fake child, because the bug this pins is a wiring bug: `onReset` runs while
 * `this.child` is already `null`, so every request made from it rejects with
 * "Supervisor is not running." before it can reach the process.
 */
describe.skipIf(!sqliteAvailable)("follow-up queue supervisor hooks", () => {
  let dir: string;

  interface FakeChild extends EventEmitter {
    connected: boolean;
    stdout: null;
    stderr: null;
    send: ReturnType<
      typeof vi.fn<(message: unknown, callback?: (e?: Error | null) => void) => boolean>
    >;
    kill: ReturnType<typeof vi.fn<() => boolean>>;
  }

  function makeFakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.connected = true;
    child.stdout = null;
    child.stderr = null;
    child.send = vi.fn<(message: unknown, callback?: (e?: Error | null) => void) => boolean>(
      (_message, callback) => {
        callback?.();
        return true;
      },
    );
    child.kill = vi.fn<() => boolean>();
    return child;
  }

  beforeEach(() => {
    forkMock.mockReset();
    if (nativeBindingEnv) {
      process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING = nativeBindingEnv;
    }
    dir = mkdtempSync(join(tmpdir(), "poracode-follow-up-hooks-"));
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

  function wire() {
    const rendererEvents: SupervisorEvent[] = [];
    const hooks = createFollowUpQueueSupervisorHooks({
      listThreadIds: () => ["thread-1"],
      getThreadConfig: () => ({ model: "gpt-5.6" }),
      restore: (input) => client.call("restoreThreadFollowUpQueue", input),
      emitToRenderer: (event) => rendererEvents.push(event),
    });
    const client = new SupervisorClient({
      appVersion: "test",
      isDev: true,
      supervisorPath: "/fake/supervisor.cjs",
      wslHelpersDir: "/fake/wsl",
      secretStorageKey: "key",
      onEvent: vi.fn<(event: SupervisorEvent) => void>(),
      onReset: () => hooks.onSupervisorReset(),
      onStarted: () => hooks.onSupervisorStarted(),
    });
    return { client, rendererEvents };
  }

  it("replays the stored queue into a supervisor that can actually take the request", async () => {
    dbReplaceThreadFollowUpQueue("thread-1", {
      paused: false,
      items: [{ id: "kept", prompt: "survived restart", stagedAt: 42 }],
    });
    const { client } = wire();
    const child = makeFakeChild();
    forkMock.mockReturnValue(child);

    client.start("/base");

    await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
    expect(child.send.mock.calls[0]![0]).toMatchObject({
      type: "restoreThreadFollowUpQueue",
      payload: {
        threadId: "thread-1",
        queue: { paused: false, items: [{ id: "kept", prompt: "survived restart", stagedAt: 42 }] },
        config: { model: "gpt-5.6" },
      },
    });
    client.dispose();
  });

  it("tells the renderer the queue is gone while the restore is still in flight", async () => {
    dbReplaceThreadFollowUpQueue("thread-1", {
      paused: false,
      items: [{ id: "kept", prompt: "survived restart", stagedAt: 42 }],
    });
    const { client, rendererEvents } = wire();
    const first = makeFakeChild();
    forkMock.mockReturnValue(first);
    client.start("/base");
    await vi.waitFor(() => expect(first.send).toHaveBeenCalled());
    rendererEvents.length = 0;

    first.connected = false;
    first.emit("exit", 1);

    // The supervisor is gone and holds nothing; leaving the rows on screen
    // makes every edit/remove/steer on them fail with item-not-found.
    expect(rendererEvents).toEqual([
      { type: "thread-follow-up-queue", threadId: "thread-1", queue: null },
    ]);
    client.dispose();
  });
});
