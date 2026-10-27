import { afterEach, expect, it, vi } from "vitest";
import { GitWatcherScheduler } from "./gitWatcherScheduler";
afterEach(() => vi.useRealTimers());
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
