import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitProjectSnapshotResult, GitStatusResult, Thread } from "@/shared/contracts";
import type { PoracodeBridge } from "@/shared/ipc";
import { useAppStore } from "@/renderer/state/appStore";
import { useGitStore } from "@/renderer/state/gitStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { cleanupGitRefreshProjects, stopPendingPrRefresh } from "@/renderer/state/gitRefresh";
import { useGitRefresh } from "./useGitRefresh";

afterEach(() => {
  stopPendingPrRefresh();
  cleanupGitRefreshProjects(new Set());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
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
  const project = {
    id: "fetch-queue-project",
    name: "Repo",
    location: { kind: "posix" as const, path: "/repo" },
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const bridge = {
    platform: "darwin",
    dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
    dbSetState: vi.fn<PoracodeBridge["dbSetState"]>().mockResolvedValue(undefined),
    gitProjectSnapshot: vi.fn<PoracodeBridge["gitProjectSnapshot"]>().mockResolvedValue(snapshot),
    gitFetch: vi.fn<PoracodeBridge["gitFetch"]>().mockResolvedValue(undefined),
    getGitStatus: vi.fn<PoracodeBridge["getGitStatus"]>().mockResolvedValue(status),
    gitWorktreeStatusBatch: vi
      .fn<PoracodeBridge["gitWorktreeStatusBatch"]>()
      .mockResolvedValue({ statuses: {} }),
    gitWatchProject: vi.fn<PoracodeBridge["gitWatchProject"]>().mockResolvedValue(undefined),
    gitWatchWorktrees: vi.fn<PoracodeBridge["gitWatchWorktrees"]>().mockResolvedValue(undefined),
    gitUnwatchProject: vi.fn<PoracodeBridge["gitUnwatchProject"]>().mockResolvedValue(undefined),
    onSupervisorEvent: vi.fn<PoracodeBridge["onSupervisorEvent"]>(() => () => undefined),
  } satisfies Partial<PoracodeBridge>;
  Object.defineProperty(window, "poracode", { configurable: true, value: bridge });
  useAppStore.setState({ projects: [project], threads: [], view: { kind: "home" } });
  usePanelStore.setState({
    gitReviewContext: null,
    gitReviewAsPanel: false,
    gitOverlayOpen: false,
    filesPanelContext: null,
  });
  useGitStore.setState({ statuses: {}, ghAvailable: {}, prData: {}, worktrees: {} });
  return { bridge, project, status, snapshot };
}

it("keeps scheduled network fetch independent of a stalled local snapshot", async () => {
  const { bridge, project, snapshot } = setup();
  const stalled = Promise.withResolvers<GitProjectSnapshotResult>();
  const network = Promise.withResolvers<void>();
  bridge.gitProjectSnapshot.mockReturnValueOnce(stalled.promise);
  bridge.gitFetch.mockReturnValue(network.promise);
  const hook = renderHook(() => useGitRefresh(true));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(bridge.gitFetch).toHaveBeenCalledExactlyOnceWith({
      projectLocation: project.location,
      remote: "origin",
      prune: true,
      background: true,
    });
  } finally {
    await act(async () => {
      stalled.resolve(snapshot);
      await vi.advanceTimersByTimeAsync(0);
      network.resolve();
      await vi.advanceTimersByTimeAsync(250);
    });
    hook.unmount();
  }
  expect(bridge.gitFetch).toHaveBeenCalledTimes(1);
  expect(bridge.gitProjectSnapshot).toHaveBeenCalledTimes(1);
  expect(bridge.getGitStatus).toHaveBeenCalledTimes(1);
});

it("refreshes local status during a pending fetch and coalesces its 100 watcher events", async () => {
  const { bridge, project } = setup();
  const network = Promise.withResolvers<void>();
  bridge.gitFetch.mockReturnValue(network.promise);
  const hook = renderHook(() => useGitRefresh(true));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const onEvent = bridge.onSupervisorEvent.mock.calls[0]![0];
    await act(async () => {
      for (let index = 0; index < 100; index++)
        onEvent({ type: "git-changed", projectId: project.id });
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(bridge.getGitStatus).toHaveBeenCalledExactlyOnceWith({
      projectLocation: project.location,
      detail: "summary",
      background: true,
    });
    expect(bridge.gitProjectSnapshot).toHaveBeenCalledTimes(1);
  } finally {
    hook.unmount();
    network.resolve();
  }
});

it("refreshes a dormant worktree when its thread pane opens", async () => {
  const { bridge, project } = setup();
  const thread: Thread = {
    id: "dormant",
    projectId: project.id,
    title: "Thread",
    agentKind: "codex",
    config: { model: "gpt-5" },
    status: "idle",
    attention: "none",
    canResumeWithConfig: false,
    worktreePath: "/repo-worktree",
    worktreeBranch: "feature",
    archived: false,
    done: false,
    starred: false,
    createdAt: project.createdAt,
    updatedAt: project.createdAt,
  };
  useAppStore.setState({ threads: [thread] });
  const hook = renderHook(() => useGitRefresh(true));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(bridge.gitWorktreeStatusBatch).not.toHaveBeenCalled();
    await act(async () => {
      useAppStore.setState({ view: { kind: "thread", panes: [thread.id] } });
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(bridge.gitWorktreeStatusBatch).toHaveBeenCalledExactlyOnceWith({
      projectLocation: project.location,
      worktreePaths: ["/repo-worktree"],
      detail: "summary",
      background: true,
    });
  } finally {
    hook.unmount();
  }
});

it("coalesces a fetch completion and its ref watcher notification into one status refresh", async () => {
  const { bridge, project } = setup();
  const network = Promise.withResolvers<void>();
  bridge.gitFetch.mockReturnValue(network.promise);
  const hook = renderHook(() => useGitRefresh(true));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      network.resolve();
      await vi.advanceTimersByTimeAsync(0);
      bridge.onSupervisorEvent.mock.calls[0]![0]({ type: "git-changed", projectId: project.id });
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(bridge.getGitStatus).toHaveBeenCalledTimes(1);
    expect(bridge.gitProjectSnapshot).toHaveBeenCalledTimes(1);
  } finally {
    hook.unmount();
  }
});
