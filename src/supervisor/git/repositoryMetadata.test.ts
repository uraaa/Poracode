import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectLocation } from "@/shared/contracts";
import { invalidateRepositoryReads } from "../repositoryCommands/scheduling";
import { RepositoryMetadataCache } from "./repositoryMetadata";

describe("repository metadata cache", () => {
  let temporaryRoot: string;
  let configPath: string;
  let main: ProjectLocation;
  let linked: ProjectLocation;
  const location = (path: string): ProjectLocation =>
    process.platform === "win32" ? { kind: "windows", path } : { kind: "posix", path };

  beforeAll(async () => {
    await mkdir(join(process.cwd(), "tmp"), { recursive: true });
    temporaryRoot = await mkdtemp(join(process.cwd(), "tmp", "git-metadata-"));
    const mainPath = join(temporaryRoot, "main");
    const linkedPath = join(temporaryRoot, "linked");
    const gitPath = join(mainPath, ".git");
    const worktreeGitPath = join(gitPath, "worktrees", "linked");
    await mkdir(worktreeGitPath, { recursive: true });
    await mkdir(linkedPath);
    await writeFile(join(linkedPath, ".git"), `gitdir: ${worktreeGitPath}\n`);
    await writeFile(join(worktreeGitPath, "commondir"), "../..\n");
    configPath = join(gitPath, "config");
    await writeFile(configPath, "[core]\n");
    main = location(mainPath);
    linked = location(linkedPath);
  });

  afterAll(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("shares overlapping reads across worktrees of one common repository", async () => {
    const cache = new RepositoryMetadataCache();
    let reads = 0;
    const read = async () => `value-${++reads}`;
    expect(
      await Promise.all([cache.read(main, "remote", read), cache.read(linked, "remote", read)]),
    ).toEqual(["value-1", "value-1"]);
    expect(await cache.read(linked, "remote", read)).toBe("value-1");
  });

  it("invalidates a shared read when common config changes externally", async () => {
    const cache = new RepositoryMetadataCache();
    expect(await cache.read(main, "remote", async () => "before")).toBe("before");
    await writeFile(configPath, "[core]\n\tbare = false\n");
    expect(await cache.read(linked, "remote", async () => "after")).toBe("after");
  });

  it("isolates a worktree with its own config from the common remote cache", async () => {
    const cache = new RepositoryMetadataCache();
    expect(await cache.read(main, "remote", async () => "common")).toBe("common");
    const worktreeConfig = join(
      temporaryRoot,
      "main",
      ".git",
      "worktrees",
      "linked",
      "config.worktree",
    );
    await writeFile(worktreeConfig, '[remote "origin"]\n\turl = https://example.invalid/other\n');
    try {
      expect(await cache.read(linked, "remote", async () => "worktree")).toBe("worktree");
      expect(await cache.read(main, "remote", async () => "unexpected")).toBe("common");
    } finally {
      await rm(worktreeConfig);
    }
  });

  it("expires arbitrary included-config dependencies within thirty seconds", async () => {
    const cache = new RepositoryMetadataCache();
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(10_000);
      expect(await cache.read(main, "remote", async () => "before")).toBe("before");
      now.mockReturnValue(40_001);
      expect(await cache.read(main, "remote", async () => "after")).toBe("after");
    } finally {
      now.mockRestore();
    }
  });

  it("does not let an older in-flight read replace a post-mutation value", async () => {
    const cache = new RepositoryMetadataCache();
    const pending = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const before = cache.read(main, "remote", () => {
      started.resolve();
      return pending.promise;
    });
    await started.promise;
    invalidateRepositoryReads();
    expect(await cache.read(linked, "remote", async () => "after")).toBe("after");
    pending.resolve("before");
    expect(await before).toBe("before");
    expect(await cache.read(main, "remote", async () => "unexpected")).toBe("after");
  });

  it("retries failed metadata reads rather than caching transient failures", async () => {
    const cache = new RepositoryMetadataCache();
    await expect(
      cache.read(main, "remote", async () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow("transient");
    expect(await cache.read(main, "remote", async () => "recovered")).toBe("recovered");
  });
});
