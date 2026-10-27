import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProjectLocation } from "@/shared/contracts";
import { execGit, getLocationIdentity, GIT_STATUS_TIMEOUT } from "./exec";

/** Process-local only. Config metadata invalidates ordinary remote edits immediately;
 * TTL also covers includeIf/global configuration and replacement of a repository. */
export class GitRemoteCache {
  private readonly entries = new Map<string, { signature: string; output: string; at: number }>();

  async read(location: Exclude<ProjectLocation, { kind: "wsl" }>): Promise<string> {
    let gitDir = join(location.path, ".git");
    let signature = "";
    try {
      if ((await stat(gitDir)).isFile()) {
        const pointer = await readFile(gitDir, "utf8");
        gitDir = resolve(location.path, pointer.trim().replace(/^gitdir:\s*/, ""));
      }
      const common = await readFile(join(gitDir, "commondir"), "utf8").catch(() => "");
      const config = await stat(join(common ? resolve(gitDir, common.trim()) : gitDir, "config"));
      const worktreeConfig = await stat(join(gitDir, "config.worktree")).catch(() => null);
      signature = `${gitDir}:${config.mtimeMs}:${config.size}:${worktreeConfig?.mtimeMs}:${worktreeConfig?.size}`;
    } catch {
      // Unknown layout: TTL still bounds reuse, and status checks repo validity each time.
    }
    const key = getLocationIdentity(location);
    const cached = this.entries.get(key);
    if (cached && cached.signature === signature && Date.now() - cached.at < 60_000) {
      return cached.output;
    }
    const output = await execGit(location, ["remote", "-v"], { timeout: GIT_STATUS_TIMEOUT });
    this.entries.set(key, { signature, output, at: Date.now() });
    return output;
  }
}
