import type { GitStatusDetail, GitStatusResult, ProjectLocation } from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";

const latestReads = new Map<string, symbol>();

/** Never share status reads across a mutation; only the newest read may publish each path. */
export async function readFreshWorktreeStatuses(
  projectLocation: ProjectLocation,
  worktreePaths: string[],
  detail: GitStatusDetail,
): Promise<Record<string, GitStatusResult>> {
  const token = Symbol();
  for (const path of worktreePaths) latestReads.set(path, token);
  const batch = await readBridge().gitWorktreeStatusBatch({
    projectLocation,
    worktreePaths,
    detail,
  });
  return Object.fromEntries(
    Object.entries(batch.statuses).filter(([path]) => latestReads.get(path) === token),
  );
}
