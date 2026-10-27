import { describe, expect, it } from "vitest";
import { createSupervisorIpcHandlers } from "./ipcHandlers";
import { getRepositoryCommandPriority } from "./repositoryCommands/scheduling";
import type { SupervisorRuntime } from "./supervisorRuntime";

const projectLocation = { kind: "windows", path: "C:/repo" } as const;

describe("repository polling IPC scheduling", () => {
  it("shares overlapping project snapshots, then reads a fresh snapshot on the next request", async () => {
    const gate = Promise.withResolvers<void>();
    let reads = 0;
    const runtime = {
      gitProjectSnapshot: async () => {
        reads += 1;
        await gate.promise;
        return { read: reads, priority: getRepositoryCommandPriority() };
      },
    } as unknown as SupervisorRuntime;
    const handlers = createSupervisorIpcHandlers(runtime);
    const payload = { projectLocation, includeGhCheck: false };
    const first = handlers.gitProjectSnapshot(payload);
    const second = handlers.gitProjectSnapshot({ ...payload });
    gate.resolve();
    expect(await first).toEqual({ read: 1, priority: "background" });
    expect(await second).toEqual({ read: 1, priority: "background" });
    expect(await handlers.gitProjectSnapshot(payload)).toEqual({ read: 2, priority: "background" });
  });

  it("classifies repository reads as background while mutations and thread work stay interactive", async () => {
    const priority = async () => {
      await Promise.resolve();
      return getRepositoryCommandPriority();
    };
    const runtime = {
      gitService: {
        getStatus: priority,
        getWorktreeStatusBatch: priority,
        getWorktreeSourceBranch: priority,
        getExperimentCandidateStats: priority,
        stageAll: priority,
        getDiff: priority,
        getFileContent: priority,
      },
      githubService: {
        listPrs: priority,
        getPrForBranch: priority,
        getPrChecks: priority,
        getPrDetails: priority,
        closePr: priority,
        getPrDiff: priority,
      },
      threadSessionManager: { getThreadSnapshots: priority },
      gitCheckpointService: { list: priority },
    } as unknown as SupervisorRuntime;
    const handlers = createSupervisorIpcHandlers(runtime);
    const branch = { projectLocation, branch: "feature" };
    expect(await handlers.getGitStatus({ projectLocation })).toBe("background");
    expect(await handlers.listFileCheckpoints({ projectLocation, threadId: "thread" })).toBe(
      "background",
    );
    expect(await handlers.gitWorktreeStatusBatch({ projectLocation, worktreePaths: [] })).toEqual({
      statuses: "background",
    });
    expect(await handlers.gitGetWorktreeSourceBranch(branch)).toBe("background");
    expect(await handlers.getExperimentCandidateStats({ projectLocation, baseRef: "master" })).toBe(
      "background",
    );
    expect(await handlers.ghListPrs({ projectLocation })).toEqual({ prs: "background" });
    expect(await handlers.ghGetPrForBranch(branch)).toBe("background");
    expect(await handlers.ghGetPrChecks(branch)).toBe("background");
    expect(await handlers.ghGetPrDetails({ projectLocation, prNumber: 1 })).toBe("background");
    expect(await handlers.gitStageAll({ projectLocation })).toBe("interactive");
    expect(await handlers.ghClosePr({ projectLocation, prNumber: 1 })).toBe("interactive");
    expect(await handlers.getThreadSnapshots({})).toBe("interactive");
  });

  it("keeps user-requested file and PR diffs ahead of background polling", async () => {
    const priority = async () => getRepositoryCommandPriority();
    const runtime = {
      gitService: { getDiff: priority, getFileContent: priority },
      githubService: { getPrDiff: priority },
    } as unknown as SupervisorRuntime;
    const handlers = createSupervisorIpcHandlers(runtime);
    expect(await handlers.getGitDiff({ projectLocation, filePath: "file.ts", staged: false })).toBe(
      "interactive",
    );
    expect(
      await handlers.getGitFileContent({ projectLocation, filePath: "file.ts", staged: false }),
    ).toBe("interactive");
    expect(await handlers.ghGetPrDiff({ projectLocation, prNumber: 1 })).toBe("interactive");
  });

  it("bounds automatic fetches without delaying explicit fetches", async () => {
    const runtime = {
      gitService: { fetch: async () => getRepositoryCommandPriority() },
    } as unknown as SupervisorRuntime;
    const handlers = createSupervisorIpcHandlers(runtime);
    const fetch = { projectLocation, remote: "origin", prune: true };
    expect(await handlers.gitFetch({ ...fetch, background: true })).toBe("background");
    expect(await handlers.gitFetch(fetch)).toBe("interactive");
  });
});
