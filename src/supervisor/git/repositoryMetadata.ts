import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProjectLocation } from "@/shared/contracts";
import { getRepositoryReadEpoch } from "../repositoryCommands/scheduling";
import { getLocationIdentity } from "./exec";

interface MetadataEntry {
  epoch: number;
  signature: string;
  expiresAt: number;
  result: Promise<string>;
}

// Includes and system config can live anywhere. A finite TTL bounds changes to
// those dependencies while common local/global config edits invalidate at once.
const METADATA_TTL_MS = 30_000;
const MAX_METADATA_ENTRIES = 1000;

async function fileSignature(path: string): Promise<string> {
  try {
    const value = await stat(path);
    return `${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  } catch {
    return "missing";
  }
}

async function locateGitDirectory(path: string): Promise<string> {
  let directory = resolve(path);
  for (;;) {
    const candidate = join(directory, ".git");
    try {
      const entry = await stat(candidate);
      if (entry.isDirectory()) return candidate;
      const gitFile = await readFile(candidate, "utf8");
      const match = /^gitdir:\s*(.+)\s*$/i.exec(gitFile.trim());
      if (match) return resolve(directory, match[1]!);
    } catch {
      // A caller may pass a directory beneath the worktree root.
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Git directory not found");
    directory = parent;
  }
}

async function metadataIdentity(location: ProjectLocation): Promise<{
  key: string;
  signature: string;
}> {
  if (location.kind === "wsl") return { key: getLocationIdentity(location), signature: "" };
  try {
    const gitDirectory = await locateGitDirectory(location.path);
    const commonDirectory = await readFile(join(gitDirectory, "commondir"), "utf8")
      .then((path) => resolve(gitDirectory, path.trim()))
      .catch(() => gitDirectory);
    const worktreeConfig = await fileSignature(join(gitDirectory, "config.worktree"));
    const configPaths = [
      join(commonDirectory, "config"),
      process.env.GIT_CONFIG_GLOBAL ?? join(homedir(), ".gitconfig"),
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "config"),
    ];
    const signatures = await Promise.all(configPaths.map(fileSignature));
    return {
      key: worktreeConfig === "missing" ? commonDirectory : gitDirectory,
      signature: `${signatures.join("|")}|${worktreeConfig}`,
    };
  } catch {
    // Preserve Git's behavior for unusual layouts and inaccessible metadata.
    return { key: getLocationIdentity(location), signature: "" };
  }
}

/** Cache config-derived reads, sharing the common repository across worktrees. */
export class RepositoryMetadataCache {
  private readonly entries = new Map<string, MetadataEntry>();

  async read(
    location: ProjectLocation,
    name: string,
    read: () => Promise<string>,
  ): Promise<string> {
    // Capture before filesystem awaits: a read begun before a mutation must
    // never be installed as a result of the new repository epoch.
    const epoch = getRepositoryReadEpoch();
    const identity = await metadataIdentity(location);
    const key = `${identity.key}|${name}`;
    const existing = this.entries.get(key);
    if (
      existing?.epoch === epoch &&
      existing.signature === identity.signature &&
      existing.expiresAt > Date.now()
    ) {
      return existing.result;
    }
    const result = Promise.resolve().then(read);
    const entry = {
      epoch,
      signature: identity.signature,
      expiresAt: Date.now() + METADATA_TTL_MS,
      result,
    };
    if (getRepositoryReadEpoch() === epoch) {
      this.entries.set(key, entry);
      if (this.entries.size > MAX_METADATA_ENTRIES) {
        this.entries.delete(this.entries.keys().next().value!);
      }
    }
    try {
      return await result;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }
}
