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
  watchers: new Map<string, (type: string, name: string) => void>(),
}));
vi.mock("node:fs", async (original) => {
  const { EventEmitter } = await import("node:events");
  const fs = {
    ...(await original<object>()),
    watch: (path: string, _options: unknown, listener: (type: string, name: string) => void) => {
      const key = String(path).replaceAll("\\", "/");
      probes.watchers.set(key, listener);
      return Object.assign(new EventEmitter(), {
        close: () => {
          if (probes.watchers.get(key) === listener) probes.watchers.delete(key);
        },
      });
    },
  };
  return { ...fs, default: fs };
});
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
import { ProjectWatcher } from "@/supervisor/projectWatcher";

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
  let mainStaged = false;
  let emitFetchEvents = false;
  probes.git.mockImplementation(async (location, args: string[]) => {
    if (args[0] === "status")
      return (
        "# branch.head main\n" +
        (dirty
          ? `1 ${location.kind === "posix" && location.path === "/repo" && mainStaged ? "M." : ".M"} N... 100644 100644 100644 a b file.ts\n`
          : "")
      );
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
  const watcher = new ProjectWatcher({
    onGitChanged: (projectId, worktreePath) =>
      onEvent({ type: "git-changed", projectId, ...(worktreePath ? { worktreePath } : {}) }),
    onTreeChanged: (projectId, worktreePath) =>
      onEvent({
        type: "project-tree-changed",
        projectId,
        ...(worktreePath ? { worktreePath } : {}),
      }),
  });
  const metadata = (name: string) => probes.watchers.get("/repo/.git")!("change", name);
  Object.defineProperty(window, "poracode", {
    configurable: true,
    value: {
      platform: "darwin",
      dbSyncAll: async () => undefined,
      dbSetState: async () => undefined,
      gitWatchProject: async () => watcher.watch(project.id, project.location),
      gitWatchWorktrees: async ({ worktreePaths }: { worktreePaths: string[] }) =>
        watcher.watchWorktrees(project.id, worktreePaths),
      gitUnwatchProject: async () => watcher.unwatch(project.id),
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
      gitFetch: async () => {
        const result = await git.fetch(project.location, "origin", true);
        if (emitFetchEvents) {
          metadata("refs/remotes/origin/main");
          setTimeout(() => metadata("packed-refs"), 900);
          await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        }
        return result;
      },
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
  useAppStore.setState({ view: { kind: "thread", panes: ["volume-0", "volume-1"] } });
  await act(() => vi.advanceTimersByTimeAsync(0));
  probes.git.mockClear();
  probes.gh.mockClear();
  // One message/checkpoint per second, plus an external main-worktree git add/reset every 10s.
  const observedMainStages: Array<number | undefined> = [];
  for (let second = 0; second < 60; second++) {
    for (const name of [
      `index.poracode-${second}`,
      `index.poracode-${second}.lock`,
      `worktrees/wt/index.poracode-${second}`,
      `worktrees/wt/index.poracode-${second}.lock`,
    ])
      metadata(name);
    if (second % 10 === 0) {
      mainStaged = !mainStaged;
      metadata("index");
    }
    await act(() => vi.advanceTimersByTimeAsync(1000));
    if (second % 10 === 1)
      observedMainStages.push(useGitStore.getState().statuses[project.id]?.staged.length);
  }
  const messagesAndMainIndexPerMinute = {
    git: probes.git.mock.calls.length,
    gh: probes.gh.mock.calls.length,
  };
  expect(observedMainStages).toEqual([1, 0, 1, 0, 1, 0]);
  // Let earlier invalidations settle, then measure one periodic fetch including its ref writes.
  for (let i = 0; i < 31; i++) await act(() => vi.advanceTimersByTimeAsync(1000));
  const nextFetch = 180_000 - ((Date.now() - Date.parse("2026-10-27T12:00:00Z")) % 180_000);
  await act(() => vi.advanceTimersByTimeAsync(nextFetch - 1));
  probes.git.mockClear();
  probes.gh.mockClear();
  emitFetchEvents = true;
  commitsAhead = 6;
  for (let i = 0; i < 34; i++) await act(() => vi.advanceTimersByTimeAsync(1000));
  const fetchWithRefWrites = { git: probes.git.mock.calls.length, gh: probes.gh.mock.calls.length };
  console.log(
    "WATCHER_FOLLOWUP_VOLUME",
    JSON.stringify({ messagesAndMainIndexPerMinute, fetchWithRefWrites }),
  );
  expect(probes.git.mock.calls.filter(([, args]) => args[0] === "fetch")).toHaveLength(1);
  expect(useGitStore.getState().worktreeSourceInfo["/wt/39"]?.commitsAhead).toBe(6);
  expect(messagesAndMainIndexPerMinute.git).toBeLessThan(30);
  expect(fetchWithRefWrites.git).toBeLessThanOrEqual(190);
  unmount();
  await watcher.dispose();
});
