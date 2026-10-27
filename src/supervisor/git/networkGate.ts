import { readFile } from "node:fs/promises";
import { join, resolve, posix } from "node:path";
import type { ProjectLocation } from "@/shared/contracts";
import { getProjectFsPath, toWslUncPath } from "@/shared/wsl";

/** Linked worktrees share refs and fetch locks in the common git directory. */
export async function repositoryNetworkKey(location: ProjectLocation): Promise<string> {
  const root = getProjectFsPath(location);
  let gitDir = join(root, ".git");
  try {
    const pointer = await readFile(gitDir, "utf8");
    if (pointer.startsWith("gitdir:")) {
      const target = pointer.slice(7).trim();
      // WSL pointers contain Linux absolute paths, not UNC paths.
      if (location.kind === "wsl") {
        const linux = posix.resolve(location.linuxPath, target);
        gitDir = toWslUncPath(location.distro, linux);
      } else gitDir = resolve(root, target);
    }
  } catch {
    /* A normal .git directory, or a missing project. */
  }
  const common = await readFile(join(gitDir, "commondir"), "utf8").catch(() => "");
  const key = common ? resolve(gitDir, common.trim()) : gitDir;
  return location.kind === "windows" ? key.toLowerCase() : key;
}
