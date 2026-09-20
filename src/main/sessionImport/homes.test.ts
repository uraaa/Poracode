import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSharedSettings } from "@/shared/settings";
import { resolveImportHomes } from "./homes";

describe("resolveImportHomes", () => {
  it("always includes the base Codex and Claude homes", () => {
    expect(resolveImportHomes(defaultSharedSettings)).toEqual([
      { provider: "codex", agentKind: "codex", dir: join(homedir(), ".codex") },
      { provider: "claude", agentKind: "claude", dir: join(homedir(), ".claude") },
    ]);
  });

  it("adds a home per enabled Codex and Claude profile, expanding ~/", () => {
    const homes = resolveImportHomes({
      ...defaultSharedSettings,
      agentInstances: {
        work: {
          id: "work",
          driver: "codex",
          displayName: "Work",
          config: { homeDir: "~/.poracode/codex-profiles/work" },
        },
        glm: {
          id: "glm",
          driver: "claude",
          displayName: "GLM",
          config: { configDir: "/abs/claude-glm" },
        },
      },
    });
    expect(homes).toContainEqual({
      provider: "codex",
      agentKind: "codex:work",
      dir: join(homedir(), ".poracode/codex-profiles/work"),
    });
    expect(homes).toContainEqual({
      provider: "claude",
      agentKind: "claude:glm",
      dir: "/abs/claude-glm",
    });
  });

  it("skips disabled profiles, other drivers, and malformed configs", () => {
    const homes = resolveImportHomes({
      ...defaultSharedSettings,
      agentInstances: {
        off: {
          id: "off",
          driver: "codex",
          displayName: "Off",
          enabled: false,
          config: { homeDir: "~/.codex-off" },
        },
        broken: { id: "broken", driver: "codex", displayName: "Broken", config: {} },
        cursor: { id: "cursor", driver: "cursor", displayName: "Cursor" },
      },
    });
    expect(homes.map((home) => home.agentKind)).toEqual(["codex", "claude"]);
  });
});
