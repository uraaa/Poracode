import { afterEach, expect, it, vi } from "vitest";
import { GitWatcherScheduler } from "./gitWatcherScheduler";
afterEach(() => vi.useRealTimers());
it("absorbs fetch invalidations without dropping targeted edits or later external ref changes", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const scheduler = new GitWatcherScheduler(refresh);
  const fetch = Promise.withResolvers<void>();
  scheduler.schedule("p");
  const covered = scheduler.coverProjectRefresh(
    "p",
    () => fetch.promise,
    async () => undefined,
  );
  scheduler.schedule("p");
  scheduler.schedule("p", "/changed-sidebar");
  await vi.advanceTimersByTimeAsync(2000);
  expect(refresh).not.toHaveBeenCalled();
  fetch.resolve();
  await vi.advanceTimersByTimeAsync(300);
  scheduler.schedule("p"); // Debounced delivery after the fetch reply is covered by the future read.
  await vi.advanceTimersByTimeAsync(200);
  await covered;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(refresh).toHaveBeenCalledExactlyOnceWith("p", ["/changed-sidebar"], false);
  scheduler.schedule("p"); // A later external ref update must still refresh everything.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(refresh).toHaveBeenLastCalledWith("p", [], true);
  scheduler.dispose();
});
it("replays external ref changes received during or just after the covering snapshot", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const scheduler = new GitWatcherScheduler(refresh);
  const snapshot = Promise.withResolvers<void>();
  const covered = scheduler.coverProjectRefresh(
    "p",
    async () => undefined,
    () => snapshot.promise,
  );
  await vi.advanceTimersByTimeAsync(500);
  scheduler.schedule("p"); // Another worktree/ref changes after a sibling has already been read.
  snapshot.resolve();
  await covered;
  await vi.advanceTimersByTimeAsync(500);
  scheduler.schedule("p"); // Also exercise the old post-snapshot suppression window.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(refresh).toHaveBeenCalledExactlyOnceWith("p", [], true);
  scheduler.dispose();
});
it("refreshes displayed edits within two seconds while sidebar edits remain throttled", async () => {
  vi.useFakeTimers();
  const visible = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const background = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const fast = new GitWatcherScheduler(visible, 1500);
  const slow = new GitWatcherScheduler(background);
  fast.schedule("p", "/open");
  slow.schedule("p", "/sidebar");
  await vi.advanceTimersByTimeAsync(500);
  fast.schedule("p", "/open");
  slow.schedule("p", "/sidebar");
  await vi.advanceTimersByTimeAsync(1500);
  expect(visible).toHaveBeenCalledTimes(2);
  expect(background).toHaveBeenCalledTimes(1);
  fast.dispose();
  slow.dispose();
});
it("coalesces project/worktree bursts, bounds continuous churn, and enforces a minimum interval", async () => {
  vi.useFakeTimers();
  const refresh = vi
    .fn<(projectId: string, paths: string[], wholeProject: boolean) => Promise<void>>()
    .mockResolvedValue(undefined);
  const scheduler = new GitWatcherScheduler(refresh);
  for (let i = 0; i < 600; i++) {
    scheduler.schedule("p", "/wt/1");
    scheduler.schedule("p", "/wt/2");
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledWith("p", ["/wt/1", "/wt/2"], false);
  scheduler.dispose();
});
it("does not postpone another project and drops pending work on dispose", async () => {
  vi.useFakeTimers();
  const refresh = vi
    .fn<(projectId: string, paths: string[], wholeProject: boolean) => Promise<void>>()
    .mockResolvedValue(undefined);
  const scheduler = new GitWatcherScheduler(refresh);
  scheduler.schedule("p1", "/wt");
  scheduler.schedule("p2");
  await vi.advanceTimersByTimeAsync(500);
  expect(refresh).toHaveBeenCalledTimes(2);
  scheduler.schedule("p1", "/wt");
  scheduler.dispose();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("disposal stops scheduling without cancelling an in-flight operation", async () => {
  vi.useFakeTimers();
  const operation = Promise.withResolvers<void>();
  const finished = vi.fn<() => void>();
  const scheduler = new GitWatcherScheduler(async () => {
    await operation.promise;
    finished();
  });
  scheduler.schedule("p");
  await vi.advanceTimersByTimeAsync(500);
  scheduler.dispose();
  operation.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toHaveBeenCalledOnce();
});
