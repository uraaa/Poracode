import { afterEach, expect, it, vi } from "vitest";
import { GitRefreshQueue, type GitRefreshRequest } from "./gitRefreshQueue";

const request: GitRefreshRequest = {
  project: { id: "project", location: { kind: "posix", path: "/repo" } },
  reason: "watcher",
  mode: "status",
  options: {},
};

afterEach(() => vi.useRealTimers());

it("coalesces 100 watcher events into one quiet refresh and enforces a minimum interval", async () => {
  vi.useFakeTimers();
  const run = vi.fn<(next: GitRefreshRequest) => Promise<void>>().mockResolvedValue(undefined);
  const queue = new GitRefreshQueue(run);
  for (let index = 0; index < 100; index++) void queue.enqueue(request);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(run).toHaveBeenCalledTimes(1);
  void queue.enqueue(request);
  await vi.advanceTimersByTimeAsync(250);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_750);
  expect(run).toHaveBeenCalledTimes(2);
});

it("waits for watcher quiet after the running cycle settles", async () => {
  vi.useFakeTimers();
  const stalled = Promise.withResolvers<void>();
  const run = vi
    .fn<(next: GitRefreshRequest) => Promise<void>>()
    .mockReturnValueOnce(stalled.promise)
    .mockResolvedValue(undefined);
  const queue = new GitRefreshQueue(run);
  void queue.enqueue({ ...request, reason: "initial" });
  await vi.advanceTimersByTimeAsync(3_000);
  void queue.enqueue(request);
  stalled.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 100; index++) {
    await vi.advanceTimersByTimeAsync(100);
    void queue.enqueue(request);
  }
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(250);
  expect(run).toHaveBeenCalledTimes(2);
});

it("abandons a hung generation after 30 seconds without invalidating its replacement", async () => {
  vi.useFakeTimers();
  const stalled = Promise.withResolvers<void>();
  const replacement = Promise.withResolvers<void>();
  const run = vi
    .fn<(next: GitRefreshRequest) => Promise<void>>()
    .mockReturnValueOnce(stalled.promise)
    .mockReturnValueOnce(replacement.promise)
    .mockResolvedValue(undefined);
  const queue = new GitRefreshQueue(run);
  const first = queue.enqueue({ ...request, reason: "poll" });
  await vi.advanceTimersByTimeAsync(30_000);
  await first;
  expect(run.mock.calls[0]?.[0].options.isActive?.()).toBe(false);
  const next = queue.enqueue({ ...request, reason: "poll" });
  stalled.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(run.mock.calls[1]?.[0].options.isActive?.()).toBe(true);
  void queue.enqueue({ ...request, reason: "manual" });
  expect(run).toHaveBeenCalledTimes(2);
  replacement.resolve();
  await next;
  expect(run).toHaveBeenCalledTimes(3);
});

it("retains an uncancellable manual request when a later matching caller unmounts", async () => {
  const stalled = Promise.withResolvers<void>();
  const run = vi
    .fn<(next: GitRefreshRequest) => Promise<void>>()
    .mockReturnValueOnce(stalled.promise)
    .mockResolvedValue(undefined);
  const queue = new GitRefreshQueue(run);
  const completion = queue.enqueue({ ...request, reason: "initial" });
  void queue.enqueue({
    ...request,
    reason: "manual",
    mode: "full",
    options: { fetchRemote: true },
  });
  let mounted = true;
  void queue.enqueue({
    ...request,
    reason: "manual",
    mode: "full",
    options: { fetchRemote: true, isActive: () => mounted },
  });
  mounted = false;
  stalled.resolve();
  await completion;
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0]).toMatchObject({
    reason: "manual",
    mode: "full",
    options: { fetchRemote: true },
  });
});

it("drops cancelled upgrades and keeps a live watcher follow-up", async () => {
  vi.useFakeTimers();
  const stalled = Promise.withResolvers<void>();
  const run = vi
    .fn<(next: GitRefreshRequest) => Promise<void>>()
    .mockReturnValueOnce(stalled.promise)
    .mockResolvedValue(undefined);
  const queue = new GitRefreshQueue(run);
  const completion = queue.enqueue({ ...request, reason: "initial" });
  let mounted = true;
  void queue.enqueue({
    ...request,
    reason: "manual",
    mode: "full",
    options: { fetchRemote: true, isActive: () => mounted },
  });
  void queue.enqueue(request);
  mounted = false;
  stalled.resolve();
  await vi.advanceTimersByTimeAsync(2_000);
  await completion;
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0]).toMatchObject({
    reason: "watcher",
    mode: "status",
    options: { fetchRemote: false },
  });
});
