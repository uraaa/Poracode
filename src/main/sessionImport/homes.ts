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
    { provider: "claude", agentKind: "claude", dir: join(homedir(), ".claude") },
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
        homes.push({
          provider: "claude",
          agentKind: claudeProfileKind(instance.id),
          dir: resolveNativeTildePath(config.configDir),
        });
      }
    } catch {
      // Malformed profile records are skipped by the agent registry too.
    }
  }
  return homes;
}
