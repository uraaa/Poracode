import type { GitRefreshMode, GitRefreshOptions } from "./gitRefresh";

/** Bound background fan-out without putting user reads on a shared queue. */
export async function forEachGitTarget<T>(
  targets: readonly T[],
  visit: (target: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, targets.length) }, async () => {
      while (next < targets.length) await visit(targets[next++]!);
    }),
  );
}

type Request = { mode: GitRefreshMode; options: GitRefreshOptions };
type Pending = { request: Request; result: ReturnType<typeof Promise.withResolvers<void>> };
const manuals = new Map<string, { next: Pending | null }>();
export function cleanupManualGitRefresh(activeIds: ReadonlySet<string>): void {
  for (const [id, entry] of manuals)
    if (!activeIds.has(id)) {
      entry.next?.result.resolve();
      entry.next = null;
      manuals.delete(id);
    }
}

/** A click during a manual read joins one trailing read that starts after that click. */
export function coalesceManualGitRefresh(
  id: string,
  request: Request,
  run: (request: Request) => Promise<void>,
): Promise<void> {
  const current = manuals.get(id);
  if (current) {
    if (!current.next) current.next = { request, result: Promise.withResolvers<void>() };
    else {
      const previous = current.next.request;
      const options = {
        ...previous.options,
        ...request.options,
        fetchRemote: previous.options.fetchRemote || request.options.fetchRemote || false,
        includeProjectStatus:
          previous.options.includeProjectStatus !== false ||
          request.options.includeProjectStatus !== false,
      };
      if (previous.options.worktreePaths && request.options.worktreePaths)
        options.worktreePaths = [
          ...new Set([...previous.options.worktreePaths, ...request.options.worktreePaths]),
        ];
      else delete options.worktreePaths;
      current.next.request = {
        mode: previous.mode === "full" || request.mode === "full" ? "full" : "status",
        options,
      };
    }
    return current.next.result.promise;
  }
  const entry = { next: null as Pending | null };
  manuals.set(id, entry);
  return run(request).finally(() => {
    if (manuals.get(id) === entry) manuals.delete(id);
    const queued = entry.next;
    if (queued)
      void coalesceManualGitRefresh(id, queued.request, run).then(
        queued.result.resolve,
        queued.result.reject,
      );
  });
}
