import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { GitService } from "../git";
import { ProjectWatcher } from "../projectWatcher";
import { execGit } from "./exec";

it("watcher shutdown lets an in-flight commit finish and release index.lock", async () => {
  await mkdir(resolve("tmp"), { recursive: true });
  const root = await mkdtemp(resolve("tmp/git-shutdown-"));
  const location = {
    kind: process.platform === "win32" ? ("windows" as const) : ("posix" as const),
    path: root,
  };
  const release = join(root, "release");
  let commit: ReturnType<GitService["commit"]> | undefined;
  try {
    await execGit(location, ["init", "--template="]);
    await execGit(location, ["config", "user.email", "test@example.invalid"]);
    await execGit(location, ["config", "user.name", "Test"]);
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await execGit(location, ["config", "core.hooksPath", hooks.replaceAll("\\", "/")]);
    await writeFile(join(root, "file.txt"), "content\n");
    await execGit(location, ["add", "file.txt"]);
    const started = join(root, "started");
    const script = join(root, ".git", "wait.cjs");
    await writeFile(
      script,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, ''); setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 20);`,
    );
    const hook = join(hooks, "pre-commit");
    await writeFile(
      hook,
      `#!/bin/sh\n"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"\n`,
    );
    await chmod(hook, 0o755);
    const watcher = new ProjectWatcher({
      onGitChanged: () => undefined,
      onTreeChanged: () => undefined,
    });
    watcher.watch("test", location);
    commit = new GitService().commit(location, "shutdown regression", false);
    await expect
      .poll(
        () =>
          stat(started).then(
            () => true,
            () => false,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
    await watcher.dispose();
    await writeFile(release, "");
    await commit;
    await expect(stat(join(root, ".git", "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await execGit(location, ["log", "-1", "--format=%s"])).toContain("shutdown regression");
  } finally {
    await writeFile(release, "");
    await commit;
    await rm(root, { recursive: true, force: true });
  }
});
