import type {
  GitStatusDetail,
  PrData,
  ProjectLocation,
  RemoteHostPlatform,
} from "@/shared/contracts";
import { isHomeProjectId } from "@/shared/homeScope";
import { readBridge } from "@/renderer/bridge";
import { useAppStore } from "@/renderer/state/appStore";
import { useExperimentStore } from "@/renderer/state/experimentStore";
import { useDevTerminalStore } from "@/renderer/state/devTerminalStore";
import { useGitStore } from "@/renderer/state/gitStore";
import { buildBranchNamePrKey, buildBranchPrKey } from "@/renderer/state/gitSelectors";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { shouldPollProject } from "@/renderer/state/wslBackgroundActivity";
import {
  GitRefreshQueue,
  type GitRefreshMode,
  type GitRefreshOptions,
  type GitRefreshReason,
} from "./gitRefreshQueue";
import { aggregatePrChecksStatus, combineChecksStatus } from "@/renderer/utils/prStatus";

export type { GitRefreshMode, GitRefreshOptions, GitRefreshReason } from "./gitRefreshQueue";

const refreshQueue = new GitRefreshQueue(({ project, reason, mode, options }) =>
  runGitProjectRefresh(project, reason, mode, options),
);
const watchedWorktreePaths = new Map<string, string>();
const activeRefreshTokens = new Map<string, symbol>();
export const PR_PENDING_REFRESH_INTERVAL_MS = 30_000;
export const PR_POST_PUSH_STATUS_WAIT_MS = 15_000;
export const PR_POST_PUSH_STATUS_POLL_MS = 5_000;

const alwaysActive = () => true;

/**
 * A remote worth trying `gh` against: an explicit GitHub remote, an as-yet
 * unclassified one ("unknown" — covers SSH host aliases that resolve to
 * github.com), or one we haven't inspected yet (undefined). This is the gate
 * every PR-fetch path checks (alongside `ghAvailable`) before paying a
 * `gh pr list` spawn — see {@link prefetchBranchPrData} and the worktree git
 * panel's manual refresh.
 */
export function mightBeGitHubRemote(platform: RemoteHostPlatform | undefined): boolean {
  return platform === undefined || platform === "github" || platform === "unknown";
}

const BRANCH_PR_PREFETCH_THROTTLE_MS = 10_000;
const branchPrPrefetchLastRun = new Map<string, number>();
const branchPrPrefetchInFlight = new Map<string, Promise<Record<string, PrData> | undefined>>();
const branchPrPrefetchCache = new Map<string, Record<string, PrData>>();

function shouldApplyPrefetchedPr(
  existing: PrData | null | undefined,
  incoming: PrData,
  fillMissingOnly: boolean,
): boolean {
  if (fillMissingOnly) return existing === undefined;
  if (!existing || existing.number !== incoming.number) return true;
  const existingUpdatedAt = Date.parse(existing.updatedAt);
  const incomingUpdatedAt = Date.parse(incoming.updatedAt);
  if (Number.isFinite(existingUpdatedAt) && Number.isFinite(incomingUpdatedAt)) {
    return incomingUpdatedAt > existingUpdatedAt;
  }
  if (existing.updatedAt && !incoming.updatedAt) return false;
  return true;
}

function mergePrefetchedPr(existing: PrData | null | undefined, incoming: PrData): PrData {
  if (
    incoming.viewerDidAuthor !== undefined ||
    existing?.number !== incoming.number ||
    existing?.viewerDidAuthor === undefined
  ) {
    return incoming;
  }
  return { ...incoming, viewerDidAuthor: existing.viewerDidAuthor };
}

function applyPrefetchedPrData(
  projectId: string,
  prs: Record<string, PrData>,
  fillMissingOnly: boolean,
): void {
  const gitState = useGitStore.getState();
  const updates: Record<string, PrData> = {};
  const queueUpdate = (key: string, pr: PrData | undefined) => {
    if (!pr) return;
    const existing = gitState.prData[key];
    if (shouldApplyPrefetchedPr(existing, pr, fillMissingOnly)) {
      updates[key] = mergePrefetchedPr(existing, pr);
    }
  };
  for (const [branch, pr] of Object.entries(prs)) {
    queueUpdate(buildBranchNamePrKey(projectId, branch), pr);
  }

  const appState = useAppStore.getState();
  const worktreeBranches = new Map<string, string>();

  for (const thread of appState.threads) {
    if (
      thread.projectId === projectId &&
      !thread.archived &&
      thread.worktreePath &&
      thread.worktreeBranch
    ) {
      worktreeBranches.set(thread.worktreePath, thread.worktreeBranch);
    }
  }
  for (const worktree of gitState.worktrees[projectId] ?? []) {
    if (!worktree.isMain && worktree.branch) {
      worktreeBranches.set(worktree.path, worktree.branch);
    }
  }

  for (const [worktreePath, branch] of worktreeBranches) {
    queueUpdate(worktreePath, prs[branch]);
  }

  const currentBranch = gitState.statuses[projectId]?.branch;
  if (currentBranch) {
    queueUpdate(buildBranchPrKey(projectId), prs[currentBranch]);
  }

  if (Object.keys(updates).length > 0) {
    useGitStore.getState().setPrDataBatch(updates);
  }
}

/**
 * Bulk-fetch PR status for every branch of a project in one `gh pr list` call and
 * cache it under branch-name keys (see {@link buildBranchNamePrKey}) so the branch
 * selector can show PR-status icons for remote/local branches that aren't checked
 * out as a worktree. Dedupes in-flight calls, throttles (so dropdown opens + the
 * refresh cycle don't spam `gh`), and self-gates on gh availability + a GitHub
 * remote. Results persist for free via the gitStore prData snapshot, so cached
 * icons show instantly and refresh in place.
 */
export async function prefetchBranchPrData(
  project: {
    id: string;
    location: ProjectLocation;
  },
  background = false,
): Promise<void> {
  await loadBranchPrData(project, false, background);
}

async function loadBranchPrData(
  project: { id: string; location: ProjectLocation },
  force = false,
  background = false,
  isActive = alwaysActive,
): Promise<Record<string, PrData> | undefined> {
  const cachedPrs = branchPrPrefetchCache.get(project.id);
  if (cachedPrs) applyPrefetchedPrData(project.id, cachedPrs, true);

  const inFlight = branchPrPrefetchInFlight.get(project.id);
  if (inFlight) return inFlight;
  const last = branchPrPrefetchLastRun.get(project.id) ?? 0;
  if (!force && Date.now() - last < BRANCH_PR_PREFETCH_THROTTLE_MS) return cachedPrs;
  const state = useGitStore.getState();
  if (!state.ghAvailable[project.id]) return;
  if (!mightBeGitHubRemote(state.statuses[project.id]?.remoteInfo?.platform)) return;

  branchPrPrefetchLastRun.set(project.id, Date.now());
  const promise = (async () => {
    try {
      const { prs } = await readBridge().ghListPrs({
        projectLocation: project.location,
        ...(background ? { background: true } : {}),
      });
      // Cleanup invalidates writes without pretending the IPC request was cancelled.
      if (isActive() && branchPrPrefetchLastRun.has(project.id)) {
        branchPrPrefetchCache.set(project.id, prs);
        applyPrefetchedPrData(project.id, prs, false);
      }
      return prs;
    } catch (err) {
      console.warn(`[git-refresh] ghListPrs failed project=${project.id}`, err);
      return undefined;
    } finally {
      branchPrPrefetchInFlight.delete(project.id);
    }
  })();
  branchPrPrefetchInFlight.set(project.id, promise);
  return promise;
}

/** Refresh PR data only while Git is visibly scoped to this real project/worktree. */
export function prefetchVisibleGitPanelPrData(
  projectId: string,
  worktreePath: string | undefined,
): Promise<void> {
  if (isHomeProjectId(projectId)) return Promise.resolve();
  const panel = usePanelStore.getState();
  if (
    !panel.gitReviewAsPanel ||
    panel.gitReviewContext?.projectId !== projectId ||
    panel.gitReviewContext.worktreePath !== worktreePath
  ) {
    return Promise.resolve();
  }
  const project = useAppStore.getState().projects.find((item) => item.id === projectId);
  return project ? prefetchBranchPrData(project) : Promise.resolve();
}

/** Exact diff counts are needed only for an explicit refresh or a visible Git review. */
function getWorktreeStatusDetail(
  projectId: string,
  reason: GitRefreshReason,
  worktreePath?: string,
): GitStatusDetail {
  if (reason === "manual") return "full";
  const panel = usePanelStore.getState();
  return panel.gitReviewContext?.projectId === projectId &&
    panel.gitReviewContext.worktreePath === worktreePath &&
    ((panel.gitReviewAsPanel && panel.rightPanelTab === "git") || panel.gitOverlayOpen)
    ? "full"
    : "summary";
}

export function getWatcherRefreshMode(projectId: string): GitRefreshMode {
  return useGitStore.getState().statuses[projectId]?.isRepo === false ? "full" : "status";
}

type ActiveGitProject = { id: string; location: ProjectLocation };

interface PendingPrRefreshTarget {
  projectId: string;
  projectLocation: ProjectLocation;
  prKey: string;
  branch: string;
  detailsCacheKey: string;
  prNumber: number;
}

interface PendingPrRefreshEntry {
  target: PendingPrRefreshTarget;
  intervalId: ReturnType<typeof setInterval>;
  inFlight: boolean;
}

const pendingPrRefreshEntries = new Map<string, PendingPrRefreshEntry>();
let pendingPrRefreshActiveProjects: readonly ActiveGitProject[] = [];

interface PostPushPrRefreshTarget {
  projectId: string;
  projectLocation: ProjectLocation;
  prKey: string;
  branch: string;
}

interface PostPushPrRefreshEntry {
  target: PostPushPrRefreshTarget;
  timeoutId: ReturnType<typeof setTimeout>;
  attempts: number;
  latest: PrData | null | undefined;
}

const postPushPrRefreshEntries = new Map<string, PostPushPrRefreshEntry>();

function isRefreshCurrent(projectId: string, token: symbol, isActive: () => boolean): boolean {
  return isActive() && activeRefreshTokens.get(projectId) === token;
}

function addPanelContextWorktreePath(
  paths: Set<string>,
  projectId: string,
  enabled: boolean,
  context: { projectId: string; worktreePath?: string } | null,
): void {
  if (enabled && context?.projectId === projectId && context.worktreePath) {
    paths.add(context.worktreePath);
  }
}

export function getProjectActiveWorktreePaths(projectId: string): string[] {
  const appState = useAppStore.getState();
  const panelState = usePanelStore.getState();
  const paths = new Set<string>();
  const experimentState = useExperimentStore.getState();

  for (const experiment of Object.values(experimentState.experiments)) {
    if (
      experiment.projectId !== projectId ||
      (experiment.status !== "running" &&
        !(appState.view.kind === "experiment" && appState.view.experimentId === experiment.id))
    ) {
      continue;
    }
    for (const candidate of experiment.candidates) {
      const worktreePath = appState.threads.find(
        (thread) => thread.id === candidate.threadId,
      )?.worktreePath;
      if (worktreePath) paths.add(worktreePath);
    }
  }

  if (appState.view.kind === "thread") {
    const paneIds = new Set(appState.view.panes);
    for (const thread of appState.threads) {
      if (
        thread.projectId === projectId &&
        !thread.archived &&
        paneIds.has(thread.id) &&
        thread.worktreePath
      ) {
        paths.add(thread.worktreePath);
      }
    }
  }

  addPanelContextWorktreePath(
    paths,
    projectId,
    (panelState.rightPanelTab === "git" && panelState.gitReviewAsPanel) ||
      panelState.gitOverlayOpen,
    panelState.gitReviewContext,
  );
  addPanelContextWorktreePath(
    paths,
    projectId,
    panelState.rightPanelTab === "files",
    panelState.filesPanelContext,
  );

  const terminalState = useDevTerminalStore.getState();
  const terminalIsVisible =
    terminalState.isOpen &&
    (useSharedSettings.getState().terminalPosition === "bottom" ||
      panelState.rightPanelTab === "terminal");
  if (
    terminalIsVisible &&
    terminalState.activeProjectId === projectId &&
    terminalState.activeWorktreePath
  ) {
    paths.add(terminalState.activeWorktreePath);
  }

  return Array.from(paths).sort();
}

function getProjectActiveWorktreePathSet(projectId: string): Set<string> {
  return new Set(getProjectActiveWorktreePaths(projectId));
}

export function syncWatchedWorktreeProject(projectId: string): string[] {
  const worktreePaths = getProjectActiveWorktreePaths(projectId);
  const wtPaths = worktreePaths.join("\0");
  if (wtPaths !== watchedWorktreePaths.get(projectId)) {
    watchedWorktreePaths.set(projectId, wtPaths);
    readBridge()
      .gitWatchWorktrees({
        projectId,
        worktreePaths,
      })
      .catch(() => undefined);
  }
  return worktreePaths;
}

export function syncWatchedWorktreeProjects(activeProjects: readonly ActiveGitProject[]): void {
  for (const project of activeProjects) {
    syncWatchedWorktreeProject(project.id);
  }
}

function getActiveWorktreeBranchThreads(projectId: string) {
  const activePaths = getProjectActiveWorktreePathSet(projectId);
  if (activePaths.size === 0) return [];
  return useAppStore.getState().threads.filter((thread) => {
    if (thread.projectId !== projectId || !thread.worktreePath || !thread.worktreeBranch) {
      return false;
    }
    return activePaths.has(thread.worktreePath);
  });
}

function buildPendingPrRefreshTargets(
  activeProjects: readonly ActiveGitProject[],
): Map<string, PendingPrRefreshTarget> {
  const targets = new Map<string, PendingPrRefreshTarget>();
  const gitState = useGitStore.getState();
  const appState = useAppStore.getState();

  function visitBranchPr(project: ActiveGitProject, prKey: string, branch: string) {
    const pr = gitState.prData[prKey];
    if (!pr) return;
    const detailsCacheKey = `${project.id}#${pr.number}`;
    const details = gitState.prDetails[detailsCacheKey];
    const detailsStatus = aggregatePrChecksStatus(details?.checks);
    const checksStatus = combineChecksStatus(detailsStatus, pr.checksStatus);
    if (pr.state !== "open" || checksStatus !== "PENDING") return;
    targets.set(detailsCacheKey, {
      projectId: project.id,
      projectLocation: project.location,
      prKey,
      branch,
      detailsCacheKey,
      prNumber: pr.number,
    });
  }

  for (const project of activeProjects) {
    const status = gitState.statuses[project.id];
    if (status?.branch) {
      visitBranchPr(project, buildBranchPrKey(project.id), status.branch);
    }
    const activeWorktreePaths = getProjectActiveWorktreePathSet(project.id);
    for (const thread of appState.threads) {
      if (thread.projectId !== project.id || !thread.worktreePath || !thread.worktreeBranch) {
        continue;
      }
      if (!activeWorktreePaths.has(thread.worktreePath)) continue;
      visitBranchPr(project, thread.worktreePath, thread.worktreeBranch);
    }
  }

  return targets;
}

function didPendingPrSettle(target: PendingPrRefreshTarget): boolean {
  const gitState = useGitStore.getState();
  const pr = gitState.prData[target.prKey];
  if (pr === null) return true;
  if (!pr || pr.number !== target.prNumber) return false;
  const detailsStatus = aggregatePrChecksStatus(gitState.prDetails[target.detailsCacheKey]?.checks);
  const checksStatus = combineChecksStatus(detailsStatus, pr.checksStatus);
  return checksStatus === "SUCCESS" || checksStatus === "FAILURE";
}

function requestSettledPrCheck(target: PendingPrRefreshTarget): void {
  void readBridge()
    .checkPrWatch({ projectId: target.projectId, prNumber: target.prNumber })
    .catch(() => undefined);
}

/**
 * Fetch a single PR's data (and its details, when a number + cache key are
 * known) and write both into the git store. Shared by the background
 * pending-PR poll and the on-demand refresh affordances (the PR block's
 * refresh icon and the worktree git panel's refresh button) so every surface
 * lands the same `setPrData` / `setPrDetails` shape. Network errors are
 * swallowed per request — a failed refresh leaves the cached snapshot intact.
 */
export async function refreshSinglePr(params: {
  projectLocation: ProjectLocation;
  prKey: string;
  branch: string;
  projectId?: string;
  detailsCacheKey?: string;
  prNumber?: number;
  background?: boolean;
}): Promise<PrData | null | undefined> {
  const bridge = readBridge();
  const background = params.background ? { background: true } : {};
  const prPromise = bridge
    .ghGetPrForBranch({
      projectLocation: params.projectLocation,
      branch: params.branch,
      ...background,
    })
    .catch(() => undefined);
  const detailsPromise =
    params.detailsCacheKey && params.prNumber
      ? bridge
          .ghGetPrDetails({
            projectLocation: params.projectLocation,
            prNumber: params.prNumber,
            ...background,
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);
  const [pr, details] = await Promise.all([prPromise, detailsPromise]);
  if (pr !== undefined) {
    useGitStore.getState().setPrData(params.prKey, pr);
  }
  if (params.detailsCacheKey && details) {
    useGitStore.getState().setPrDetails(params.detailsCacheKey, details.details);
  }
  if (!params.detailsCacheKey && params.projectId && pr && pr.number !== params.prNumber) {
    const discoveredDetails = await bridge
      .ghGetPrDetails({
        projectLocation: params.projectLocation,
        prNumber: pr.number,
        ...background,
      })
      .catch(() => undefined);
    if (discoveredDetails) {
      useGitStore
        .getState()
        .setPrDetails(`${params.projectId}#${pr.number}`, discoveredDetails.details);
    }
  }
  return pr;
}

async function refreshPendingPr(key: string): Promise<void> {
  const entry = pendingPrRefreshEntries.get(key);
  if (!entry || entry.inFlight) return;
  entry.inFlight = true;
  try {
    await refreshSinglePr({ ...entry.target, background: true });
  } finally {
    const current = pendingPrRefreshEntries.get(key);
    if (current) current.inFlight = false;
    if (pendingPrRefreshActiveProjects.length > 0) {
      syncPendingPrRefreshProjects(pendingPrRefreshActiveProjects);
    }
  }
}

function isPostPushPrRefreshTargetActive(target: PostPushPrRefreshTarget): boolean {
  const gitState = useGitStore.getState();
  const pr = gitState.prData[target.prKey];
  if (!pr || pr.state !== "open") return false;
  const appState = useAppStore.getState();
  if (appState.projects.length > 0 && !appState.projects.some((p) => p.id === target.projectId)) {
    return false;
  }
  if (target.prKey === buildBranchPrKey(target.projectId)) {
    return gitState.statuses[target.projectId]?.branch === target.branch;
  }
  const activeWorktreePaths = getProjectActiveWorktreePathSet(target.projectId);
  return appState.threads.some(
    (thread) =>
      thread.projectId === target.projectId &&
      thread.worktreePath === target.prKey &&
      activeWorktreePaths.has(thread.worktreePath) &&
      thread.worktreeBranch === target.branch,
  );
}

async function refreshPostPushPr(key: string): Promise<void> {
  const entry = postPushPrRefreshEntries.get(key);
  if (!entry) return;
  if (!isPostPushPrRefreshTargetActive(entry.target)) {
    clearTimeout(entry.timeoutId);
    postPushPrRefreshEntries.delete(key);
    return;
  }

  entry.attempts += 1;
  const pr = await readBridge()
    .ghGetPrForBranch({
      projectLocation: entry.target.projectLocation,
      branch: entry.target.branch,
      background: true,
    })
    .catch(() => undefined);
  if (postPushPrRefreshEntries.get(key) !== entry) return;
  if (!isPostPushPrRefreshTargetActive(entry.target)) {
    postPushPrRefreshEntries.delete(key);
    return;
  }
  if (pr !== undefined) {
    entry.latest = pr;
    if (pr?.state === "open" && pr.checksStatus === "PENDING") {
      useGitStore.getState().setPrData(entry.target.prKey, pr);
      postPushPrRefreshEntries.delete(key);
      return;
    }
  }

  if (entry.attempts * PR_POST_PUSH_STATUS_POLL_MS >= PR_POST_PUSH_STATUS_WAIT_MS) {
    if (entry.latest !== undefined) {
      useGitStore.getState().setPrData(entry.target.prKey, entry.latest);
    }
    postPushPrRefreshEntries.delete(key);
    return;
  }

  entry.timeoutId = setTimeout(() => void refreshPostPushPr(key), PR_POST_PUSH_STATUS_POLL_MS);
}

export function startPostPushPrStatusRefresh(target: PostPushPrRefreshTarget): void {
  const currentPr = useGitStore.getState().prData[target.prKey];
  if (!currentPr || currentPr.state !== "open") return;
  const existing = postPushPrRefreshEntries.get(target.prKey);
  if (existing) clearTimeout(existing.timeoutId);
  postPushPrRefreshEntries.set(target.prKey, {
    target,
    timeoutId: setTimeout(() => void refreshPostPushPr(target.prKey), PR_POST_PUSH_STATUS_POLL_MS),
    attempts: 0,
    latest: undefined,
  });
}

export function syncPendingPrRefreshProjects(activeProjects: readonly ActiveGitProject[]): void {
  pendingPrRefreshActiveProjects = activeProjects;
  const targets = buildPendingPrRefreshTargets(activeProjects.filter(shouldPollProject));
  for (const [key, entry] of pendingPrRefreshEntries) {
    const target = targets.get(key);
    if (!target) {
      clearInterval(entry.intervalId);
      pendingPrRefreshEntries.delete(key);
      if (
        activeProjects.some(
          (project) => project.id === entry.target.projectId && shouldPollProject(project),
        ) &&
        didPendingPrSettle(entry.target)
      ) {
        requestSettledPrCheck(entry.target);
      }
      continue;
    }
    entry.target = target;
  }
  for (const [key, target] of targets) {
    if (pendingPrRefreshEntries.has(key)) continue;
    pendingPrRefreshEntries.set(key, {
      target,
      intervalId: setInterval(() => void refreshPendingPr(key), PR_PENDING_REFRESH_INTERVAL_MS),
      inFlight: false,
    });
    void refreshPendingPr(key);
  }
}

export function stopPendingPrRefresh(): void {
  pendingPrRefreshActiveProjects = [];
  for (const entry of pendingPrRefreshEntries.values()) {
    clearInterval(entry.intervalId);
  }
  pendingPrRefreshEntries.clear();
  for (const entry of postPushPrRefreshEntries.values()) {
    clearTimeout(entry.timeoutId);
  }
  postPushPrRefreshEntries.clear();
}

export function cleanupGitRefreshProjects(activeProjectIds: ReadonlySet<string>): void {
  refreshQueue.clearInactive(activeProjectIds);
  for (const projectId of watchedWorktreePaths.keys()) {
    if (!activeProjectIds.has(projectId)) watchedWorktreePaths.delete(projectId);
  }
  for (const projectId of activeRefreshTokens.keys()) {
    if (!activeProjectIds.has(projectId)) activeRefreshTokens.delete(projectId);
  }
  const stalePrefetchProjectIds = new Set([
    ...branchPrPrefetchCache.keys(),
    ...branchPrPrefetchLastRun.keys(),
    ...branchPrPrefetchInFlight.keys(),
  ]);
  for (const projectId of stalePrefetchProjectIds) {
    if (activeProjectIds.has(projectId)) continue;
    branchPrPrefetchCache.delete(projectId);
    branchPrPrefetchLastRun.delete(projectId);
  }
  for (const [key, entry] of postPushPrRefreshEntries) {
    if (activeProjectIds.has(entry.target.projectId)) continue;
    clearTimeout(entry.timeoutId);
    postPushPrRefreshEntries.delete(key);
  }
}

async function refreshWorktreeStatuses(
  project: ActiveGitProject,
  paths: readonly string[],
  reason: GitRefreshReason,
  isActive: () => boolean,
): Promise<void> {
  await Promise.all(
    (["summary", "full"] as const).map(async (detail) => {
      const worktreePaths = paths.filter(
        (path) => getWorktreeStatusDetail(project.id, reason, path) === detail,
      );
      if (worktreePaths.length === 0 || !isActive()) return;
      const batch = await readBridge()
        .gitWorktreeStatusBatch({
          projectLocation: project.location,
          worktreePaths,
          detail,
          ...(reason !== "manual" ? { background: true } : {}),
        })
        .catch(() => undefined);
      if (isActive() && batch && Object.keys(batch.statuses).length > 0) {
        useGitStore.getState().setWorktreeStatuses(batch.statuses);
      }
    }),
  );
}

async function refreshProjectStatusOnly(
  project: { id: string; location: ProjectLocation },
  reason: GitRefreshReason,
  isActive: () => boolean,
): Promise<void> {
  const statusResult = await readBridge()
    .getGitStatus({
      projectLocation: project.location,
      detail: getWorktreeStatusDetail(project.id, reason),
      ...(reason !== "manual" ? { background: true } : {}),
    })
    .catch(() => undefined);
  if (!isActive()) return;
  if (statusResult) {
    useGitStore.getState().setStatus(project.id, statusResult);
  }

  await refreshWorktreeStatuses(
    project,
    getProjectActiveWorktreePaths(project.id),
    reason,
    isActive,
  );
}

export async function refreshGitProject(
  project: { id: string; location: ProjectLocation },
  reason: GitRefreshReason,
  mode: GitRefreshMode = "full",
  options: GitRefreshOptions = {},
): Promise<void> {
  await refreshQueue.enqueue({ project, reason, mode, options });
}

async function runGitProjectRefresh(
  project: { id: string; location: ProjectLocation },
  reason: GitRefreshReason,
  mode: GitRefreshMode,
  options: GitRefreshOptions,
): Promise<void> {
  const isActive = options.isActive ?? alwaysActive;
  if (!isActive()) return;
  const startedAt = Date.now();
  console.log(`[git-refresh] start project=${project.id} reason=${reason} mode=${mode}`);
  const refreshToken = Symbol(project.id);
  activeRefreshTokens.set(project.id, refreshToken);
  try {
    await (async () => {
      if (options.fetchRemote) {
        try {
          await readBridge().gitFetch({
            projectLocation: project.location,
            remote: "origin",
            prune: true,
            // A watcher/poll can absorb a scheduled fetch in the refresh queue.
            // Only an explicit manual refresh upgrades that fetch to interactive.
            ...(reason !== "manual" ? { background: true } : {}),
          });
        } catch {
          // ignore — remote may be unreachable
        }
        if (!isRefreshCurrent(project.id, refreshToken, isActive)) return;
      }

      if (mode === "status") {
        await refreshProjectStatusOnly(project, reason, () =>
          isRefreshCurrent(project.id, refreshToken, isActive),
        );
        return;
      }

      // One IPC round-trip pulls status + branches + worktrees (+ gh check
      // when not cached) via supervisor-side Promise.all. Cuts three IPC
      // handshakes to one and lets the supervisor parallelize freely. Each
      // field writes to the store as soon as the bundle lands.
      const cachedGhAvailable = useGitStore.getState().ghAvailable[project.id] === true;
      const snapshotPromise = readBridge()
        .gitProjectSnapshot({
          projectLocation: project.location,
          includeGhCheck: !cachedGhAvailable,
          ...(reason !== "manual" ? { background: true } : {}),
        })
        .then((snap) => {
          if (!isRefreshCurrent(project.id, refreshToken, isActive)) return snap;
          const store = useGitStore.getState();
          if (snap.status) store.setStatus(project.id, snap.status);
          if (snap.branches) store.setBranches(project.id, snap.branches);
          if (snap.worktrees) store.setWorktrees(project.id, snap.worktrees);
          if (snap.ghAvailable === true) store.setGhAvailable(project.id, true);
          return snap;
        })
        .catch((err) => {
          console.warn(`[git-refresh] gitProjectSnapshot failed project=${project.id}`, err);
          return null;
        });

      const statusPromise = snapshotPromise.then((snap) => snap?.status ?? undefined);
      const worktreesPromise = snapshotPromise.then((snap) => snap?.worktrees ?? undefined);

      // Share the sidebar's bulk request with this cycle. The query includes all
      // PR states but is capped at 100: only returned branches are covered, so
      // an absent branch must still use the branch-specific lookup.
      const bulkPrsPromise = snapshotPromise.then(() => {
        if (!isRefreshCurrent(project.id, refreshToken, isActive)) return;
        return loadBranchPrData(
          project,
          reason === "manual" || reason === "fetch",
          reason !== "manual",
          () => isRefreshCurrent(project.id, refreshToken, isActive),
        );
      });
      const branchPrPromises = new Map<string, Promise<PrData | null>>();
      function getBranchPr(branch: string): Promise<PrData | null> {
        let promise = branchPrPromises.get(branch);
        if (!promise) {
          promise = bulkPrsPromise.then((prs) => {
            if (prs && Object.hasOwn(prs, branch)) return prs[branch]!;
            if (!isRefreshCurrent(project.id, refreshToken, isActive)) return null;
            return readBridge().ghGetPrForBranch({
              projectLocation: project.location,
              branch,
              ...(reason !== "manual" ? { background: true } : {}),
            });
          });
          branchPrPromises.set(branch, promise);
        }
        return promise;
      }
      function queuePrUpdate(key: string, pr: PrData | null): void {
        prUpdates[key] = pr ? mergePrefetchedPr(useGitStore.getState().prData[key], pr) : null;
      }

      const ghAvailablePromise: Promise<boolean> = cachedGhAvailable
        ? Promise.resolve(true)
        : snapshotPromise.then((snap) => {
            const platform = snap?.status?.remoteInfo?.platform;
            const mightBeGitHub = platform === "github" || platform === "unknown";
            if (!mightBeGitHub) return false;
            return snap?.ghAvailable === true;
          });

      // Worktree-derived work (per-worktree status + source branch) starts as
      // soon as `gitListWorktrees` returns — doesn't wait for status/branches.
      const worktreeWorkPromise = worktreesPromise.then(async (worktrees) => {
        if (!worktrees) return;
        if (!isRefreshCurrent(project.id, refreshToken, isActive)) return;
        const childWorktrees = worktrees.filter((wt) => !wt.isMain);
        const watchWorktreePaths = syncWatchedWorktreeProject(project.id);
        const watchedWorktreePathSet = new Set(watchWorktreePaths);
        const activeChildWorktrees = childWorktrees.filter((wt) =>
          watchedWorktreePathSet.has(wt.path),
        );

        const statusesPromise =
          (reason === "fetch" && project.location.kind !== "wsl") || watchWorktreePaths.length === 0
            ? Promise.resolve()
            : refreshWorktreeStatuses(project, watchWorktreePaths, reason, () =>
                isRefreshCurrent(project.id, refreshToken, isActive),
              );

        const sourceInfoPromise = Promise.all(
          activeChildWorktrees
            .filter((wt) => wt.branch)
            .map(async (wt) => {
              try {
                const info = await readBridge().gitGetWorktreeSourceBranch({
                  projectLocation: project.location,
                  branch: wt.branch,
                  ...(reason !== "manual" ? { background: true } : {}),
                });
                return [
                  wt.path,
                  {
                    sourceBranch: info.sourceBranch,
                    commitsAhead: info.commitsAhead,
                    sourceAhead: info.sourceAhead,
                  },
                ] as const;
              } catch {
                return undefined;
              }
            }),
        ).then((entries) => {
          if (!isRefreshCurrent(project.id, refreshToken, isActive)) return;
          const next = Object.fromEntries(entries.filter((e) => e !== undefined));
          if (Object.keys(next).length > 0) {
            useGitStore.getState().setWorktreeSourceInfoBatch(next);
          }
        });

        await Promise.all([statusesPromise, sourceInfoPromise]);
      });

      // PR fetches: each one starts the moment its prerequisites resolve.
      // Worktree-thread PRs only need `ghAvailable`; project PR also needs
      // `status.branch`. They run concurrently with everything above.
      const prUpdates: Record<string, PrData | null> = {};
      const prNumberUpdates = new Map<string, number | undefined>();
      const wtThreads = getActiveWorktreeBranchThreads(project.id);

      const wtPrPromises = wtThreads.map(async (t) => {
        const ghAvailable = await ghAvailablePromise;
        if (!isRefreshCurrent(project.id, refreshToken, isActive)) return;
        if (!ghAvailable || !t.worktreeBranch || !t.worktreePath) return;
        try {
          const pr = await getBranchPr(t.worktreeBranch);
          queuePrUpdate(t.worktreePath, pr);
          const newPrNumber = pr?.number ?? undefined;
          if (newPrNumber !== t.prNumber) {
            prNumberUpdates.set(t.id, newPrNumber);
          }
        } catch (err) {
          console.warn(
            `[git-refresh] ghGetPrForBranch failed (worktree) project=${project.id} branch=${t.worktreeBranch}`,
            err,
          );
        }
      });

      const projectPrPromise = (async () => {
        const [status, ghAvailable] = await Promise.all([statusPromise, ghAvailablePromise]);
        if (!isRefreshCurrent(project.id, refreshToken, isActive)) return;
        if (!ghAvailable || !status?.branch) return;
        const platform = status.remoteInfo?.platform;
        if (platform !== "github" && platform !== "unknown") return;
        try {
          const pr = await getBranchPr(status.branch);
          queuePrUpdate(buildBranchPrKey(project.id), pr);
        } catch (err) {
          console.warn(
            `[git-refresh] ghGetPrForBranch failed (project) project=${project.id} branch=${status.branch}`,
            err,
          );
        }
      })();

      await Promise.all([
        snapshotPromise,
        bulkPrsPromise,
        worktreeWorkPromise,
        ...wtPrPromises,
        projectPrPromise,
      ]);

      if (!isRefreshCurrent(project.id, refreshToken, isActive)) return;
      if (Object.keys(prUpdates).length > 0) {
        useGitStore.getState().setPrDataBatch(prUpdates);
      }
      if (prNumberUpdates.size > 0) {
        useAppStore.setState((state) => {
          let changed = false;
          const nextThreads = state.threads.map((thread) => {
            if (!prNumberUpdates.has(thread.id)) return thread;
            const nextPrNumber = prNumberUpdates.get(thread.id);
            if (thread.prNumber === nextPrNumber) return thread;
            changed = true;
            return { ...thread, prNumber: nextPrNumber };
          });
          return changed ? { threads: nextThreads } : state;
        });
      }
    })();
    if (reason === "watcher" && isRefreshCurrent(project.id, refreshToken, isActive)) {
      useGitStore.getState().bumpWorktreeStatusRevisions(getProjectActiveWorktreePaths(project.id));
    }
  } finally {
    console.log(
      `[git-refresh] done project=${project.id} reason=${reason} mode=${mode} durationMs=${Date.now() - startedAt}`,
    );
    if (activeRefreshTokens.get(project.id) === refreshToken) {
      activeRefreshTokens.delete(project.id);
    }
  }
}
