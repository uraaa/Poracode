import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitStatusResult,
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
import type { PoracodeBridge } from "@/shared/ipc";
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
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
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
      background: true,
    });
    expect(ghGetPrDetailsMock).toHaveBeenCalledWith({
      projectLocation: location,
      prNumber: 42,
      background: true,
    });

    ghGetPrForBranchMock.mockClear();
    ghGetPrDetailsMock.mockClear();

    await vi.advanceTimersByTimeAsync(PR_PENDING_REFRESH_INTERVAL_MS);

    expect(ghGetPrForBranchMock).toHaveBeenCalledWith({
      projectLocation: location,
      branch: "feature/pr-checks",
      background: true,
    });
    expect(ghGetPrDetailsMock).toHaveBeenCalledWith({
      projectLocation: location,
      prNumber: 42,
      background: true,
    });
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
      background: true,
    });
    expect(ghGetPrDetailsMock).toHaveBeenCalledWith({
      projectLocation: location,
      prNumber: 42,
      background: true,
    });
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
      background: true,
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
      background: true,
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
  it("keeps explicit manual status reads interactive with exact diff counts", async () => {
    const getGitStatus = vi.fn<PoracodeBridge["getGitStatus"]>().mockResolvedValue(status);
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: { platform: "darwin", getGitStatus },
    });
    await refreshGitProject(project, "manual", "status");
    expect(getGitStatus).toHaveBeenCalledExactlyOnceWith({
      projectLocation: location,
      detail: "full",
    });
  });

  it("does not refresh dormant sidebar rows or archived panes", () => {
    useAppStore.setState({ threads: [worktreeThread], view: { kind: "home" } });
    expect(getProjectActiveWorktreePaths(project.id)).toEqual([]);
    useAppStore.setState({
      threads: [{ ...worktreeThread, archived: true }],
      view: { kind: "thread", panes: ["t1"] },
    });
    expect(getProjectActiveWorktreePaths(project.id)).toEqual([]);
  });

  it.each(["poll", "watcher"] as const)(
    "limits %s volume to two open worktrees out of forty sidebar rows",
    async (reason) => {
      vi.useFakeTimers();
      useSidebarUiStore.setState({ threadListLimits: { p1: 40 } });
      const threads = Array.from({ length: 40 }, (_, index) => ({
        ...worktreeThread,
        id: `volume-${index}`,
        worktreePath: `/repo-wt-${index}`,
      }));
      useAppStore.setState({ threads, view: { kind: "thread", panes: ["volume-0", "volume-1"] } });
      const getGitStatus = vi.fn<PoracodeBridge["getGitStatus"]>().mockResolvedValue(status);
      const gitWorktreeStatusBatch = vi
        .fn<PoracodeBridge["gitWorktreeStatusBatch"]>()
        .mockResolvedValue({
          statuses: {
            "/repo-wt-0": {
              ...status,
              detail: "summary",
              staged: [{ path: "new.ts", staged: true, status: "A", insertions: 0, deletions: 0 }],
            },
          },
        });
      Object.defineProperty(window, "poracode", {
        configurable: true,
        value: {
          platform: "darwin",
          dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
          getGitStatus,
          gitWorktreeStatusBatch,
        },
      });
      const requests = Array.from({ length: reason === "watcher" ? 100 : 1 }, () =>
        refreshGitProject(project, reason, "status"),
      );
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all(requests);
      expect(getGitStatus).toHaveBeenCalledExactlyOnceWith({
        projectLocation: location,
        detail: "summary",
        background: true,
      });
      expect(gitWorktreeStatusBatch).toHaveBeenCalledExactlyOnceWith({
        projectLocation: location,
        worktreePaths: ["/repo-wt-0", "/repo-wt-1"],
        detail: "summary",
        background: true,
      });
    },
  );

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
    vi.useRealTimers();
  });

  it("abandons a timed-out cycle and rejects its stale store writes", async () => {
    vi.useFakeTimers();
    const stalled = Promise.withResolvers<GitStatusResult>();
    const getGitStatus = vi
      .fn<PoracodeBridge["getGitStatus"]>()
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValue(status);
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
        getGitStatus,
      },
    });
    const first = refreshGitProject(project, "poll", "status");
    await vi.advanceTimersByTimeAsync(30_000);
    await first;
    const second = refreshGitProject(project, "poll", "status");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(getGitStatus).toHaveBeenCalledTimes(2);
    } finally {
      stalled.resolve({ ...status, branch: "stale-branch" });
      await second;
    }
    expect(getGitStatus).toHaveBeenCalledTimes(2);
    expect(useGitStore.getState().statuses.p1?.branch).toBe(status.branch);
  });

  it.each(["manual", "fetch"] as const)(
    "coalesces watcher and poll bursts while retaining a %s full refresh and fetch",
    async (reason) => {
      const stalled = Promise.withResolvers<GitStatusResult>();
      const getGitStatus = vi
        .fn<PoracodeBridge["getGitStatus"]>()
        .mockReturnValueOnce(stalled.promise)
        .mockResolvedValue(status);
      const gitProjectSnapshot = vi.fn<PoracodeBridge["gitProjectSnapshot"]>().mockResolvedValue({
        status,
        branches: { current: status.branch, branches: [] },
        worktrees: [],
        ghAvailable: false,
      });
      const gitFetch = vi.fn<PoracodeBridge["gitFetch"]>().mockResolvedValue(undefined);
      Object.defineProperty(window, "poracode", {
        configurable: true,
        value: {
          platform: "darwin",
          dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
          getGitStatus,
          gitProjectSnapshot,
          gitFetch,
          gitWatchWorktrees: vi
            .fn<PoracodeBridge["gitWatchWorktrees"]>()
            .mockResolvedValue(undefined),
        },
      });
      const first = refreshGitProject(project, "poll", "status");
      const manual = refreshGitProject(project, reason, "full", { fetchRemote: true });
      const requests = Array.from({ length: 20 }, () => [
        refreshGitProject(project, "watcher", "status"),
        refreshGitProject(project, "poll", "status"),
      ]).flat();
      stalled.resolve(status);
      await Promise.all([first, manual, ...requests]);
      expect(getGitStatus).toHaveBeenCalledTimes(1);
      expect(gitProjectSnapshot).toHaveBeenCalledTimes(1);
      expect(gitFetch).toHaveBeenCalledTimes(1);
      expect(gitFetch).toHaveBeenCalledWith({
        projectLocation: project.location,
        remote: "origin",
        prune: true,
        ...(reason === "fetch" ? { background: true } : {}),
      });
      expect(useGitStore.getState().statuses.p1).toEqual(status);
    },
  );

  it("keeps real work locked across cleanup and runs a newly mounted refresh afterwards", async () => {
    const stalled = Promise.withResolvers<GitStatusResult>();
    const getGitStatus = vi
      .fn<PoracodeBridge["getGitStatus"]>()
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValue(status);
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
        getGitStatus,
      },
    });
    let active = true;
    const first = refreshGitProject(project, "poll", "status", { isActive: () => active });
    await Promise.resolve();
    active = false;
    cleanupGitRefreshProjects(new Set());
    const next = refreshGitProject(project, "poll", "status");
    try {
      await Promise.resolve();
      expect(getGitStatus).toHaveBeenCalledTimes(1);
    } finally {
      stalled.resolve(status);
      await Promise.all([first, next]);
    }
    expect(getGitStatus).toHaveBeenCalledTimes(2);
    expect(useGitStore.getState().statuses.p1).toEqual(status);
  });

  it("shares bulk PR results with branch lookups and dedupes fallback worktree branches", async () => {
    const bulk = Promise.withResolvers<{ prs: Record<string, PrData> }>();
    const bulkPr = { ...basePr, number: 101, state: "merged" as const };
    const fallbackPr = { ...basePr, number: 102, viewerDidAuthor: true };
    const ghListPrs = vi.fn<PoracodeBridge["ghListPrs"]>().mockReturnValue(bulk.promise);
    const ghGetPrForBranch = vi
      .fn<PoracodeBridge["ghGetPrForBranch"]>()
      .mockResolvedValue(fallbackPr);
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
        gitProjectSnapshot: vi.fn<PoracodeBridge["gitProjectSnapshot"]>().mockResolvedValue({
          status,
          branches: { current: status.branch, branches: [] },
          worktrees: [],
          ghAvailable: true,
        }),
        gitWorktreeStatusBatch: vi
          .fn<PoracodeBridge["gitWorktreeStatusBatch"]>()
          .mockResolvedValue({ statuses: {} }),
        gitWatchWorktrees: vi
          .fn<PoracodeBridge["gitWatchWorktrees"]>()
          .mockResolvedValue(undefined),
        ghListPrs,
        ghGetPrForBranch,
      },
    });
    useAppStore.setState({ threads: [worktreeThread, { ...worktreeThread, id: "t2" }] });
    useGitStore.setState({
      statuses: { p1: status },
      ghAvailable: { p1: true },
      prData: { [buildBranchPrKey("p1")]: { ...bulkPr, viewerDidAuthor: true } },
    });
    // A sidebar prefetch already owns the bulk request when the cycle starts.
    const prefetch = prefetchBranchPrData(project);
    const refresh = refreshGitProject(project, "initial", "full");
    bulk.resolve({ prs: { [status.branch]: bulkPr } });
    await Promise.all([prefetch, refresh]);
    expect(ghListPrs).toHaveBeenCalledTimes(1);
    expect(ghGetPrForBranch).toHaveBeenCalledTimes(1);
    expect(ghGetPrForBranch).toHaveBeenCalledWith({
      projectLocation: location,
      branch: "feature/wt",
      background: true,
    });
    expect(useGitStore.getState().prData[buildBranchPrKey("p1")]).toEqual({
      ...bulkPr,
      viewerDidAuthor: true,
    });
    expect(useGitStore.getState().prData["/repo-wt"]).toEqual(fallbackPr);
    expect(useAppStore.getState().threads.map((thread) => thread.prNumber)).toEqual([102, 102]);
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
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
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
      detail: "summary",
      background: true,
    });
    expect(useGitStore.getState().worktreeStatuses["/repo-wt"]).toEqual(worktreeStatus);
  });

  it("requests exact worktree counts only for the worktree whose Git review is visible", async () => {
    const gitWorktreeStatusBatch = vi
      .fn<PoracodeBridge["gitWorktreeStatusBatch"]>()
      .mockResolvedValue({ statuses: { "/repo-wt": status } });
    const getGitStatus = vi.fn<PoracodeBridge["getGitStatus"]>().mockResolvedValue(status);
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {
        platform: "darwin",
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
        getGitStatus,
        gitWorktreeStatusBatch,
      },
    });
    useAppStore.setState({
      threads: [worktreeThread, hiddenWorktreeThread],
      view: { kind: "thread", panes: ["t1", "t-hidden"] },
    });
    usePanelStore.setState({
      rightPanelTab: "git",
      gitReviewAsPanel: true,
      gitReviewContext: { projectId: "p1", worktreePath: "/repo-wt" },
    });
    await refreshGitProject(project, "poll", "status");
    expect(gitWorktreeStatusBatch).toHaveBeenCalledTimes(2);
    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: location,
      worktreePaths: ["/repo-wt"],
      detail: "full",
      background: true,
    });
    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: location,
      worktreePaths: ["/repo-hidden"],
      detail: "summary",
      background: true,
    });
    expect(getGitStatus).toHaveBeenCalledExactlyOnceWith({
      projectLocation: location,
      detail: "summary",
      background: true,
    });
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
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
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
      background: true,
    });
    expect(gitWorktreeStatusBatch).not.toHaveBeenCalled();
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
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
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
      detail: "summary",
      background: true,
    });
    expect(useGitStore.getState().worktreeStatuses["/repo-wt"]).toEqual(worktreeStatus);
  });

  it("uses summary worktree status for WSL poll refreshes", async () => {
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
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
        getGitStatus,
        gitWorktreeStatusBatch,
      },
    });
    useAppStore.setState({ threads: [worktreeThread] });

    await refreshGitProject({ ...project, location: wslLocation }, "poll", "status");

    expect(gitWorktreeStatusBatch).toHaveBeenCalledWith({
      projectLocation: wslLocation,
      worktreePaths: ["/repo-wt"],
      detail: "summary",
      background: true,
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
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
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
      background: true,
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
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
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
      detail: "summary",
      background: true,
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
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
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
      worktreePaths: ["/repo-hidden"],
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
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
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
        dbSyncAll: vi.fn<PoracodeBridge["dbSyncAll"]>().mockResolvedValue(undefined),
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
