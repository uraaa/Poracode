import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { GitStatusService } from "./statusService";
import { execGit } from "./exec";

it.each(["no", "normal"])(
  "scopes full and summary untracked files to a project subfolder with showUntrackedFiles=%s",
  async (setting) => {
    await mkdir(resolve("tmp"), { recursive: true });
    const root = await mkdtemp(resolve("tmp/status-scope-"));
    const location = {
      kind: process.platform === "win32" ? ("windows" as const) : ("posix" as const),
      path: root,
    };
    try {
      await execGit(location, ["init", "--template="]);
      await execGit(location, ["config", "status.showUntrackedFiles", setting]);
      await mkdir(join(root, "app"));
      await writeFile(join(root, "app", "inside.txt"), "inside\n");
      await writeFile(join(root, "outside.txt"), "outside\n");
      const service = new GitStatusService();
      const subfolder = { ...location, path: join(root, "app") };
      const full = await service.getStatus(subfolder);
      const summary = await service.getStatusSummary(subfolder);
      expect(full.unstaged.map((file) => file.path)).toEqual(["inside.txt"]);
      expect(summary.unstaged.map((file) => file.path)).toEqual(["inside.txt"]);
      expect(full.totalInsertions).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
