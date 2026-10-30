import { expect, it, vi } from "vitest";
import type { GitStatusResult } from "@/shared/contracts";
import { readFreshWorktreeStatuses } from "./gitStatusReads";

it("does not publish a pre-mutation batch after a newer worktree read finishes", async () => {
  const old = Promise.withResolvers<{ statuses: Record<string, GitStatusResult> }>();
  const status: GitStatusResult = {
    isRepo: true,
    branch: "new",
    tracking: "",
    hasRemote: false,
    remoteInfo: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    totalInsertions: 7,
    totalDeletions: 0,
  };
  const gitWorktreeStatusBatch = vi
    .fn<() => Promise<{ statuses: Record<string, GitStatusResult> }>>()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue({ statuses: { "/wt": status } });
  Object.defineProperty(window, "poracode", {
    configurable: true,
    value: { gitWorktreeStatusBatch },
  });
  const location = { kind: "posix" as const, path: "/repo" };
  const before = readFreshWorktreeStatuses(location, ["/wt"], "full");
  expect(await readFreshWorktreeStatuses(location, ["/wt"], "full")).toEqual({ "/wt": status });
  old.resolve({ statuses: { "/wt": { ...status, branch: "old" } } });
  expect(await before).toEqual({});
});

it("keeps an older successful read when a newer overlapping read fails", async () => {
  const older = Promise.withResolvers<{ statuses: Record<string, GitStatusResult> }>();
  const status = { isRepo: true, branch: "available" } as GitStatusResult;
  const gitWorktreeStatusBatch = vi
    .fn<() => Promise<{ statuses: Record<string, GitStatusResult> }>>()
    .mockReturnValueOnce(older.promise)
    .mockRejectedValueOnce(new Error("transient read failure"));
  Object.defineProperty(window, "poracode", {
    configurable: true,
    value: { gitWorktreeStatusBatch },
  });
  const location = { kind: "posix" as const, path: "/fallback-repo" };
  const before = readFreshWorktreeStatuses(location, ["/fallback-wt"], "full");
  await expect(readFreshWorktreeStatuses(location, ["/fallback-wt"], "full")).rejects.toThrow(
    "transient",
  );
  older.resolve({ statuses: { "/fallback-wt": status } });
  expect(await before).toEqual({ "/fallback-wt": status });
});
