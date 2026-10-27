import { useEffect } from "react";
import { parseDraftProjectId } from "@/shared/paneId";
import { readBridge } from "@/renderer/bridge";
import { useAppStore } from "@/renderer/state/appStore";
import { useExperimentStore } from "@/renderer/state/experimentStore";
import { buildActiveProjectsKey } from "@/renderer/state/projectKeys";
import { useDevTerminalStore } from "@/renderer/state/devTerminalStore";
import { useFileEditorStore } from "@/renderer/state/fileEditorStore";
import { useGitStore } from "@/renderer/state/gitStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { shouldPollProject } from "@/renderer/state/wslBackgroundActivity";
import {
  cleanupGitRefreshProjects,
  getWatcherRefreshMode,
  refreshGitProject,
  stopPendingPrRefresh,
  syncPendingPrRefreshProjects,
  syncWatchedWorktreeProject,
} from "@/renderer/state/gitRefresh";
import {
  GIT_FETCH_PRIORITY_INTERVAL_MS,
  GIT_FETCH_BACKGROUND_INTERVAL_MS,
} from "@/renderer/utils/gitHelpers";

const WSL_STATUS_POLL_INTERVAL_MS = 3_000;

/**
 * Subscribe to a store and invoke `onChange` whenever any of the selected
 * fields changes identity. Collapses the otherwise-identical "compare a fixed
 * field tuple, then re-sync" guards so the worktree-watch subscriptions below
 * stay in one shape instead of four hand-written `===` chains.
 */
function subscribeToFieldChanges<S>(
  subscribe: (listener: (state: S, prev: S) => void) => () => void,
  selectFields: (state: S) => readonly unknown[],
  onChange: () => void,
): () => void {
  return subscribe((state, prev) => {
    const next = selectFields(state);
    const previous = selectFields(prev);
    if (next.some((value, index) => value !== previous[index])) onChange();
  });
}

export function useGitRefresh(storeHydrated: boolean) {
  // Subscribe only to the active-project identity/location key so draft config
  // writes do not invalidate the whole shell.
  const activeProjectsKey = useAppStore((state) => buildActiveProjectsKey(state.projects));

  useEffect(() => {
    // `activeProjectsKey` is this run's request identity: the project set
    // below must derive from the same store snapshot, otherwise the key raced
    // ahead and this run would watch/fetch a stale set.
    const requestKey = activeProjectsKey;
    const projectsSnapshot = useAppStore.getState().projects;
    if (buildActiveProjectsKey(projectsSnapshot) !== requestKey) return;
    const activeProjects = projectsSnapshot.filter((project) => !project.disabled);
    if (!storeHydrated) return;
    cleanupGitRefreshProjects(new Set(activeProjects.map((project) => project.id)));
    if (activeProjects.length === 0) return;

    let isActive = true;
    const lastFetchTimes = new Map<string, number>();
    const watchedPathKeys = new Map<string, string>();
    const fetchInFlight = new Map<string, symbol>();
    const fetchTimeouts = new Set<ReturnType<typeof setTimeout>>();
    let previousPriorityProjectIds = new Set<string>();
    const isActiveCheck = () => isActive;

    function getPriorityProjectIds(): Set<string> {
      const state = useAppStore.getState();
      const priorityProjectIds = new Set<string>();

      if (state.view.kind === "draft" && state.view.projectId) {
        priorityProjectIds.add(state.view.projectId);
        return priorityProjectIds;
      }

      if (state.view.kind === "experiment") {
        priorityProjectIds.add(state.view.projectId);
        return priorityProjectIds;
      }

      if (state.view.kind !== "thread") {
        return priorityProjectIds;
      }

      for (const paneId of state.view.panes) {
        const draftProjectId = parseDraftProjectId(paneId);
        if (draftProjectId) {
          priorityProjectIds.add(draftProjectId);
          continue;
        }
        const threadProjectId = state.threads.find((thread) => thread.id === paneId)?.projectId;
        if (threadProjectId) {
          priorityProjectIds.add(threadProjectId);
        }
      }

      return priorityProjectIds;
    }

    for (const project of activeProjects) {
      readBridge()
        .gitWatchProject({ projectId: project.id, projectLocation: project.location })
        .catch(() => undefined);
    }

    function syncActiveWorktrees() {
      if (!isActive) return;
      for (const project of activeProjects) {
        const paths = syncWatchedWorktreeProject(project.id);
        const panel = usePanelStore.getState();
        const visibleGit =
          panel.gitReviewContext?.projectId === project.id &&
          ((panel.gitReviewAsPanel && panel.rightPanelTab === "git") || panel.gitOverlayOpen);
        const key = JSON.stringify([paths, visibleGit ? panel.gitReviewContext : null]);
        const previous = watchedPathKeys.get(project.id);
        watchedPathKeys.set(project.id, key);
        // Dormant rows have no background status work. Opening a pane or Git
        // review must load its status even when the new watcher sees no edits.
        if (previous !== undefined && previous !== key) {
          void refreshGitProject(project, "watcher", "status", { isActive: isActiveCheck });
        }
      }
      syncPendingPrRefreshProjects(activeProjects);
    }

    const unsubWatcher = readBridge().onSupervisorEvent((event) => {
      // Both events are git-affecting: `.git` metadata clearly, and worktree
      // edits change `git status` output (a tracked file becomes modified,
      // an untracked file appears, etc.). Refresh git state for either.
      if (event.type === "git-changed" || event.type === "project-tree-changed") {
        console.log(`[git-refresh] watcher-event ${event.type} project=${event.projectId}`);
        const project = activeProjects.find((p) => p.id === event.projectId);
        if (project) {
          void refreshGitProject(project, "watcher", getWatcherRefreshMode(project.id), {
            isActive: isActiveCheck,
          });
        }
      }
      if (event.type === "project-tree-changed") {
        const editorRoot = useFileEditorStore.getState().rootContext;
        if (editorRoot && editorRoot.projectId === event.projectId) {
          useFileEditorStore.getState().bumpRefreshToken();
          void useFileEditorStore.getState().refreshOpenBuffers();
        }
      }
    });

    syncActiveWorktrees();
    for (const project of activeProjects) {
      void refreshGitProject(project, "initial", "full", { isActive: isActiveCheck });
    }
    const unsubPendingPrRefresh = useGitStore.subscribe((state, prev) => {
      if (
        state.statuses !== prev.statuses ||
        state.prData !== prev.prData ||
        state.prDetails !== prev.prDetails
      ) {
        syncPendingPrRefreshProjects(activeProjects);
      }
    });
    const unsubActiveWorktreeApp = subscribeToFieldChanges(
      useAppStore.subscribe,
      (state) => [state.threads, state.view, state.projects],
      syncActiveWorktrees,
    );
    const unsubActiveWorktreeExperiments = subscribeToFieldChanges(
      useExperimentStore.subscribe,
      (state) => [state.experiments],
      syncActiveWorktrees,
    );
    const unsubActiveWorktreePanel = subscribeToFieldChanges(
      usePanelStore.subscribe,
      (state) => [
        state.gitReviewContext,
        state.gitReviewAsPanel,
        state.filesPanelContext,
        state.rightPanelTab,
        state.gitOverlayOpen,
      ],
      syncActiveWorktrees,
    );
    const unsubActiveWorktreeTerminal = subscribeToFieldChanges(
      useDevTerminalStore.subscribe,
      (state) => [state.isOpen, state.activeProjectId, state.activeWorktreePath],
      syncActiveWorktrees,
    );

    function fetchRemotes() {
      if (!isActive) return;
      if (typeof document !== "undefined" && !document.hasFocus()) {
        console.log("[git-refresh] fetch-skip windowFocused=false");
        return;
      }
      const now = Date.now();
      const priorityProjectIds = getPriorityProjectIds();
      const promotedProjectIds = new Set(
        [...priorityProjectIds].filter((projectId) => !previousPriorityProjectIds.has(projectId)),
      );
      const projectsToFetch = activeProjects.filter((project) => {
        if (fetchInFlight.has(project.id)) return false;
        if (lastFetchTimes.has(project.id) && !shouldPollProject(project)) return false;
        const isPriority = priorityProjectIds.has(project.id);
        const interval = isPriority
          ? GIT_FETCH_PRIORITY_INTERVAL_MS
          : GIT_FETCH_BACKGROUND_INTERVAL_MS;
        const lastFetchedAt = lastFetchTimes.get(project.id) ?? 0;
        const becamePriority = promotedProjectIds.has(project.id);
        return becamePriority || now - lastFetchedAt >= interval;
      });
      previousPriorityProjectIds = priorityProjectIds;
      if (projectsToFetch.length === 0) return;

      for (const project of projectsToFetch) {
        const token = Symbol(project.id);
        fetchInFlight.set(project.id, token);
        lastFetchTimes.set(project.id, now);
        // Network has its own lane. A slow remote cannot hold the local status queue.
        const timeout = setTimeout(() => {
          fetchTimeouts.delete(timeout);
          if (fetchInFlight.get(project.id) === token) fetchInFlight.delete(project.id);
        }, 30_000);
        fetchTimeouts.add(timeout);
        void readBridge()
          .gitFetch({
            projectLocation: project.location,
            remote: "origin",
            prune: true,
            background: true,
          })
          .catch(() => undefined)
          .then(() => {
            if (!isActive || fetchInFlight.get(project.id) !== token) return;
            // Ref updates need fresh status, not another branches/worktrees/PR snapshot.
            void refreshGitProject(project, "watcher", "status", { isActive: isActiveCheck });
          })
          .finally(() => {
            clearTimeout(timeout);
            fetchTimeouts.delete(timeout);
            if (fetchInFlight.get(project.id) === token) fetchInFlight.delete(project.id);
          });
      }
    }

    function pollPriorityWslStatus() {
      if (!isActive) return;
      if (typeof document !== "undefined" && !document.hasFocus()) return;
      const priorityProjectIds = getPriorityProjectIds();
      for (const project of activeProjects) {
        if (project.location.kind !== "wsl") continue;
        if (!shouldPollProject(project)) continue;
        if (!priorityProjectIds.has(project.id)) continue;
        void refreshGitProject(project, "poll", "status", { isActive: isActiveCheck });
      }
    }

    // Give the initial local snapshot time to paint before syncing remotes.
    // Fetch completions share the watcher quiet period for their ref updates.
    const initialFetchTimer = setTimeout(() => void fetchRemotes(), 5000);
    const fetchIntervalId = setInterval(
      () => void fetchRemotes(),
      Math.min(GIT_FETCH_PRIORITY_INTERVAL_MS, GIT_FETCH_BACKGROUND_INTERVAL_MS),
    );
    const wslStatusPollIntervalId = setInterval(pollPriorityWslStatus, WSL_STATUS_POLL_INTERVAL_MS);

    return () => {
      isActive = false;
      clearTimeout(initialFetchTimer);
      clearInterval(fetchIntervalId);
      clearInterval(wslStatusPollIntervalId);
      for (const timer of fetchTimeouts) clearTimeout(timer);
      fetchTimeouts.clear();
      fetchInFlight.clear();
      unsubPendingPrRefresh();
      unsubActiveWorktreeApp();
      unsubActiveWorktreeExperiments();
      unsubActiveWorktreePanel();
      unsubActiveWorktreeTerminal();
      stopPendingPrRefresh();
      unsubWatcher();
      for (const project of activeProjects) {
        readBridge()
          .gitUnwatchProject({ projectId: project.id })
          .catch(() => undefined);
      }
      cleanupGitRefreshProjects(new Set());
    };
  }, [storeHydrated, activeProjectsKey]);
}
