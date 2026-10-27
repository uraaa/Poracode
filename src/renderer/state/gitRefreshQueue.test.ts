import { expect, it, vi } from "vitest";
import { GitRefreshQueue, type GitRefreshRequest } from "./gitRefreshQueue";

const request: GitRefreshRequest = {
  project: { id: "project", location: { kind: "posix", path: "/repo" } },
  reason: "watcher",
  mode: "status",
  options: {},
};

it("retains an uncancellable manual request when a later matching caller unmounts", async () => {
  const stalled = Promise.withResolvers<void>();
  const run = vi
    .fn<(next: GitRefreshRequest) => Promise<void>>()
    .mockReturnValueOnce(stalled.promise)
    .mockResolvedValue(undefined);
  const queue = new GitRefreshQueue(run);
  const completion = queue.enqueue(request);
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
  const stalled = Promise.withResolvers<void>();
  const run = vi
    .fn<(next: GitRefreshRequest) => Promise<void>>()
    .mockReturnValueOnce(stalled.promise)
    .mockResolvedValue(undefined);
  const queue = new GitRefreshQueue(run);
  const completion = queue.enqueue(request);
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
  await completion;
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0]).toMatchObject({
    reason: "watcher",
    mode: "status",
    options: { fetchRemote: false },
  });
});
