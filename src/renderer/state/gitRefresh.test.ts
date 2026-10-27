import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitStatusResult,
  GitProjectSnapshotResult,
  GitGetWorktreeSourceBranchResult,
  PrData,
  PrDetails,
  Project,
  ProjectLocation,
  Thread,
} from "@/shared/contracts";
import { useAppStore } from "./appStore";
import { useGitStore } from "./gitStore";
import { useExperimentStore } from "./experimentStore";
import { buildBranchPrKey } from "./gitSelectors";
import { usePanelStore } from "./panelStore";
import { useSidebarUiStore } from "./sidebarUiStore";
import { useDevTerminalStore } from "./devTerminalStore";
import { shouldPollProject } from "./wslBackgroundActivity";
import {
  cleanupGitRefreshProjects,
  getProjectActiveWorktreePaths,
  getWatcherRefreshMode,
  prefetchBranchPrData,
  prefetchVisibleGitPanelPrData,
  PR_PENDING_REFRESH_INTERVAL_MS,
  PR_POST_PUSH_STATUS_POLL_MS,
  refreshGitProject,
  refreshProjectStatusOnly,
  refreshGitWorktreePaths,
  stopPendingPrRefresh,
  startPostPushPrStatusRefresh,
  syncPendingPrRefreshProjects,
} from "./gitRefresh";

const ghGetPrForBranchMock =
  vi.fn<
    (payload: { projectLocation: ProjectLocation; branch: string }) => Promise<PrData | null>
  >();
const ghGetPrDetailsMock =
  vi.fn<
    (payload: {
      projectLocation: ProjectLocation;
      prNumber: number;
    }) => Promise<{ details: PrDetails }>
  >();
const checkPrWatchMock =
  vi.fn<(payload: { projectId: string; prNumber: number }) => Promise<void>>();
const ghListPrsMock =
  vi.fn<
    (payload: { projectLocation: ProjectLocation }) => Promise<{ prs: Record<string, PrData> }>
  >();

const location: ProjectLocation = { kind: "posix", path: "/repo" };
const wslLocation: ProjectLocation = {
  kind: "wsl",
  distro: "Ubuntu",
  linuxPath: "/repo",
  uncPath: "\\\\wsl.localhost\\Ubuntu\\repo",
};

const project: Project = {
  id: "p1",
  name: "Repo",
  location,
  createdAt: "2026-04-04T00:00:00.000Z",
};

const status: GitStatusResult = {
  isRepo: true,
  branch: "feature/pr-checks",
  tracking: "origin/feature/pr-checks",
  hasRemote: true,
  remoteInfo: {
    url: "https://github.com/owner/repo",
    platform: "github",
    owner: "owner",
    repo: "repo",
  },
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  totalInsertions: 0,
  totalDeletions: 0,
};

const basePr: PrData = {
  number: 42,
  state: "open",
  title: "Improve PR checks",
  url: "https://github.com/owner/repo/pull/42",
  baseBranch: "main",
  isDraft: false,
  checksStatus: "PENDING",
  updatedAt: "2026-04-04T00:00:00.000Z",
};

const baseDetails: PrDetails = {
  number: 42,
  title: "Improve PR checks",
  body: "",
  baseBranch: "main",
  headBranch: "feature/pr-checks",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  mergedAt: null,
  mergedBy: null,
  closedAt: null,
  commits: [],
  comments: [],
  reviews: [],
  checks: [{ name: "CI", state: "PENDING", conclusion: "" }],
};

const worktreeThread: Thread = {
  id: "t1",
  projectId: "p1",
  title: "Worktree thread",
  agentKind: "codex",
  config: { model: "gpt-5" },
  status: "idle",
  attention: "none",
  canResumeWithConfig: false,
  worktreePath: "/repo-wt",
  worktreeBranch: "feature/wt",
  archived: false,
  done: false,
  starred: false,
  createdAt: "2026-04-04T00:00:00.000Z",
  updatedAt: "2026-04-04T00:00:00.000Z",
};

const hiddenWorktreeThread: Thread = {
  ...worktreeThread,
  id: "t-hidden",
  title: "Hidden worktree thread",
  worktreePath: "/repo-hidden",
  worktreeBranch: "feature/hidden",
  createdAt: "2026-04-03T00:00:00.000Z",
  updatedAt: "2026-04-03T00:00:00.000Z",
};

describe("pending PR refresh", () => {
  it("stops WSL background polls for unloaded projects and resumes for loaded threads or terminals", () => {
    const wslProject = { ...project, location: wslLocation };
    useDevTerminalStore.setState({ isOpen: false, activeProjectId: null });
    expect(shouldPollProject(project)).toBe(true);
    expect(shouldPollProject(wslProject)).toBe(false);
    useAppStore.setState({ threads: [{ ...worktreeThread, status: "inactive" }] });
    expect(shouldPollProject(wslProject)).toBe(false);
    useAppStore.setState({ threads: [worktreeThread] });
    expect(shouldPollProject(wslProject)).toBe(true);
    useAppStore.setState({ threads: [{ ...worktreeThread, projectId: "other" }] });
    expect(shouldPollProject(wslProject)).toBe(false);
    useDevTerminalStore.setState({ isOpen: true, activeProjectId: project.id });
    expect(shouldPollProject(wslProject)).toBe(true);
    useDevTerminalStore.setState({ isOpen: false, activeProjectId: null });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    ghGetPrForBranchMock.mockReset();
    ghGetPrDetailsMock.mockReset();
    checkPrWatchMock.mockReset();
    ghListPrsMock.mockReset();
    checkPrWatchMock.mockResolvedValue(undefined);
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        dbSetState: vi
          .fn<(key: string, value: string) => Promise<void>>()
          .mockResolvedValue(undefined),
        ghGetPrForBranch: ghGetPrForBranchMock,
        ghGetPrDetails: ghGetPrDetailsMock,
        checkPrWatch: checkPrWatchMock,
        ghListPrs: ghListPrsMock,
      },
    });
    useGitStore.setState({
      statuses: {},
      worktreeStatuses: {},
      worktrees: {},
      branches: {},
      ghAvailable: {},
      prData: {},
      worktreeSourceInfo: {},
      prDetails: {},
      prFiles: {},
      prDiffs: {},
    });
    usePanelStore.setState({
      gitReviewContext: null,
      gitReviewAsPanel: false,
      filesPanelContext: null,
      rightPanelTab: "git",
      threadSortMode: "updated",
    });
    useSidebarUiStore.setState({
      collapsedProjects: {},
      collapsedWorktrees: {},
      threadListLimits: {},
    });
    useAppStore.setState({
      projects: [project],
      threads: [],
      view: { kind: "thread", panes: ["t1"] },
    });
    useExperimentStore.setState({ experiments: {} });
  });

  afterEach(() => {
    stopPendingPrRefresh();
    vi.useRealTimers();
  });

  it("maps one bulk PR query to all thread worktrees and reapplies its cache", async () => {
    const bulkProject = { ...project, id: "bulk-p1" };
    const visibleThread = {
      ...worktreeThread,
      id: "bulk-visible",
      projectId: bulkProject.id,
      worktreePath: "/repo-visible",
      worktreeBranch: "feature/visible",
    };
    const hiddenThread = {
      ...worktreeThread,
      id: "bulk-hidden",
      projectId: bulkProject.id,
      worktreePath: "/repo-hidden",
      worktreeBranch: "feature/hidden",
    };
    const visiblePr = { ...basePr, number: 101, checksStatus: "SUCCESS" as const };
    const hiddenPr = { ...basePr, number: 102, state: "merged" as const };
    const mainPr = { ...basePr, number: 103, checksStatus: "FAILURE" as const };

    useAppStore.setState({ projects: [bulkProject], threads: [visibleThread] });
    useGitStore.setState({
      statuses: { [bulkProject.id]: { ...status, branch: "feature/main" } },
      ghAvailable: { [bulkProject.id]: true },
      prData: {
        "/repo-visible": {
          ...basePr,
          number: 101,
          viewerDidAuthor: true,
          updatedAt: "2026-04-03T00:00:00.000Z",
        },
      },
    });
    ghListPrsMock.mockResolvedValue({
      prs: {
        "feature/visible": visiblePr,
        "feature/hidden": hiddenPr,
        "feature/main": mainPr,
      },
    });

    await prefetchBranchPrData(bulkProject);

    expect(ghListPrsMock).toHaveBeenCalledOnce();
    expect(useGitStore.getState().prData["/repo-visible"]).toEqual({
      ...visiblePr,
      viewerDidAuthor: true,
    });
    expect(useGitStore.getState().prData[buildBranchPrKey(bulkProject.id)]).toEqual(mainPr);

    useGitStore.getState().setPrData("/repo-visible", {
      ...visiblePr,
      state: "merged",
      updatedAt: "2026-04-05T00:00:00.000Z",
      viewerDidAuthor: true,
    });
    useAppStore.setState({ threads: [visibleThread, hiddenThread] });
    await prefetchBranchPrData(bulkProject);

    expect(ghListPrsMock).toHaveBeenCalledOnce();
    expect(useGitStore.getState().prData["/repo-hidden"]).toEqual(hiddenPr);
    expect(useGitStore.getState().prData["/repo-visible"]?.state).toBe("merged");
  });

  it("prefetches for a matching visible Git panel only when gh and GitHub are available", async () => {
    const visibleProject = { ...project, id: "visible-git-project" };
    useAppStore.setState({ projects: [visibleProject] });
    usePanelStore.setState({
      gitReviewContext: { projectId: visibleProject.id, worktreePath: "/repo-visible" },
      gitReviewAsPanel: true,
    });
    ghListPrsMock.mockResolvedValue({ prs: {} });

    await prefetchVisibleGitPanelPrData(visibleProject.id, "/another-worktree");
    expect(ghListPrsMock).not.toHaveBeenCalled();

    useGitStore.setState({
      ghAvailable: { [visibleProject.id]: false },
      statuses: { [visibleProject.id]: status },
    });
    await prefetchVisibleGitPanelPrData(visibleProject.id, "/repo-visible");
    expect(ghListPrsMock).not.toHaveBeenCalled();

    useGitStore.setState({
      ghAvailable: { [visibleProject.id]: true },
      statuses: {
        [visibleProject.id]: {
          ...status,
          remoteInfo: { ...status.remoteInfo!, platform: "gitlab" },
        },
      },
    });
    await prefetchVisibleGitPanelPrData(visibleProject.id, "/repo-visible");
    expect(ghListPrsMock).not.toHaveBeenCalled();

    useGitStore.setState({ statuses: { [visibleProject.id]: status } });
    await prefetchVisibleGitPanelPrData(visibleProject.id, "/repo-visible");
    expect(ghListPrsMock).toHaveBeenCalledOnce();
  });

  it("keeps older sidebar PRs current when they fall outside the bulk list", async () => {
    const olderProject = { ...project, id: "older-p1" };
    useAppStore.setState({
      projects: [olderProject],
      threads: [{ ...worktreeThread, projectId: olderProject.id }],
      view: { kind: "home" },
    });
    useGitStore.setState({
      ghAvailable: { [olderProject.id]: true },
      statuses: { [olderProject.id]: status },
      // A persisted negative entry from a previous app run is not a fresh read.
      prData: { "/repo-wt": null },
    });
    ghListPrsMock.mockResolvedValue({ prs: {} });
    ghGetPrForBranchMock.mockResolvedValue({
      ...basePr,
      state: "closed",
      updatedAt: "2026-04-05T00:00:00Z",
    });
    await prefetchBranchPrData(olderProject);
    expect(useGitStore.getState().prData["/repo-wt"]?.state).toBe("closed");
    await vi.advanceTimersByTimeAsync(300_001);
    ghGetPrForBranchMock.mockResolvedValue({
      ...basePr,
      state: "merged",
      updatedAt: "2026-04-06T00:00:00Z",
    });
    await prefetchBranchPrData(olderProject);
    expect(useGitStore.getState().prData["/repo-wt"]?.state).toBe("merged");
    expect(ghGetPrForBranchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["open", "merged"] as const)(
    "bounds and caches %s PR fallback queries outside the bulk list",
    async (prState) => {
      const id = `ttl-${prState}`;
      const threads = Array.from({ length: 6 }, (_, i) => ({
        ...worktreeThread,
        id: `${id}-${i}`,
        projectId: id,
        worktreePath: `/${id}/${i}`,
        worktreeBranch: `older/${i}`,
      }));
      useAppStore.setState({ projects: [{ ...project, id }], threads, view: { kind: "home" } });
      useGitStore.setState({
        statuses: { [id]: status },
        ghAvailable: { [id]: true },
        prData: Object.fromEntries(
          threads.map((thread) => [thread.worktreePath, { ...basePr, state: prState }]),
        ),
      });
      ghListPrsMock.mockImplementation(async () => ({ prs: {} }));
      let active = 0;
      let maximum = 0;
      ghGetPrForBranchMock.mockImplementation(async () => {
        maximum = Math.max(maximum, ++active);
        await Promise.resolve();
        active--;
        return { ...basePr, state: prState };
      });
      const target = { ...project, id };
      await prefetchBranchPrData(target);
      expect(maximum).toBeLessThanOrEqual(3);
      await vi.advanceTimersByTimeAsync(15_000);
      await prefetchBranchPrData(target);
      expect(ghGetPrForBranchMock).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(prState === "open" ? 60_001 : 300_001);
      await prefetchBranchPrData(target);
      expect(ghGetPrForBranchMock).toHaveBeenCalledTimes(12);
    },
  );

  it("keeps running experiment worktrees active when the project and group are collapsed", () => {
    useSidebarUiStore.setState({ collapsedProjects: { [project.id]: true } });
    useAppStore.setState({
      threads: [
        {
          ...worktreeThread,
          id: "candidate-1",
          worktreePath: "/repo/experiment-one",
          worktreeBranch: "poracode/one",
        },
        {
          ...worktreeThread,
          id: "candidate-2",
          worktreePath: "/repo/experiment-two",
          worktreeBranch: "poracode/two",
        },
      ],
    });
    useExperimentStore.getState().addExperiment({
      id: "experiment-1",
      projectId: project.id,
      title: "Experiment",
      prompt: "Implement it",
      baseBranch: "main",
      baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      candidates: [
        {
          threadId: "candidate-1",
          agentKind: "codex",
          worktreePath: "/repo/experiment-one",
          worktreeBranch: "poracode/one",
          worktreeOwnerToken: "experiment-1:candidate-1",
          worktreeState: "owned",
        },
        {
          threadId: "candidate-2",
          agentKind: "codex",
          worktreePath: "/repo/experiment-two",
          worktreeBranch: "poracode/two",
          worktreeOwnerToken: "experiment-1:candidate-2",
          worktreeState: "owned",
        },
      ],
      status: "running",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });

    expect(getProjectActiveWorktreePaths(project.id)).toEqual([
      "/repo/experiment-one",
      "/repo/experiment-two",
    ]);
  });

  it("refetches pending PR status until it leaves pending", async () => {
    const prKey = buildBranchPrKey("p1");
    useGitStore.getState().setStatus("p1", status);
    useGitStore.getState().setPrData(prKey, basePr);
    useGitStore.getState().setPrDetails("p1#42", baseDetails);
    ghGetPrForBranchMock
      .mockResolvedValueOnce({
        ...basePr,
        checksStatus: "PENDING",
        updatedAt: "2026-04-04T00:00:30.000Z",
      })
      .mockResolvedValueOnce({
        ...basePr,
        checksStatus: "SUCCESS",
        updatedAt: "2026-04-04T00:01:00.000Z",
      });
    ghGetPrDetailsMock.mockResolvedValueOnce({ details: baseDetails }).mockResolvedValueOnce({
      details: {
        ...baseDetails,
        checks: [{ name: "CI", state: "COMPLETED", conclusion: "SUCCESS" }],
      },
    });

    syncPendingPrRefreshProjects([{ id: "p1", location }]);

    expect(ghGetPrForBranchMock).toHaveBeenCalledWith({
      projectLocation: location,
      branch: "feature/pr-checks",
    });
    expect(ghGetPrDetailsMock).toHaveBeenCalledWith({ projectLocation: location, prNumber: 42 });

    ghGetPrForBranchMock.mockClear();
    ghGetPrDetailsMock.mockClear();

    await vi.advanceTimersByTimeAsync(PR_PENDING_REFRESH_INTERVAL_MS);

    expect(ghGetPrForBranchMock).toHaveBeenCalledWith({
      projectLocation: location,
      branch: "feature/pr-checks",
    });
    expect(ghGetPrDetailsMock).toHaveBeenCalledWith({ projectLocation: location, prNumber: 42 });
    expect(useGitStore.getState().prData[prKey]?.checksStatus).toBe("SUCCESS");
    expect(useGitStore.getState().prDetails["p1#42"]?.checks[0]?.conclusion).toBe("SUCCESS");
    expect(checkPrWatchMock).toHaveBeenCalledOnce();
    expect(checkPrWatchMock).toHaveBeenCalledWith({ projectId: "p1", prNumber: 42 });

    ghGetPrForBranchMock.mockClear();
    ghGetPrDetailsMock.mockClear();
    await vi.advanceTimersByTimeAsync(PR_PENDING_REFRESH_INTERVAL_MS);

    expect(ghGetPrForBranchMock).not.toHaveBeenCalled();
    expect(ghGetPrDetailsMock).not.toHaveBeenCalled();
    expect(checkPrWatchMock).toHaveBeenCalledOnce();
  });

  it("polls when the PR summary is stale failed but loaded check details are pending", async () => {
    const prKey = buildBranchPrKey("p1");
    useGitStore.getState().setStatus("p1", status);
    useGitStore.getState().setPrData(prKey, { ...basePr, checksStatus: "FAILURE" });
    useGitStore.getState().setPrDetails("p1#42", baseDetails);
    ghGetPrForBranchMock.mockResolvedValue({ ...basePr, checksStatus: "PENDING" });
    ghGetPrDetailsMock.mockResolvedValue({ details: baseDetails });

    syncPendingPrRefreshProjects([{ id: "p1", location }]);

    expect(ghGetPrForBranchMock).toHaveBeenCalledWith({
      projectLocation: location,
      branch: "feature/pr-checks",
    });
    expect(ghGetPrDetailsMock).toHaveBeenCalledWith({ projectLocation: location, prNumber: 42 });
  });

  it("pauses pending PR polling on WSL unload and resumes when a thread loads", async () => {
    const wslProject = { ...project, location: wslLocation };
    useAppStore.setState({ projects: [wslProject], threads: [worktreeThread] });
    useGitStore.getState().setStatus("p1", status);
    useGitStore.getState().setPrData(buildBranchPrKey("p1"), basePr);
    ghGetPrForBranchMock.mockResolvedValue(basePr);
    ghGetPrDetailsMock.mockResolvedValue({ details: baseDetails });
    syncPendingPrRefreshProjects([wslProject]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ghGetPrForBranchMock).toHaveBeenCalled();
    useAppStore.setState({ threads: [{ ...worktreeThread, status: "inactive" }] });
    syncPendingPrRefreshProjects([wslProject]);
    ghGetPrForBranchMock.mockClear();
    await vi.advanceTimersByTimeAsync(2 * PR_PENDING_REFRESH_INTERVAL_MS);
    expect(ghGetPrForBranchMock).not.toHaveBeenCalled();
    useAppStore.setState({ threads: [worktreeThread] });
    syncPendingPrRefreshProjects([wslProject]);
    expect(ghGetPrForBranchMock).toHaveBeenCalled();
  });

  it("stops polling when the worktree thread is removed", async () => {
    useAppStore.setState({ threads: [worktreeThread] });
    useGitStore.getState().setPrData("/repo-wt", basePr);
    ghGetPrForBranchMock.mockResolvedValue({ ...basePr, checksStatus: "PENDING" });
    ghGetPrDetailsMock.mockResolvedValue({ details: baseDetails });

    syncPendingPrRefreshProjects([{ id: "p1", location }]);

    expect(ghGetPrForBranchMock).toHaveBeenCalledWith({
      projectLocation: location,
      branch: "feature/wt",
    });

    ghGetPrForBranchMock.mockClear();
    useAppStore.setState({ threads: [] });
    syncPendingPrRefreshProjects([{ id: "p1", location }]);
    await vi.advanceTimersByTimeAsync(PR_PENDING_REFRESH_INTERVAL_MS);

    expect(ghGetPrForBranchMock).not.toHaveBeenCalled();
  });

  it("does not poll pending PR checks for worktree threads hidden behind See more", async () => {
    useSidebarUiStore.setState({ threadListLimits: { p1: 1 } });
    useAppStore.setState({ threads: [worktreeThread, hiddenWorktreeThread] });
    useGitStore.getState().setPrData("/repo-wt", basePr);
    useGitStore.getState().setPrData("/repo-hidden", { ...basePr, number: 43 });
    ghGetPrForBranchMock.mockResolvedValue({ ...basePr, checksStatus: "PENDING" });
    ghGetPrDetailsMock.mockResolvedValue({ details: baseDetails });

    syncPendingPrRefreshProjects([{ id: "p1", location }]);

    expect(ghGetPrForBranchMock).toHaveBeenCalledTimes(1);
    expect(ghGetPrForBranchMock).toHaveBeenCalledWith({
      projectLocation: location,
      branch: "feature/wt",
    });
  });

  it("does not poll orphaned pending PR details", async () => {
    useGitStore.getState().setPrDetails("p1#42", baseDetails);

    syncPendingPrRefreshProjects([{ id: "p1", location }]);

    expect(ghGetPrForBranchMock).not.toHaveBeenCalled();
    expect(ghGetPrDetailsMock).not.toHaveBeenCalled();
  });

  it("checks pushed open PR for pending status during the post-push grace period", async () => {
    const prKey = buildBranchPrKey("p1");
    useGitStore.getState().setStatus("p1", status);
    useGitStore.getState().setPrData(prKey, { ...basePr, checksStatus: "SUCCESS" });
    ghGetPrForBranchMock
      .mockResolvedValueOnce({
        ...basePr,
        checksStatus: "SUCCESS",
        updatedAt: "2026-04-04T00:00:30.000Z",
      })
      .mockResolvedValueOnce({
        ...basePr,
        checksStatus: "PENDING",
        updatedAt: "2026-04-04T00:01:00.000Z",
      });

    startPostPushPrStatusRefresh({
      projectId: "p1",
      projectLocation: location,
      prKey,
      branch: "feature/pr-checks",
    });

    expect(ghGetPrForBranchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PR_POST_PUSH_STATUS_POLL_MS);

    expect(ghGetPrForBranchMock).toHaveBeenCalledTimes(1);
    expect(useGitStore.getState().prData[prKey]?.checksStatus).toBe("SUCCESS");

    await vi.advanceTimersByTimeAsync(PR_POST_PUSH_STATUS_POLL_MS);

    expect(ghGetPrForBranchMock).toHaveBeenCalledTimes(2);
    expect(useGitStore.getState().prData[prKey]?.checksStatus).toBe("PENDING");

    await vi.advanceTimersByTimeAsync(PR_POST_PUSH_STATUS_POLL_MS);

    expect(ghGetPrForBranchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps checking pushed green or red PRs for 15 seconds before stopping", async () => {
    const prKey = buildBranchPrKey("p1");
    useGitStore.getState().setStatus("p1", status);
    useGitStore.getState().setPrData(prKey, { ...basePr, checksStatus: "FAILURE" });
    ghGetPrForBranchMock
      .mockResolvedValueOnce({
        ...basePr,
        checksStatus: "FAILURE",
        updatedAt: "2026-04-04T00:00:30.000Z",
      })
      .mockResolvedValueOnce({
        ...basePr,
        checksStatus: "SUCCESS",
        updatedAt: "2026-04-04T00:01:00.000Z",
      })
      .mockResolvedValueOnce({
        ...basePr,
        checksStatus: "SUCCESS",
        updatedAt: "2026-04-04T00:01:30.000Z",
      });

    startPostPushPrStatusRefresh({
      projectId: "p1",
      projectLocation: location,
      prKey,
      branch: "feature/pr-checks",
    });

    await vi.advanceTimersByTimeAsync(PR_POST_PUSH_STATUS_POLL_MS * 3);

    expect(ghGetPrForBranchMock).toHaveBeenCalledTimes(3);
    expect(useGitStore.getState().prData[prKey]?.checksStatus).toBe("SUCCESS");

    await vi.advanceTimersByTimeAsync(PR_POST_PUSH_STATUS_POLL_MS);

    expect(ghGetPrForBranchMock).toHaveBeenCalledTimes(3);
  });
});

describe("watcher git status refresh", () => {
  beforeEach(() => {
    cleanupGitRefreshProjects(new Set());
    useGitStore.setState({
      statuses: {},
      worktreeStatuses: {},
      worktrees: {},
      branches: {},
      ghAvailable: {},
      prData: {},
      worktreeSourceInfo: {},
      prDetails: {},
      prFiles: {},
      prDiffs: {},
    });
    usePanelStore.setState({
      gitReviewContext: null,
      gitReviewAsPanel: false,
      filesPanelContext: null,
      rightPanelTab: "git",
      threadSortMode: "updated",
    });
    useSidebarUiStore.setState({
      collapsedProjects: {},
      collapsedWorktrees: {},
      threadListLimits: {},
    });
    useAppStore.setState({
      projects: [project],
      threads: [],
      view: { kind: "thread", panes: ["t1"] },
    });
  });

  afterEach(() => {
    cleanupGitRefreshProjects(new Set());
  });

  it("polls only open worktrees, not forty expanded sidebar rows", () => {
    const threads = Array.from({ length: 40 }, (_, i) => ({
      ...worktreeThread,
      id: `t${i}`,
      worktreePath: `/wt/${i}`,
    }));
    useSidebarUiStore.setState({ threadListLimits: { p1: 100 } });
    useAppStore.setState({ threads, view: { kind: "thread", panes: ["t0", "t1"] } });
    expect(getProjectActiveWorktreePaths("p1")).toEqual(["/wt/0", "/wt/1"]);
  });

  it("awaits its own fresh manual read without waiting for later watcher cycles", async () => {
    let finishPoll!: (value: GitStatusResult) => void;
    const getGitStatus = vi
      .fn<() => Promise<GitStatusResult>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPoll = resolve;
          }),
      )
      .mockResolvedValue(status);
    Object.defineProperty(window, "poracode", { configurable: true, value: { getGitStatus } });
    const poll = refreshGitProject(project, "watcher", "status");
    await refreshGitProject(project, "manual", "status");
    expect(getGitStatus).toHaveBeenCalledTimes(2);
    expect(useGitStore.getState().statuses.p1).toEqual(status);
    finishPoll({ ...status, branch: "old" });
    await poll;
    expect(useGitStore.getState().statuses.p1?.branch).toBe(status.branch);
  });

  it("coalesces repeated manual clicks into one fresh trailing read", async () => {
    const first = Promise.withResolvers<GitStatusResult>();
    const fresh = { ...status, branch: "after-click" };
    const getGitStatus = vi
      .fn<() => Promise<GitStatusResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(fresh);
    Object.defineProperty(window, "poracode", { configurable: true, value: { getGitStatus } });
    const initial = refreshGitProject(project, "manual", "status");
    const clicks = Array.from({ length: 8 }, () => refreshGitProject(project, "manual", "status"));
    expect(getGitStatus).toHaveBeenCalledTimes(1);
    first.resolve(status);
    await Promise.all([initial, ...clicks]);
    expect(getGitStatus).toHaveBeenCalledTimes(2);
    expect(useGitStore.getState().statuses.p1?.branch).toBe("after-click");
  });

  it("does not let a slow independent watcher overwrite a manual project snapshot", async () => {
    const watcher = Promise.withResolvers<GitStatusResult>();
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        getGitStatus: () => watcher.promise,
        gitProjectSnapshot: async () => ({
          status: { ...status, branch: "after-commit" },
          worktrees: [],
          ghAvailable: false,
        }),
        gitWatchWorktrees: async () => undefined,
      },
    });
    const pending = refreshProjectStatusOnly(project, "watcher", () => true);
    await refreshGitProject(project, "manual", "full");
    watcher.resolve(status);
    await pending;
    expect(useGitStore.getState().statuses.p1?.branch).toBe("after-commit");
  });

  it("keeps branch and worktree snapshot fields when a newer watcher status finishes first", async () => {
    const snapshot = Promise.withResolvers<GitProjectSnapshotResult>();
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        getGitStatus: async () => ({ ...status, branch: "newer" }),
        gitProjectSnapshot: () => snapshot.promise,
        gitWatchWorktrees: async () => undefined,
      },
    });
    const manual = refreshGitProject(project, "manual", "full");
    await refreshProjectStatusOnly(project, "watcher", () => true);
    const branches = { current: "main", branches: [] };
    snapshot.resolve({ status, branches, worktrees: [], ghAvailable: false });
    await manual;
    expect(useGitStore.getState().branches.p1).toEqual(branches);
    expect(useGitStore.getState().worktrees.p1).toEqual([]);
    expect(useGitStore.getState().statuses.p1?.branch).toBe("newer");
  });

  it("coalesces repeated full manual snapshots into one fresh trailing snapshot", async () => {
    const initial = Promise.withResolvers<{ status: GitStatusResult }>();
    const gitProjectSnapshot = vi
      .fn<() => Promise<Partial<GitProjectSnapshotResult>>>()
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValue({ status, worktrees: [], ghAvailable: false });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        gitProjectSnapshot,
        gitWatchWorktrees: async () => undefined,
      },
    });
    const first = refreshGitProject(project, "manual", "full");
    const clicks = Array.from({ length: 8 }, () => refreshGitProject(project, "manual", "full"));
    expect(gitProjectSnapshot).toHaveBeenCalledTimes(1);
    initial.resolve({ status });
    await Promise.all([first, ...clicks]);
    expect(gitProjectSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not let an older background source read overwrite fresh manual counts", async () => {
    useAppStore.setState({ threads: [worktreeThread] });
    const old = Promise.withResolvers<{
      sourceBranch: string;
      commitsAhead: number;
      sourceAhead: number;
    }>();
    const fresh = { sourceBranch: "main", commitsAhead: 3, sourceAhead: 0 };
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        getGitStatus: async () => status,
        gitWorktreeStatusBatch: async () => ({ statuses: {} }),
        gitGetWorktreeSourceBranch: vi
          .fn<() => Promise<GitGetWorktreeSourceBranchResult>>()
          .mockReturnValueOnce(old.promise)
          .mockResolvedValue(fresh),
      },
    });
    const background = refreshGitWorktreePaths(project, ["/repo-wt"], () => true);
    await refreshGitProject(project, "manual", "status");
    old.resolve({ ...fresh, commitsAhead: 2 });
    await background;
    expect(useGitStore.getState().worktreeSourceInfo["/repo-wt"]?.commitsAhead).toBe(3);
  });

  it("arbitrates source counts when a background batch is delayed by another path", async () => {
    useAppStore.setState({ threads: [worktreeThread, hiddenWorktreeThread] });
    const slow = Promise.withResolvers<GitGetWorktreeSourceBranchResult>();
    const older = { sourceBranch: "main", commitsAhead: 2, sourceAhead: 0 };
    const gitGetWorktreeSourceBranch = vi
      .fn<() => Promise<GitGetWorktreeSourceBranchResult>>()
      .mockResolvedValueOnce(older)
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue({ ...older, commitsAhead: 3 });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        getGitStatus: async () => status,
        gitWorktreeStatusBatch: async () => ({ statuses: {} }),
        gitGetWorktreeSourceBranch,
      },
    });
    const background = refreshGitWorktreePaths(project, ["/repo-wt", "/repo-hidden"], () => true);
    await vi.waitFor(() => expect(gitGetWorktreeSourceBranch).toHaveBeenCalledTimes(2));
    await refreshGitProject(project, "manual", "status", { worktreePaths: ["/repo-wt"] });
    slow.resolve(older);
    await background;
    expect(useGitStore.getState().worktreeSourceInfo["/repo-wt"]?.commitsAhead).toBe(3);
  });

  it("loads sidebar status and source counts on manual refresh and reveal", async () => {
    useAppStore.setState({ threads: [worktreeThread], view: { kind: "home" } });
    const gitWorktreeStatusBatch = vi
      .fn<() => Promise<{ statuses: Record<string, GitStatusResult> }>>()
      .mockResolvedValue({ statuses: { "/repo-wt": status } });
    const gitGetWorktreeSourceBranch = vi
      .fn<() => Promise<{ sourceBranch: string; commitsAhead: number; sourceAhead: number }>>()
      .mockResolvedValue({ sourceBranch: "main", commitsAhead: 4, sourceAhead: 2 });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        getGitStatus: async () => status,
        gitWorktreeStatusBatch,
        gitGetWorktreeSourceBranch,
        gitWatchWorktrees: async () => undefined,
      },
    });
    await refreshGitProject(project, "manual", "status");
    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: location,
      worktreePaths: ["/repo-wt"],
      detail: "full",
    });
    expect(useGitStore.getState().worktreeSourceInfo["/repo-wt"]?.commitsAhead).toBe(4);
  });

  it("refreshes exact counts for a changed sidebar worktree without polling unrelated rows", async () => {
    useAppStore.setState({
      threads: [worktreeThread, hiddenWorktreeThread],
      view: { kind: "home" },
    });
    const getGitStatus = vi.fn<() => Promise<GitStatusResult>>().mockResolvedValue(status);
    let insertions = 3;
    const gitWorktreeStatusBatch = vi
      .fn<() => Promise<{ statuses: Record<string, GitStatusResult> }>>()
      .mockImplementation(async () => ({
        statuses: {
          "/repo-hidden": {
            ...status,
            totalInsertions: insertions,
            unstaged: [{ path: "file.ts", status: "M", staged: false, insertions, deletions: 0 }],
          },
        },
      }));
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: { getGitStatus, gitWorktreeStatusBatch },
    });
    const options = { worktreePaths: ["/repo-hidden"], includeProjectStatus: false };
    await refreshGitProject(project, "watcher", "status", options);
    insertions = 9;
    await refreshGitProject(project, "watcher", "status", options);
    expect(getGitStatus).not.toHaveBeenCalled();
    expect(gitWorktreeStatusBatch).toHaveBeenLastCalledWith({
      projectLocation: location,
      worktreePaths: ["/repo-hidden"],
      detail: "full",
    });
    expect(useGitStore.getState().worktreeStatuses["/repo-hidden"]?.totalInsertions).toBe(9);
  });

  it("finishes a manual refresh while its queued watcher read remains unfinished", async () => {
    const manualResult = Promise.withResolvers<GitStatusResult>();
    const watcherResult = Promise.withResolvers<GitStatusResult>();
    const getGitStatus = vi
      .fn<() => Promise<GitStatusResult>>()
      .mockReturnValueOnce(manualResult.promise)
      .mockReturnValue(watcherResult.promise);
    Object.defineProperty(window, "poracode", { configurable: true, value: { getGitStatus } });
    const manual = refreshGitProject(project, "manual", "status");
    for (let i = 0; i < 20; i++) await refreshGitProject(project, "watcher", "status");
    manualResult.resolve(status);
    await manual;
    expect(getGitStatus).toHaveBeenCalledTimes(2);
    watcherResult.resolve(status);
    await Promise.resolve();
  });

  it("does not let a periodic fetch refresh supersede a manual status read", async () => {
    const result = Promise.withResolvers<GitStatusResult>();
    const getGitStatus = vi.fn<() => Promise<GitStatusResult>>().mockReturnValue(result.promise);
    const snapshot = Promise.withResolvers<{ status: GitStatusResult }>();
    const gitProjectSnapshot = vi
      .fn<() => Promise<{ status: GitStatusResult }>>()
      .mockReturnValue(snapshot.promise);
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: { getGitStatus, gitProjectSnapshot },
    });
    const manual = refreshGitProject(project, "manual", "status");
    await refreshGitProject(project, "fetch", "full");
    expect(gitProjectSnapshot).not.toHaveBeenCalled();
    result.resolve(status);
    await manual;
    expect(useGitStore.getState().statuses.p1).toEqual(status);
    expect(gitProjectSnapshot).toHaveBeenCalledOnce();
    cleanupGitRefreshProjects(new Set());
    snapshot.resolve({ status });
  });

  it("drains one queued full watcher refresh even when the directory remains non-repo", async () => {
    vi.useFakeTimers();
    const first = Promise.withResolvers<{ status: GitStatusResult }>();
    const unexpected = Promise.withResolvers<{ status: GitStatusResult }>();
    const nonRepo = { status: { ...status, isRepo: false } };
    const gitProjectSnapshot = vi
      .fn<() => Promise<{ status: GitStatusResult }>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(nonRepo)
      .mockReturnValue(unexpected.promise);
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: { gitProjectSnapshot },
    });
    try {
      const initial = refreshGitProject(project, "initial", "full");
      await refreshGitProject(project, "watcher", "full");
      first.resolve(nonRepo);
      await initial;
      await vi.advanceTimersByTimeAsync(0);
      expect(gitProjectSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      cleanupGitRefreshProjects(new Set());
      unexpected.resolve(nonRepo);
      vi.useRealTimers();
    }
  });

  it("refreshes thread worktree statuses before the full worktree cache catches up", async () => {
    const getGitStatus = vi.fn<() => Promise<GitStatusResult>>().mockResolvedValue(status);
    const worktreeStatus: GitStatusResult = {
      ...status,
      branch: "feature/wt",
      unstaged: [
        {
          path: "src/changed.ts",
          status: "M",
          staged: false,
          insertions: 3,
          deletions: 1,
        },
      ],
      totalInsertions: 3,
      totalDeletions: 1,
    };
    const gitWorktreeStatusBatch = vi
      .fn<
        (payload: {
          projectLocation: ProjectLocation;
          worktreePaths: string[];
        }) => Promise<{ statuses: Record<string, GitStatusResult> }>
      >()
      .mockResolvedValue({ statuses: { "/repo-wt": worktreeStatus } });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        getGitStatus,
        gitWorktreeStatusBatch,
      },
    });
    useGitStore.getState().setWorktrees("p1", [
      {
        path: "/repo",
        branch: "main",
        commit: "abc123",
        isMain: true,
      },
      {
        path: "/repo-old",
        branch: "feature/old",
        commit: "abc123",
        isMain: false,
      },
    ]);
    useSidebarUiStore.setState({ threadListLimits: { p1: 1 } });
    useAppStore.setState({ threads: [worktreeThread, hiddenWorktreeThread] });

    await refreshGitProject(project, "watcher", "status");

    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: location,
      worktreePaths: ["/repo-wt"],
      detail: "full",
    });
    expect(useGitStore.getState().worktreeStatuses["/repo-wt"]).toEqual(worktreeStatus);
  });

  it("escalates a summary poll to a full refresh when a file was staged externally", async () => {
    // Previously the file was unstaged/modified with real counts...
    const previousWorktreeStatus: GitStatusResult = {
      ...status,
      branch: "feature/wt",
      unstaged: [
        { path: "src/changed.ts", status: "M", staged: false, insertions: 5, deletions: 1 },
      ],
      totalInsertions: 5,
      totalDeletions: 1,
    };
    // A summary poll now reports it staged (an external `git add`) with 0/0 —
    // no backfill key matches, so the counts can't be recovered from cache.
    const summaryWorktreeStatus: GitStatusResult = {
      ...status,
      detail: "summary",
      branch: "feature/wt",
      staged: [{ path: "src/changed.ts", status: "M", staged: true, insertions: 0, deletions: 0 }],
      unstaged: [],
      totalInsertions: 0,
      totalDeletions: 0,
    };
    // The follow-up full refresh recovers the real cumulative counts.
    const fullWorktreeStatus: GitStatusResult = {
      ...status,
      branch: "feature/wt",
      staged: [{ path: "src/changed.ts", status: "M", staged: true, insertions: 5, deletions: 1 }],
      unstaged: [],
      totalInsertions: 5,
      totalDeletions: 1,
    };
    const getGitStatus = vi.fn<() => Promise<GitStatusResult>>().mockResolvedValue(status);
    const gitWorktreeStatusBatch = vi
      .fn<
        (payload: {
          projectLocation: ProjectLocation;
          worktreePaths: string[];
          detail?: "summary" | "full";
        }) => Promise<{ statuses: Record<string, GitStatusResult> }>
      >()
      .mockImplementation(async ({ detail }) => ({
        statuses: {
          "/repo-wt": detail === "full" ? fullWorktreeStatus : summaryWorktreeStatus,
        },
      }));
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: { platform: "darwin", getGitStatus, gitWorktreeStatusBatch },
    });
    useGitStore.getState().setWorktreeStatus("/repo-wt", previousWorktreeStatus);
    useAppStore.setState({ threads: [worktreeThread] });

    await refreshGitProject(project, "poll", "status");
    // The escalation fires fire-and-forget after the poll resolves — flush it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: location,
      worktreePaths: ["/repo-wt"],
      detail: "summary",
    });
    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: location,
      worktreePaths: ["/repo-wt"],
      detail: "full",
    });
    expect(useGitStore.getState().worktreeStatuses["/repo-wt"]).toEqual(fullWorktreeStatus);
  });

  it("retries summary-to-full escalation after a transient full refresh failure", async () => {
    const previousWorktreeStatus: GitStatusResult = {
      ...status,
      branch: "feature/wt",
      unstaged: [
        { path: "src/changed.ts", status: "M", staged: false, insertions: 5, deletions: 1 },
      ],
      totalInsertions: 5,
      totalDeletions: 1,
    };
    const summaryWorktreeStatus: GitStatusResult = {
      ...status,
      detail: "summary",
      branch: "feature/wt",
      staged: [{ path: "src/changed.ts", status: "M", staged: true, insertions: 0, deletions: 0 }],
      unstaged: [],
      totalInsertions: 0,
      totalDeletions: 0,
    };
    const fullWorktreeStatus: GitStatusResult = {
      ...status,
      branch: "feature/wt",
      staged: [{ path: "src/changed.ts", status: "M", staged: true, insertions: 5, deletions: 1 }],
      unstaged: [],
      totalInsertions: 5,
      totalDeletions: 1,
    };
    const getGitStatus = vi.fn<() => Promise<GitStatusResult>>().mockResolvedValue(status);
    let fullAttempts = 0;
    const gitWorktreeStatusBatch = vi
      .fn<
        (payload: {
          projectLocation: ProjectLocation;
          worktreePaths: string[];
          detail?: "summary" | "full";
        }) => Promise<{ statuses: Record<string, GitStatusResult> }>
      >()
      .mockImplementation(async ({ detail }) => {
        if (detail === "full") {
          fullAttempts += 1;
          if (fullAttempts === 1) throw new Error("bridge unavailable");
          return { statuses: { "/repo-wt": fullWorktreeStatus } };
        }
        return { statuses: { "/repo-wt": summaryWorktreeStatus } };
      });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: { platform: "darwin", getGitStatus, gitWorktreeStatusBatch },
    });
    useGitStore.getState().setWorktreeStatus("/repo-wt", previousWorktreeStatus);
    useAppStore.setState({ threads: [worktreeThread] });

    await refreshGitProject(project, "poll", "status");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useGitStore.getState().worktreeStatuses["/repo-wt"]).toEqual(summaryWorktreeStatus);

    await refreshGitProject(project, "poll", "status");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fullAttempts).toBe(2);
    expect(useGitStore.getState().worktreeStatuses["/repo-wt"]).toEqual(fullWorktreeStatus);
  });

  it("preserves cached worktree diff stats during fetch refreshes", async () => {
    const cachedWorktreeStatus: GitStatusResult = {
      ...status,
      branch: "feature/wt",
      unstaged: [
        {
          path: "src/existing-change.ts",
          status: "M",
          staged: false,
          insertions: 3,
          deletions: 1,
        },
      ],
      totalInsertions: 3,
      totalDeletions: 1,
    };
    const gitWatchWorktrees = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const gitWorktreeStatusBatch = vi
      .fn<
        (payload: {
          projectLocation: ProjectLocation;
          worktreePaths: string[];
          detail?: "summary" | "full";
        }) => Promise<{ statuses: Record<string, GitStatusResult> }>
      >()
      .mockResolvedValue({ statuses: {} });
    const gitProjectSnapshot = vi
      .fn<
        () => Promise<{
          status: GitStatusResult;
          branches: { current: string; branches: unknown[] };
          worktrees: { path: string; branch: string; commit: string; isMain: boolean }[];
          ghAvailable: boolean;
        }>
      >()
      .mockResolvedValue({
        status,
        branches: { current: "feature/pr-checks", branches: [] },
        worktrees: [{ path: "/repo", branch: "feature/pr-checks", commit: "abc123", isMain: true }],
        ghAvailable: false,
      });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        gitProjectSnapshot,
        gitWatchWorktrees,
        gitWorktreeStatusBatch,
      },
    });
    useGitStore.getState().setWorktreeStatus("/repo-wt", cachedWorktreeStatus);
    useAppStore.setState({ threads: [worktreeThread] });

    await refreshGitProject(project, "fetch", "full");

    expect(gitProjectSnapshot).toHaveBeenCalledWith({
      projectLocation: location,
      includeGhCheck: true,
    });
    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: location,
      worktreePaths: ["/repo-wt"],
      detail: "summary",
    });
    expect(useGitStore.getState().worktreeStatuses["/repo-wt"]).toEqual(cachedWorktreeStatus);
  });

  it("refreshes WSL worktree diff stats during fetch refreshes", async () => {
    const worktreeStatus: GitStatusResult = {
      ...status,
      branch: "feature/wt",
      unstaged: [
        {
          path: "src/changed.ts",
          status: "M",
          staged: false,
          insertions: 3,
          deletions: 1,
        },
      ],
      totalInsertions: 3,
      totalDeletions: 1,
    };
    const gitWatchWorktrees = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const gitWorktreeStatusBatch = vi
      .fn<
        (payload: {
          projectLocation: ProjectLocation;
          worktreePaths: string[];
          detail?: "summary" | "full";
        }) => Promise<{ statuses: Record<string, GitStatusResult> }>
      >()
      .mockResolvedValue({ statuses: { "/repo-wt": worktreeStatus } });
    const gitProjectSnapshot = vi
      .fn<
        () => Promise<{
          status: GitStatusResult;
          branches: { current: string; branches: unknown[] };
          worktrees: { path: string; branch: string; commit: string; isMain: boolean }[];
          ghAvailable: boolean;
        }>
      >()
      .mockResolvedValue({
        status,
        branches: { current: "feature/pr-checks", branches: [] },
        worktrees: [{ path: "/repo", branch: "feature/pr-checks", commit: "abc123", isMain: true }],
        ghAvailable: false,
      });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        gitProjectSnapshot,
        gitWatchWorktrees,
        gitWorktreeStatusBatch,
      },
    });
    useGitStore.getState().setWorktreeStatus("/repo-wt", { ...status });
    useAppStore.setState({ threads: [worktreeThread] });

    await refreshGitProject({ ...project, location: wslLocation }, "fetch", "full");

    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: wslLocation,
      worktreePaths: ["/repo-wt"],
      detail: "full",
    });
    expect(useGitStore.getState().worktreeStatuses["/repo-wt"]).toEqual(worktreeStatus);
  });

  it("uses full worktree status for WSL poll refreshes", async () => {
    const getGitStatus = vi.fn<() => Promise<GitStatusResult>>().mockResolvedValue(status);
    const worktreeStatus: GitStatusResult = {
      ...status,
      branch: "feature/wt",
      unstaged: [
        {
          path: "src/changed.ts",
          status: "M",
          staged: false,
          insertions: 2,
          deletions: 1,
        },
      ],
      totalInsertions: 2,
      totalDeletions: 1,
    };
    const gitWorktreeStatusBatch = vi
      .fn<
        (payload: {
          projectLocation: ProjectLocation;
          worktreePaths: string[];
          detail?: "summary" | "full";
        }) => Promise<{ statuses: Record<string, GitStatusResult> }>
      >()
      .mockResolvedValue({ statuses: { "/repo-wt": worktreeStatus } });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        getGitStatus,
        gitWorktreeStatusBatch,
      },
    });
    useAppStore.setState({ threads: [worktreeThread] });

    await refreshGitProject({ ...project, location: wslLocation }, "poll", "status");

    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: wslLocation,
      worktreePaths: ["/repo-wt"],
      detail: "full",
    });
    expect(useGitStore.getState().worktreeStatuses["/repo-wt"]).toEqual(worktreeStatus);
  });

  it("promotes watcher refresh to a full snapshot after a project becomes a Git repo", async () => {
    const nonRepoStatus: GitStatusResult = {
      isRepo: false,
      branch: "",
      tracking: "",
      hasRemote: false,
      remoteInfo: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      totalInsertions: 0,
      totalDeletions: 0,
    };
    const gitProjectSnapshot = vi
      .fn<
        () => Promise<{
          status: GitStatusResult;
          branches: { current: string; branches: [] };
          worktrees: { path: string; branch: string; commit: string; isMain: boolean }[];
          ghAvailable: boolean;
        }>
      >()
      .mockResolvedValue({
        status,
        branches: { current: "feature/pr-checks", branches: [] },
        worktrees: [{ path: "/repo", branch: "feature/pr-checks", commit: "abc123", isMain: true }],
        ghAvailable: false,
      });
    const getGitStatus = vi.fn<() => Promise<GitStatusResult>>().mockResolvedValue(status);
    const gitWatchWorktrees = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        getGitStatus,
        gitProjectSnapshot,
        gitWatchWorktrees,
      },
    });
    useGitStore.getState().setStatus("p1", nonRepoStatus);

    await refreshGitProject(project, "watcher", getWatcherRefreshMode("p1"));

    expect(getGitStatus).not.toHaveBeenCalled();
    expect(gitProjectSnapshot).toHaveBeenCalledWith({
      projectLocation: location,
      includeGhCheck: true,
    });
    expect(useGitStore.getState().statuses.p1).toEqual(status);
    expect(useGitStore.getState().branches.p1).toEqual({
      current: "feature/pr-checks",
      branches: [],
    });
    expect(useGitStore.getState().worktrees.p1).toEqual([
      { path: "/repo", branch: "feature/pr-checks", commit: "abc123", isMain: true },
    ]);
  });

  it("keeps thread worktrees watched when a stale full refresh has not listed them yet", async () => {
    const worktreeStatus: GitStatusResult = {
      ...status,
      branch: "feature/wt",
      unstaged: [
        {
          path: "src/changed.ts",
          status: "M",
          staged: false,
          insertions: 3,
          deletions: 1,
        },
      ],
      totalInsertions: 3,
      totalDeletions: 1,
    };
    const gitWatchWorktrees = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const gitWorktreeStatusBatch = vi
      .fn<
        (payload: {
          projectLocation: ProjectLocation;
          worktreePaths: string[];
        }) => Promise<{ statuses: Record<string, GitStatusResult> }>
      >()
      .mockResolvedValue({ statuses: { "/repo-wt": worktreeStatus } });
    const gitProjectSnapshot = vi
      .fn<
        () => Promise<{
          status: GitStatusResult;
          branches: { current: string; branches: unknown[] };
          worktrees: { path: string; branch: string; commit: string; isMain: boolean }[];
          ghAvailable: boolean;
        }>
      >()
      .mockResolvedValue({
        status,
        branches: { current: "main", branches: [] },
        worktrees: [
          { path: "/repo", branch: "main", commit: "abc123", isMain: true },
          { path: "/repo-old", branch: "feature/old", commit: "abc123", isMain: false },
        ],
        ghAvailable: false,
      });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        gitProjectSnapshot,
        gitWatchWorktrees,
        gitWorktreeStatusBatch,
      },
    });
    useSidebarUiStore.setState({ threadListLimits: { p1: 1 } });
    useAppStore.setState({ threads: [worktreeThread, hiddenWorktreeThread] });

    await refreshGitProject(project, "initial", "full");

    expect(gitWatchWorktrees).toHaveBeenCalledWith({
      projectId: "p1",
      worktreePaths: ["/repo-wt"],
    });
    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: location,
      worktreePaths: ["/repo-wt"],
      detail: "full",
    });
    expect(useGitStore.getState().worktreeStatuses["/repo-wt"]).toEqual(worktreeStatus);
  });

  it("keeps hidden worktree threads watched while they are open in a thread pane", async () => {
    const gitWatchWorktrees = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const gitWorktreeStatusBatch = vi
      .fn<
        (payload: {
          projectLocation: ProjectLocation;
          worktreePaths: string[];
        }) => Promise<{ statuses: Record<string, GitStatusResult> }>
      >()
      .mockResolvedValue({ statuses: {} });
    const gitProjectSnapshot = vi
      .fn<() => Promise<{ status: GitStatusResult; worktrees: []; ghAvailable: boolean }>>()
      .mockResolvedValue({ status, worktrees: [], ghAvailable: false });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        gitProjectSnapshot,
        gitWatchWorktrees,
        gitWorktreeStatusBatch,
      },
    });
    useSidebarUiStore.setState({ threadListLimits: { p1: 1 } });
    useAppStore.setState({
      threads: [worktreeThread, hiddenWorktreeThread],
      view: { kind: "thread", panes: ["t-hidden"] as [string, ...string[]] },
    });

    await refreshGitProject(project, "initial", "full");

    expect(gitWatchWorktrees).toHaveBeenCalledWith({
      projectId: "p1",
      worktreePaths: ["/repo-hidden", "/repo-wt"],
    });
  });

  it("keeps hidden worktree threads watched while their git panel is active", async () => {
    const gitWatchWorktrees = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const gitWorktreeStatusBatch = vi
      .fn<
        (payload: {
          projectLocation: ProjectLocation;
          worktreePaths: string[];
        }) => Promise<{ statuses: Record<string, GitStatusResult> }>
      >()
      .mockResolvedValue({ statuses: {} });
    const gitProjectSnapshot = vi
      .fn<() => Promise<{ status: GitStatusResult; worktrees: []; ghAvailable: boolean }>>()
      .mockResolvedValue({ status, worktrees: [], ghAvailable: false });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        gitProjectSnapshot,
        gitWatchWorktrees,
        gitWorktreeStatusBatch,
      },
    });
    useSidebarUiStore.setState({ threadListLimits: { p1: 1 } });
    usePanelStore.setState({
      gitReviewContext: { projectId: "p1", worktreePath: "/repo-hidden" },
      gitReviewAsPanel: true,
      rightPanelTab: "git",
    });
    useAppStore.setState({ threads: [worktreeThread, hiddenWorktreeThread] });

    await refreshGitProject(project, "initial", "full");

    expect(gitWatchWorktrees).toHaveBeenCalledWith({
      projectId: "p1",
      worktreePaths: ["/repo-hidden", "/repo-wt"],
    });
  });

  function seedDecidedExperimentCandidate(candidatePath: string): void {
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        dbSetState: vi
          .fn<(key: string, value: string) => Promise<void>>()
          .mockResolvedValue(undefined),
      },
    });
    useSidebarUiStore.setState({ collapsedProjects: { [project.id]: true } });
    useAppStore.setState({
      threads: [
        {
          ...worktreeThread,
          id: "candidate-1",
          worktreePath: candidatePath,
          worktreeBranch: "poracode/one",
        },
      ],
      view: { kind: "home" },
    });
    useExperimentStore.setState({ experiments: {} });
    useExperimentStore.getState().addExperiment({
      id: "experiment-1",
      projectId: project.id,
      title: "Experiment",
      prompt: "Implement it",
      baseBranch: "main",
      baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      candidates: [
        {
          threadId: "candidate-1",
          agentKind: "codex",
          worktreePath: candidatePath,
          worktreeBranch: "poracode/one",
          worktreeOwnerToken: "experiment-1:candidate-1",
          worktreeState: "owned",
        },
      ],
      winnerThreadId: "candidate-1",
      status: "decided",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
  }

  it("watches a decided experiment candidate opened in the git review panel", () => {
    const candidatePath = "/repo/experiment-one";
    seedDecidedExperimentCandidate(candidatePath);
    usePanelStore.setState({
      gitReviewContext: { projectId: project.id, worktreePath: candidatePath },
      gitReviewAsPanel: true,
      gitOverlayOpen: false,
      rightPanelTab: "git",
    });

    expect(getProjectActiveWorktreePaths(project.id)).toContain(candidatePath);
  });

  it("watches a decided experiment candidate opened in the git review overlay", () => {
    const candidatePath = "/repo/experiment-one";
    seedDecidedExperimentCandidate(candidatePath);
    usePanelStore.setState({
      gitReviewContext: { projectId: project.id, worktreePath: candidatePath },
      gitReviewAsPanel: false,
      gitOverlayOpen: true,
      rightPanelTab: "files",
    });

    expect(getProjectActiveWorktreePaths(project.id)).toContain(candidatePath);
  });
});
