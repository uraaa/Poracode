import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitProjectSnapshotResult, GitStatusResult } from "@/shared/contracts";
import type { PoracodeBridge } from "@/shared/ipc";
import { useAppStore } from "@/renderer/state/appStore";
import { useGitStore } from "@/renderer/state/gitStore";
import { cleanupGitRefreshProjects, stopPendingPrRefresh } from "@/renderer/state/gitRefresh";
import { useGitRefresh } from "./useGitRefresh";

afterEach(() => {
  stopPendingPrRefresh();
  cleanupGitRefreshProjects(new Set());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("queues the scheduled fetch behind an active snapshot instead of overlapping it", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const status: GitStatusResult = {
    isRepo: true,
    branch: "main",
    tracking: "origin/main",
    hasRemote: true,
    remoteInfo: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    totalInsertions: 0,
    totalDeletions: 0,
  };
  const snapshot: GitProjectSnapshotResult = {
    status,
    branches: { current: status.branch, branches: [] },
    worktrees: [],
    ghAvailable: false,
  };
  const stalled = Promise.withResolvers<GitProjectSnapshotResult>();
  const gitProjectSnapshot = vi
    .fn<PoracodeBridge["gitProjectSnapshot"]>()
    .mockReturnValueOnce(stalled.promise)
    .mockResolvedValue(snapshot);
  const gitFetch = vi.fn<PoracodeBridge["gitFetch"]>().mockResolvedValue(undefined);
  const bridge = {
    platform: "darwin",
    dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
    dbSetState: vi.fn<PoracodeBridge["dbSetState"]>().mockResolvedValue(undefined),
    gitProjectSnapshot,
    gitFetch,
    gitWatchProject: vi.fn<PoracodeBridge["gitWatchProject"]>().mockResolvedValue(undefined),
    gitWatchWorktrees: vi.fn<PoracodeBridge["gitWatchWorktrees"]>().mockResolvedValue(undefined),
    gitUnwatchProject: vi.fn<PoracodeBridge["gitUnwatchProject"]>().mockResolvedValue(undefined),
    onSupervisorEvent: vi.fn<PoracodeBridge["onSupervisorEvent"]>(() => () => undefined),
  } satisfies Partial<PoracodeBridge>;
  Object.defineProperty(window, "poracode", { configurable: true, value: bridge });
  useAppStore.setState({
    projects: [
      {
        id: "fetch-queue-project",
        name: "Repo",
        location: { kind: "posix", path: "/repo" },
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    threads: [],
    view: { kind: "home" },
  });
  useGitStore.setState({ statuses: {}, ghAvailable: {}, prData: {}, worktrees: {} });
  const hook = renderHook(() => useGitRefresh(true));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(gitFetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      stalled.resolve(snapshot);
      await vi.advanceTimersByTimeAsync(0);
    });
    hook.unmount();
  }
  expect(gitFetch).toHaveBeenCalledTimes(1);
  expect(gitProjectSnapshot).toHaveBeenCalledTimes(2);
});
