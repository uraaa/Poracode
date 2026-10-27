import type { GitStatusDetail, GitStatusResult, ProjectLocation } from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";

const latestReads = new Map<string, { sequence: number; published: number; pending: number }>();

function startRead(key: string) {
  const entry = latestReads.get(key) ?? { sequence: 0, published: 0, pending: 0 };
  latestReads.set(key, entry);
  entry.pending++;
  const sequence = ++entry.sequence;
  return {
    accept: () => {
      if (sequence < entry.published) return false;
      entry.published = sequence;
      return true;
    },
    finish: () => {
      if (--entry.pending === 0) latestReads.delete(key);
    },
  };
}

/** Independent project/source reads use the same ordering without sharing in-flight reads. */
export async function readFreshGitValue<T>(
  location: ProjectLocation,
  key: string,
  read: () => Promise<T>,
): Promise<T | undefined> {
  const pending = startRead(`${JSON.stringify(location)}\0${key}`);
  try {
    const value = await read();
    return pending.accept() ? value : undefined;
  } finally {
    pending.finish();
  }
}

/** A status-only watcher must not discard the other fields of a full snapshot. */
export async function readFreshProjectSnapshot(location: ProjectLocation, includeGhCheck: boolean) {
  const pending = startRead(`${JSON.stringify(location)}\0project-status`);
  try {
    const snapshot = await readBridge().gitProjectSnapshot({
      projectLocation: location,
      includeGhCheck,
    });
    return snapshot.status && !pending.accept() ? { ...snapshot, status: null } : snapshot;
  } finally {
    pending.finish();
  }
}

/** Never share reads across a mutation; prefer the newest successful result for each path. */
export async function readFreshWorktreeStatuses(
  projectLocation: ProjectLocation,
  worktreePaths: string[],
  detail: GitStatusDetail,
): Promise<Record<string, GitStatusResult>> {
  return readFreshGitBatch(projectLocation, "status", worktreePaths, async () => {
    const batch = await readBridge().gitWorktreeStatusBatch({
      projectLocation,
      worktreePaths,
      detail,
    });
    return batch.statuses;
  });
}

/** Hold generations through the whole batch, including paths that finish before slow siblings. */
export async function readFreshGitBatch<T>(
  location: ProjectLocation,
  namespace: string,
  paths: string[],
  load: () => Promise<Record<string, T>>,
): Promise<Record<string, T>> {
  const reads = paths.map((path) => ({
    path,
    ...startRead(`${JSON.stringify(location)}\0${namespace}:${path}`),
  }));
  try {
    const batch = await load();
    const values: Record<string, T> = {};
    for (const read of reads) {
      const value = batch[read.path];
      if (value !== undefined && read.accept()) values[read.path] = value;
    }
    return values;
  } finally {
    for (const read of reads) read.finish();
  }
}
