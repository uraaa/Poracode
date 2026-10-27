import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitStatusResult, Project, Thread } from "@/shared/contracts";
import type { PoracodeBridge } from "@/shared/ipc";
import { useAppStore } from "@/renderer/state/appStore";
import { useGitStore } from "@/renderer/state/gitStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { cleanupGitRefreshProjects, refreshGitProject } from "@/renderer/state/gitRefresh";
import {
  __resetExperimentCandidateStatsCacheForTest,
  useExperimentCandidateStats,
} from "./useExperimentCandidateStats";

const project: Project = {
  id: "stats-project",
  name: "Repo",
  location: { kind: "posix", path: "/repo" },
  createdAt: "2026-10-01T00:00:00Z",
};
const summary: GitStatusResult = {
  detail: "summary",
  isRepo: true,
  branch: "feature",
  tracking: "",
  hasRemote: false,
  remoteInfo: null,
  ahead: 0,
  behind: 0,
  totalInsertions: 0,
  totalDeletions: 0,
  staged: [],
  unstaged: [{ path: "file.ts", status: "M", staged: false, insertions: 0, deletions: 0 }],
};
const args = {
  projectLocation: project.location,
  worktreePath: "/repo-wt",
  baseCommit: "a".repeat(40),
  worktreeState: "owned" as const,
  worktreeStatus: summary,
  isActive: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  __resetExperimentCandidateStatsCacheForTest();
  cleanupGitRefreshProjects(new Set());
  useGitStore.setState({
    statuses: {},
    worktreeStatuses: {},
    worktreeStatusRevisions: {},
    ghAvailable: {},
    prData: {},
  });
  usePanelStore.setState({
    gitReviewContext: null,
    filesPanelContext: null,
    gitOverlayOpen: false,
  });
});
afterEach(() => {
  cleanupGitRefreshProjects(new Set());
  vi.useRealTimers();
});

it("refreshes content stats once per completed watcher cycle even when summary rows stay unchanged", async () => {
  const getExperimentCandidateStats = vi
    .fn<PoracodeBridge["getExperimentCandidateStats"]>()
    .mockResolvedValueOnce({ insertions: 1, deletions: 0, files: 1 })
    .mockResolvedValueOnce({ insertions: 2, deletions: 0, files: 1 })
    .mockResolvedValue({ insertions: 3, deletions: 0, files: 1 });
  const gitWorktreeStatusBatch = vi
    .fn<PoracodeBridge["gitWorktreeStatusBatch"]>()
    .mockResolvedValue({ statuses: { "/repo-wt": summary } });
  Object.defineProperty(window, "poracode", {
    configurable: true,
    value: {
      platform: "darwin",
      getExperimentCandidateStats,
      gitWorktreeStatusBatch,
      getGitStatus: vi.fn<PoracodeBridge["getGitStatus"]>().mockResolvedValue(summary),
      dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
      dbSetState: vi.fn<PoracodeBridge["dbSetState"]>().mockResolvedValue(undefined),
    },
  });
  const thread: Thread = {
    id: "candidate",
    projectId: project.id,
    title: "Candidate",
    agentKind: "codex",
    config: { model: "gpt-5" },
    status: "working",
    attention: "none",
    canResumeWithConfig: false,
    worktreePath: "/repo-wt",
    worktreeBranch: "feature",
    archived: false,
    done: false,
    starred: false,
    createdAt: project.createdAt,
    updatedAt: project.createdAt,
  };
  useAppStore.setState({
    projects: [project],
    threads: [thread],
    view: { kind: "thread", panes: [thread.id] },
  });
  useGitStore.getState().setWorktreeStatus("/repo-wt", summary);
  const hook = renderHook(() => useExperimentCandidateStats(args));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hook.result.current.stats).toEqual({ insertions: 1, deletions: 0, files: 1 });
    await act(async () => {
      const cycle = refreshGitProject(project, "watcher", "status");
      await vi.advanceTimersByTimeAsync(250);
      await cycle;
    });
    expect(hook.result.current.stats).toEqual({ insertions: 2, deletions: 0, files: 1 });
    await act(async () => {
      const cycles = Array.from({ length: 100 }, () =>
        refreshGitProject(project, "watcher", "status"),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.all(cycles);
    });
    expect(hook.result.current.stats).toEqual({ insertions: 3, deletions: 0, files: 1 });
    expect(gitWorktreeStatusBatch).toHaveBeenCalledTimes(2);
    expect(getExperimentCandidateStats).toHaveBeenCalledTimes(3);
    expect(getExperimentCandidateStats).toHaveBeenLastCalledWith({
      projectLocation: { kind: "posix", path: "/repo-wt" },
      baseRef: args.baseCommit,
      background: true,
    });
  } finally {
    hook.unmount();
  }
});

it("backs off failed automatic stats reads instead of retrying every 500 milliseconds", async () => {
  const getExperimentCandidateStats = vi
    .fn<PoracodeBridge["getExperimentCandidateStats"]>()
    .mockRejectedValue(new Error("busy"));
  Object.defineProperty(window, "poracode", {
    configurable: true,
    value: { getExperimentCandidateStats },
  });
  const hook = renderHook(() => useExperimentCandidateStats(args));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(getExperimentCandidateStats).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getExperimentCandidateStats).toHaveBeenCalledTimes(2);
  } finally {
    hook.unmount();
  }
});
