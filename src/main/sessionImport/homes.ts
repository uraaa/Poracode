import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeProfileKind,
  codexProfileKind,
  parseClaudeProfileInstanceConfig,
  parseCodexProfileInstanceConfig,
  type ImportedSessionProvider,
} from "@/shared/contracts";
import type { SharedSettings } from "@/shared/settings";

/**
 * Every provider home whose transcripts can be imported: the base account plus
 * one per enabled profile. Import is a host-only feature, so WSL homes are not
 * enumerated here.
 */
export interface ImportHome {
  provider: ImportedSessionProvider;
  /** Agent kind that owns this home — an imported thread is created under it. */
  agentKind: string;
  dir: string;
  /**
   * Provider account logged into this home, when the provider records one.
   * Claude Code writes every session to the config dir it runs with, so a
   * Claude Desktop conversation held under a work login still lands in the
   * base `~/.claude`; the transcript's owner id is what says whose it is.
   */
  accountId?: string;
}

/**
 * Claude Code keeps its login in `.claude.json`: next to the config dir for
 * the default home (`~/.claude.json`), inside it when `CLAUDE_CONFIG_DIR` is
 * set — which is how Poracode runs every profile.
 */
export function readClaudeAccountId(configDir: string): string | undefined {
  const path =
    configDir === join(homedir(), ".claude")
      ? join(homedir(), ".claude.json")
      : join(configDir, ".claude.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      oauthAccount?: { accountUuid?: unknown };
    };
    const id = parsed.oauthAccount?.accountUuid;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function claudeHome(agentKind: string, dir: string): ImportHome {
  const accountId = readClaudeAccountId(dir);
  return { provider: "claude", agentKind, dir, ...(accountId ? { accountId } : {}) };
}

function resolveNativeTildePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function resolveImportHomes(settings: SharedSettings): ImportHome[] {
  const homes: ImportHome[] = [
    { provider: "codex", agentKind: "codex", dir: join(homedir(), ".codex") },
    claudeHome("claude", join(homedir(), ".claude")),
  ];
  for (const instance of Object.values(settings.agentInstances)) {
    if (instance.enabled === false) continue;
    try {
      if (instance.driver === "codex") {
        const config = parseCodexProfileInstanceConfig(instance.config);
        homes.push({
          provider: "codex",
          agentKind: codexProfileKind(instance.id),
          dir: resolveNativeTildePath(config.homeDir),
        });
      } else if (instance.driver === "claude") {
        const config = parseClaudeProfileInstanceConfig(instance.config);
        homes.push(
          claudeHome(claudeProfileKind(instance.id), resolveNativeTildePath(config.configDir)),
        );
      }
    } catch {
      // Malformed profile records are skipped by the agent registry too.
    }
  }
  return homes;
}
