import type { SupervisorIpcHandlerMap } from "@/shared/ipc";
import { pollingRepositoryRequest, repositoryMutation } from "./scheduling";

const readProcedures = [
  "listFileCheckpoints",
  "getGitStatus",
  "getExperimentCandidateStats",
  "gitListBranches",
  "gitListWorktrees",
  "gitGetWorktreeSourceBranch",
  "gitGetWorktreeOwner",
  "gitProjectSnapshot",
  "gitWorktreeStatusBatch",
  "ghCheckAvailable",
  "ghGetPrForBranch",
  "ghListPrs",
  "ghListPullRequests",
  "ghListWorkflows",
  "ghListWorkflowRuns",
  "ghGetWorkflowRun",
  "ghGetPrChecks",
  "ghGetPrDetails",
] as const satisfies readonly (keyof SupervisorIpcHandlerMap)[];

const mutationProcedures = [
  "restoreFileCheckpoint",
  "gitStage",
  "gitUnstage",
  "gitRevert",
  "gitStageAll",
  "gitUnstageAll",
  "gitRevertAll",
  "gitCommit",
  "gitInit",
  "gitAddRemote",
  "createExperimentWorktrees",
  "removeExperimentWorktrees",
  "gitFetch",
  "gitAddWorktree",
  "gitRemoveWorktree",
  "gitPruneWorktrees",
  "gitDeleteBranch",
  "gitSwitchBranch",
  "gitPull",
  "gitPullRebase",
  "gitPush",
  "gitSync",
  "gitSyncRebase",
  "gitMergeToSource",
  "gitPullFromSource",
  "gitAbortMerge",
  "gitFinishMerge",
  "relocateProject",
  "ghCreatePr",
  "ghMergePr",
  "ghClosePr",
  "ghReopenPr",
  "ghMarkPrReady",
  "ghUpdatePrBranch",
  "writeProjectFile",
  "writeExternalFile",
  "createProjectEntry",
  "renameProjectEntry",
  "moveProjectEntry",
  "deleteProjectEntry",
] as const satisfies readonly (keyof SupervisorIpcHandlerMap)[];

function wrapRead<Name extends (typeof readProcedures)[number]>(
  handlers: SupervisorIpcHandlerMap,
  name: Name,
): void {
  type Handler = SupervisorIpcHandlerMap[Name];
  type Payload = Parameters<Handler>[0];
  const handler = handlers[name] as (payload: Payload) => ReturnType<Handler>;
  handlers[name] = ((payload: Payload) => {
    // Procedure names describe work, not who asked. User, MCP and remote reads
    // remain interactive unless the caller explicitly opts into polling.
    if (!(payload as { background?: boolean }).background) return handler(payload);
    return pollingRepositoryRequest(
      JSON.stringify([name, payload]),
      async () => handler(payload),
      name.startsWith("gh") ? "network" : "background",
    );
  }) as Handler;
}

function wrapMutation<Name extends (typeof mutationProcedures)[number]>(
  handlers: SupervisorIpcHandlerMap,
  name: Name,
): void {
  type Handler = SupervisorIpcHandlerMap[Name];
  type Payload = Parameters<Handler>[0];
  const handler = handlers[name] as (payload: Payload) => ReturnType<Handler>;
  handlers[name] = ((payload: Payload) => {
    const run = () => repositoryMutation(async () => handler(payload));
    if (name === "gitFetch" && (payload as { background?: boolean }).background) {
      return pollingRepositoryRequest(JSON.stringify([name, payload]), run, "network");
    }
    return run();
  }) as Handler;
}

/** Caller scheduling hints are additive; old callers keep interactive behavior. */
export function configureRepositoryIpcScheduling(handlers: SupervisorIpcHandlerMap): void {
  for (const name of readProcedures) wrapRead(handlers, name);
  for (const name of mutationProcedures) wrapMutation(handlers, name);
}
