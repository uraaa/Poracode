// Deterministic process-boundary benchmark. No repository, network or running app is touched.
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Project, ProjectLocation, Thread } from "@/shared/contracts";
import type { SupervisorEvent } from "@/shared/ipc/events";
import { useAppStore } from "../state/appStore";
import { usePanelStore } from "../state/panelStore";
import { useSidebarUiStore } from "../state/sidebarUiStore";
import { useGitStore } from "../state/gitStore";
import {
  cleanupGitRefreshProjects,
  prefetchBranchPrData,
  refreshGitProject,
} from "../state/gitRefresh";
import { useGitRefresh } from "./useGitRefresh";
import * as sidebarRows from "../views/MainView/parts/Sidebar/parts/sidebarProjectRows";

const probes = vi.hoisted(() => ({
  git: vi.fn<(location: ProjectLocation, args: string[]) => Promise<string>>(),
  gh: vi.fn<(location: ProjectLocation, args: string[]) => Promise<string>>(),
  stat: vi.fn<() => Promise<{ isFile: () => boolean; size: number; mtimeMs: number }>>(
    async () => ({ isFile: () => false, size: 1, mtimeMs: 1 }),
  ),
}));
vi.mock("@/supervisor/git/exec", async (original) => ({
  ...(await original<object>()),
  execGit: probes.git,
}));
// Network lock identity is filesystem-derived; its real linked-worktree behavior
// is covered by worktreeService.test.ts. Keep this clock-only volume model deterministic.
vi.mock("@/supervisor/git/networkGate", () => ({ repositoryNetworkKey: async () => "/repo/.git" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = {
    ...(await original<object>()),
    stat: probes.stat,
    readFile: async () => {
      throw new Error("ENOENT");
    },
  };
  return { ...fs, default: fs };
});
import { GitService } from "@/supervisor/git";
import { GitHubService } from "@/supervisor/github";

afterEach(() => {
  cleanupGitRefreshProjects(new Set());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("measures 40 sidebar worktrees, 2 open panes, watcher bursts and real periodic timers", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  probes.gh.mockResolvedValue("[]");
  const project: Project = {
    id: "volume",
    name: "Volume",
    location: { kind: "posix", path: "/repo" },
    createdAt: "",
  };
  const threads = Array.from({ length: 40 }, (_, i) => ({
    id: `volume-${i}`,
    projectId: project.id,
    title: `Thread ${i}`,
    agentKind: "codex",
    config: {},
    status: "inactive",
    attention: "none",
    worktreePath: `/wt/${i}`,
    worktreeBranch: `feature/${i}`,
    archived: false,
    createdAt: "",
    updatedAt: "",
    done: false,
    starred: false,
    canResumeWithConfig: false,
  })) as Thread[];
  useAppStore.setState({
    projects: [project],
    threads,
    view: { kind: "thread", panes: ["volume-0", "volume-1"] },
  });
  useSidebarUiStore.setState({ collapsedProjects: {}, threadListLimits: { volume: 100 } });
  usePanelStore.setState({
    gitReviewAsPanel: false,
    gitOverlayOpen: false,
    gitReviewContext: null,
    filesPanelContext: null,
  });
  useGitStore.setState({
    statuses: {},
    ghAvailable: {},
    worktreeStatuses: {},
    worktrees: {},
    prData: {},
    prDetails: {},
  });
  let dirty = false;
  let lineCount = 2;
  let commitsAhead = 0;
  probes.git.mockImplementation(async (_location, args: string[]) => {
    if (args[0] === "status")
      return "# branch.head main\n" + (dirty ? "1 .M N... 100644 100644 100644 a b file.ts\n" : "");
    if (args[0] === "diff") return dirty ? `${lineCount}\t1\tfile.ts\n` : "";
    if (args[0] === "rev-list") return `0\t${commitsAhead}\n`;
    if (args[0] === "remote")
      return args[1] === "-v" ? "origin\thttps://github.com/o/r (fetch)\n" : "origin\n";
    if (args[0] === "worktree")
      return [
        "worktree /repo\nHEAD a\nbranch refs/heads/main",
        ...threads.map(
          (t) => `worktree ${t.worktreePath}\nHEAD a\nbranch refs/heads/${t.worktreeBranch}`,
        ),
      ].join("\n\n");
    if (args[0] === "config") return "main\n";
    return "";
  });
  const git = new GitService();
  const gh = new GitHubService();
  Object.defineProperty(gh, "runGh", { value: probes.gh });
  let onEvent!: (event: SupervisorEvent) => void;
  Object.defineProperty(window, "poracode", {
    configurable: true,
    value: {
      platform: "darwin",
      dbSyncAll: async () => undefined,
      dbSetState: async () => undefined,
      gitWatchProject: async () => undefined,
      gitWatchWorktrees: async () => undefined,
      gitUnwatchProject: async () => undefined,
      onSupervisorEvent: (listener: typeof onEvent) => {
        onEvent = listener;
        return () => undefined;
      },
      getGitStatus: ({ projectLocation }: { projectLocation: Project["location"] }) =>
        git.getStatus(projectLocation),
      gitProjectSnapshot: async ({ includeGhCheck }: { includeGhCheck: boolean }) => {
        const [status, branches, worktrees, availability] = await Promise.all([
          git.getStatus(project.location),
          git.listBranches(project.location, true),
          git.listWorktrees(project.location),
          includeGhCheck ? gh.checkGhAvailable(project.location) : null,
        ]);
        return {
          status,
          branches,
          worktrees: worktrees.worktrees,
          ghAvailable: availability?.available ?? null,
        };
      },
      gitWorktreeStatusBatch: async ({
        worktreePaths,
        detail,
      }: {
        worktreePaths: string[];
        detail: "full" | "summary";
      }) => ({
        statuses: await git.getWorktreeStatusBatch(project.location, worktreePaths, detail),
      }),
      gitGetWorktreeSourceBranch: ({ branch }: { branch: string }) =>
        git.getWorktreeSourceBranch(project.location, branch),
      gitFetch: () => git.fetch(project.location, "origin", true),
      ghGetPrForBranch: ({ branch }: { branch: string }) =>
        gh.getPrForBranch(project.location, branch),
      ghListPrs: async () => ({ prs: await gh.listPrs(project.location) }),
    },
  });
  const { unmount } = renderHook(() => useGitRefresh(true));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  await act(async () => {
    await vi.waitFor(() =>
      expect(useGitStore.getState().worktreeStatuses["/wt/39"]?.isRepo).toBe(true),
    );
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(useGitStore.getState().worktreeSourceInfo["/wt/39"]?.commitsAhead).toBe(0),
    );
  });
  const initial = { git: probes.git.mock.calls.length, gh: probes.gh.mock.calls.length };
  expect(useGitStore.getState().worktreeStatuses["/wt/39"]?.isRepo).toBe(true);
  probes.git.mockClear();
  probes.gh.mockClear();
  await refreshGitProject(project, "manual", "full");
  const cycle = { git: probes.git.mock.calls.length, gh: probes.gh.mock.calls.length };
  // Warm steady-state window includes the 5s fetch and 180s periodic fetch.
  for (let i = 0; i < 10; i++) await act(() => vi.advanceTimersByTimeAsync(1000));
  probes.git.mockClear();
  probes.gh.mockClear();
  for (let i = 0; i < 360; i++) await act(() => vi.advanceTimersByTimeAsync(1000));
  const idlePerMinute = {
    git: probes.git.mock.calls.length / 6,
    gh: probes.gh.mock.calls.length / 6,
  };
  expect(
    probes.git.mock.calls.some(([, args]) => args[0] === "branch" && args.includes("-a")),
  ).toBe(true);
  expect(probes.gh.mock.calls.length).toBeGreaterThan(0);
  dirty = true;
  probes.git.mockClear();
  probes.gh.mockClear();
  // Three edits within each 1s burst; no worktree path on the old event shape.
  for (let i = 0; i < 60; i++) {
    for (let j = 0; j < 3; j++) {
      onEvent({
        type: "project-tree-changed",
        projectId: project.id,
        worktreePath: `/wt/${i % 2}`,
      });
      await act(() => vi.advanceTimersByTimeAsync(50));
    }
    await act(() => vi.advanceTimersByTimeAsync(850));
  }
  const activePerMinute = { git: probes.git.mock.calls.length, gh: probes.gh.mock.calls.length };
  console.log("POLLING_VOLUME", JSON.stringify({ initial, cycle, idlePerMinute, activePerMinute }));
  expect(cycle.git).toBeLessThanOrEqual(170);
  expect(activePerMinute.git).toBeGreaterThan(50);
  expect(activePerMinute.git).toBeLessThanOrEqual(180);
  expect(probes.stat).toHaveBeenCalled();
  expect(useGitStore.getState().worktreeStatuses["/wt/0"]?.totalInsertions).toBe(2);
  // Visible edits stay responsive while a previously refreshed sidebar path waits.
  lineCount = 7;
  onEvent({ type: "project-tree-changed", projectId: project.id, worktreePath: "/wt/39" });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  lineCount = 9;
  onEvent({ type: "project-tree-changed", projectId: project.id, worktreePath: "/wt/39" });
  onEvent({ type: "project-tree-changed", projectId: project.id, worktreePath: "/wt/0" });
  for (let i = 0; i < 20; i++) await act(() => vi.advanceTimersByTimeAsync(100));
  expect(useGitStore.getState().worktreeStatuses["/wt/0"]?.totalInsertions).toBe(9);
  expect(useGitStore.getState().worktreeStatuses["/wt/39"]?.totalInsertions).toBe(7);
  commitsAhead = 5;
  onEvent({ type: "git-changed", projectId: project.id });
  for (let i = 0; i < 30; i++) await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(useGitStore.getState().worktreeSourceInfo["/wt/39"]?.commitsAhead).toBe(5);
  await prefetchBranchPrData(project);
  const rowBuild = vi.spyOn(sidebarRows, "buildSidebarProjectRows");
  useAppStore.setState({
    threads: threads.map((thread) => ({ ...thread, title: "Streaming update" })),
  });
  expect(rowBuild).toHaveBeenCalledTimes(1);
  useGitStore
    .getState()
    .setStatus(project.id, { ...useGitStore.getState().statuses[project.id]!, ahead: 1 });
  expect(rowBuild).toHaveBeenCalledTimes(1);
  rowBuild.mockRestore();
  useAppStore.setState({ view: { kind: "thread", panes: ["volume-39"] } });
  await act(async () => {
    await vi.waitFor(() =>
      expect(useGitStore.getState().worktreeStatuses["/wt/39"]?.totalInsertions).toBe(9),
    );
  });
  expect(useGitStore.getState().worktreeStatuses["/wt/39"]?.totalInsertions).toBe(9);
  unmount();
});
