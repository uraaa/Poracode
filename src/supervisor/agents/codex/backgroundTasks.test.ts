import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@/shared/contracts";
import { CodexBackgroundTasks } from "./backgroundTasks";

function fixture() {
  const events: RuntimeEvent[] = [];
  const read = vi.fn<
    (
      threadId: string,
      cursor?: string,
    ) => Promise<{
      data: Array<{ itemId: string; processId: string; command: string }>;
      nextCursor: string | null;
    }>
  >(async () => ({
    data: [] as Array<{ itemId: string; processId: string; command: string }>,
    nextCursor: null as string | null,
  }));
  const tracker = new CodexBackgroundTasks("local", read, (event) => events.push(event));
  tracker.setThread("remote");
  return { tracker, read, events };
}

afterEach(() => vi.useRealTimers());

describe("Codex background work", () => {
  it("restores live terminals, follows pagination, and drains exited processes", async () => {
    vi.useFakeTimers();
    const { tracker, read, events } = fixture();
    read
      .mockResolvedValueOnce({
        data: [{ itemId: "command-a", processId: "1", command: "node server.js" }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: [{ itemId: "command-b", processId: "2", command: "pnpm watch" }],
        nextCursor: null,
      });
    await tracker.refresh();
    expect(read.mock.calls).toEqual([
      ["remote", undefined],
      ["remote", "page-2"],
    ]);
    expect(tracker.getTasks()).toEqual([
      { taskId: "codex:process:1", kind: "command", description: "node server.js" },
      { taskId: "codex:process:2", kind: "command", description: "pnpm watch" },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tracker.getTasks()).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "background_tasks.changed",
      threadId: "local",
      tasks: [],
    });
    tracker.dispose();
  });

  it("shows interruptible waits and removes them at completion or interruption", () => {
    const { tracker } = fixture();
    tracker.observe("item/started", { item: { type: "sleep", id: "wait", durationMs: 5000 } });
    expect(tracker.getTasks()).toEqual([
      { taskId: "codex:sleep:wait", kind: "other", description: "clock.sleep (5000 ms)" },
    ]);
    tracker.observe("item/completed", { item: { type: "sleep", id: "wait", durationMs: 5000 } });
    expect(tracker.getTasks()).toEqual([]);
    tracker.observe("item/started", { item: { type: "sleep", id: "wait", durationMs: 5000 } });
    tracker.observe("turn/completed", {});
    expect(tracker.getTasks()).toEqual([]);
    tracker.dispose();
  });

  it("does not resurrect a completed command from an older in-flight snapshot", async () => {
    const { tracker, read } = fixture();
    let resolve!: (result: Awaited<ReturnType<typeof read>>) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = tracker.refresh();
    tracker.observe("item/completed", {
      item: { type: "commandExecution", id: "old", status: "completed" },
    });
    resolve({
      data: [{ itemId: "old", processId: "1", command: "old command" }],
      nextCursor: null,
    });
    await pending;
    expect(tracker.getTasks()).toEqual([]);
    tracker.dispose();
  });

  it("ignores delayed snapshots after changing thread or disposing", async () => {
    const { tracker, read, events } = fixture();
    let resolve!: (result: Awaited<ReturnType<typeof read>>) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = tracker.refresh();
    tracker.setThread("fork");
    tracker.dispose();
    resolve({
      data: [{ itemId: "old", processId: "1", command: "old command" }],
      nextCursor: null,
    });
    await pending;
    expect(tracker.getTasks()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("tolerates old CLIs without the list method and still displays waits", async () => {
    const { tracker, read } = fixture();
    read.mockRejectedValue(Object.assign(new Error("Method not found"), { code: -32601 }));
    await tracker.refresh();
    await tracker.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    tracker.observe("item/started", { item: { type: "sleep", id: "wait", durationMs: 1000 } });
    expect(tracker.getTasks()).toHaveLength(1);
    tracker.dispose();
  });
});
