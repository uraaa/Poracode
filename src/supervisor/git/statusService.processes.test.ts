import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectLocation } from "@/shared/contracts";

const commands = vi.hoisted(() => [] as string[][]);
vi.mock("../repositoryCommands/client", async () => {
  const { executeRepositoryCommand } = await import("../repositoryCommands/execute");
  return {
    runRepositoryCommand: (request: Parameters<typeof executeRepositoryCommand>[0]) => {
      commands.push(request.args);
      return executeRepositoryCommand(request);
    },
  };
});

import { GitStatusService } from "./statusService";

describe("native status process volume with real Git", () => {
  let temporaryRoot: string;
  let repository: string;
  const worktrees: ProjectLocation[] = [];
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const location = (path: string): ProjectLocation =>
    process.platform === "win32" ? { kind: "windows", path } : { kind: "posix", path };

  beforeAll(async () => {
    const scratch = join(process.cwd(), "tmp");
    await mkdir(scratch, { recursive: true });
    temporaryRoot = await mkdtemp(join(scratch, "git-status-processes-"));
    repository = join(temporaryRoot, "repository");
    await mkdir(repository);
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.name", "Status Test"]);
    git(repository, ["config", "user.email", "status@example.invalid"]);
    git(repository, ["config", "core.autocrlf", "false"]);
    git(repository, ["config", "core.hooksPath", join(temporaryRoot, "unused-hooks")]);
    git(repository, ["config", "commit.gpgsign", "false"]);
    git(repository, ["remote", "add", "origin", "https://github.com/example/initial.git"]);
    await writeFile(join(repository, "tracked.txt"), "first\n");
    await writeFile(join(repository, "rename.txt"), "rename me\n");
    await writeFile(join(repository, ".gitignore"), "ignored/\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "initial"]);
    for (let i = 0; i < 40; i += 1) {
      const path = join(temporaryRoot, `worktree-${i}`);
      git(repository, ["worktree", "add", "-b", `status-${i}`, path]);
      worktrees.push(location(path));
    }
  }, 60_000);

  afterAll(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("uses one status process per worktree for both cold and warm summaries", async () => {
    const service = new GitStatusService();
    for (const [phase, expected] of [
      ["cold", 41],
      ["warm", 40],
    ] as const) {
      commands.length = 0;
      const statuses = await Promise.all(worktrees.map((path) => service.getStatusSummary(path)));
      expect(statuses.every((status) => status.isRepo && status.unstaged.length === 0)).toBe(true);
      console.info(`N=40 ${phase} summary Git processes: ${commands.length}`);
      expect(
        statuses.every(
          (status) => status.remoteMetadataIncluded && status.remoteInfo?.repo === "initial",
        ),
      ).toBe(true);
      expect(commands).toHaveLength(expected);
    }
  }, 60_000);

  it("shares remote metadata across forty worktrees and keeps full diff counts", async () => {
    const service = new GitStatusService();
    for (const [phase, expected] of [
      ["cold", 121],
      ["warm", 120],
    ] as const) {
      commands.length = 0;
      const statuses = await Promise.all(worktrees.map((path) => service.getStatus(path)));
      expect(
        statuses.every((status) => status.isRepo && status.remoteInfo?.repo === "initial"),
      ).toBe(true);
      console.info(`N=40 ${phase} full Git processes: ${commands.length}`);
      expect(commands).toHaveLength(expected);
    }
  }, 60_000);

  it("preserves nested untracked paths, staged and unstaged files, and renames", async () => {
    await mkdir(join(repository, "nested", "deep"), { recursive: true });
    await writeFile(join(repository, "nested", "deep", "new file.txt"), "one\ntwo\n");
    await writeFile(join(repository, "nested", "日本語.txt"), "three\n");
    await mkdir(join(repository, "ignored"));
    await writeFile(join(repository, "ignored", "secret.txt"), "ignored\n");
    await writeFile(join(repository, "tracked.txt"), "first\nstaged\n");
    git(repository, ["add", "tracked.txt"]);
    await writeFile(join(repository, "tracked.txt"), "first\nstaged\nunstaged\n");
    git(repository, ["mv", "rename.txt", "renamed file.txt"]);
    const service = new GitStatusService();
    commands.length = 0;
    const summary = await service.getStatusSummary(location(repository));
    expect(commands).toHaveLength(2);
    expect(summary.staged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", status: "M" }),
        expect.objectContaining({ path: "renamed file.txt", oldPath: "rename.txt", status: "R" }),
      ]),
    );
    expect(summary.unstaged.map((file) => file.path)).toEqual([
      "tracked.txt",
      "nested/deep/new file.txt",
      "nested/日本語.txt",
    ]);
    const full = await service.getStatus(location(repository));
    expect(full.unstaged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", insertions: 1 }),
        expect.objectContaining({ path: "nested/deep/new file.txt", insertions: 2 }),
        expect.objectContaining({ path: "nested/日本語.txt", insertions: 1 }),
      ]),
    );
    expect(full.staged.find((file) => file.path === "tracked.txt")?.insertions).toBe(1);
    expect(full.totalInsertions).toBe(5);
  });

  it("observes external remote config edits before the metadata TTL expires", async () => {
    const service = new GitStatusService();
    const pollingService = new GitStatusService();
    const target = worktrees[0]!;
    expect((await service.getStatus(target)).remoteInfo?.repo).toBe("initial");
    expect((await pollingService.getStatusSummary(target)).remoteInfo?.repo).toBe("initial");
    git(repository, ["remote", "set-url", "origin", "https://github.com/example/changed.git"]);
    expect((await service.getStatus(target)).remoteInfo?.repo).toBe("changed");
    expect((await pollingService.getStatusSummary(target)).remoteInfo?.repo).toBe("changed");
    const config = await readFile(join(repository, ".git", "config"), "utf8");
    expect(config).toContain("changed.git");
    git(repository, ["remote", "remove", "origin"]);
    expect(await pollingService.getStatusSummary(target)).toMatchObject({
      remoteMetadataIncluded: true,
      hasRemote: false,
      remoteInfo: null,
    });
  });

  it("preserves real merge conflicts in summaries and full status", async () => {
    const target = worktrees[39]!;
    if (target.kind === "wsl") throw new Error("Native fixture expected");
    git(target.path, ["checkout", "-b", "conflict-source"]);
    await writeFile(join(target.path, "tracked.txt"), "source\n");
    git(target.path, ["commit", "-am", "source change"]);
    git(target.path, ["checkout", "status-39"]);
    await writeFile(join(target.path, "tracked.txt"), "target\n");
    git(target.path, ["commit", "-am", "target change"]);
    expect(() => git(target.path, ["merge", "conflict-source"])).toThrow(
      "git merge conflict-source",
    );
    const service = new GitStatusService();
    commands.length = 0;
    const summary = await service.getStatusSummary(target);
    expect(commands).toHaveLength(2);
    expect(summary.mergeInProgress).toBe(true);
    expect(summary.conflictFiles).toEqual([
      { path: "tracked.txt", status: "U", staged: false, insertions: 0, deletions: 0 },
    ]);
    const full = await service.getStatus(target);
    expect(full.mergeInProgress).toBe(true);
    expect(full.conflictFiles?.[0]?.path).toBe("tracked.txt");
    expect(full.mergeMessage).toContain("conflict-source");
  });

  it("treats a failing status outside a repository as non-repo", async () => {
    const service = new GitStatusService();
    const bareRepository = join(temporaryRoot, "bare-repository");
    await mkdir(bareRepository);
    git(bareRepository, ["init", "--bare"]);
    commands.length = 0;
    expect((await service.getStatusSummary(location(bareRepository))).isRepo).toBe(false);
    expect(commands).toHaveLength(1);
    expect((await service.getStatus(location(bareRepository))).isRepo).toBe(false);
  });
});
