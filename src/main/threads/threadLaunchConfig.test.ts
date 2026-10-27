import { describe, expect, it, vi } from "vitest";
import { agentStatusesResponseSchema, type ProjectLocation } from "@/shared/contracts";
import { defaultSharedSettings } from "@/shared/settings";
import { resolveAutomatedThreadConfig } from "./threadLaunchConfig";

const location: ProjectLocation = { kind: "windows", path: "C:/repo" };
const settings = {
  ...defaultSharedSettings,
  enabledMcpServers: { browser: true, chrome: true, crossagents: true, "computer-use": true },
};
const flags = { browserMcp: true, chromeMcp: true, crossagentMcp: true, computerUse: true };

function statuses(capabilities: Record<string, unknown> = {}) {
  const agent = {
    kind: "test-agent",
    label: "Test",
    installed: true,
    authState: "authenticated",
    capabilities,
  };
  return vi
    .fn<Parameters<typeof resolveAutomatedThreadConfig>[0]>()
    .mockResolvedValue(
      agentStatusesResponseSchema.parse({ windows: [agent], wsl: [agent], fromCache: true }),
    );
}

describe("resolveAutomatedThreadConfig", () => {
  it("adds standing defaults and advertised unattended permissions in one lookup", async () => {
    const getStatuses = statuses({ approvalPolicies: [{ id: "never", label: "Full Access" }] });
    expect(
      await resolveAutomatedThreadConfig(getStatuses, "test-agent", location, settings),
    ).toEqual({ ...flags, approvalPolicy: "never" });
    expect(getStatuses).toHaveBeenCalledTimes(1);
  });

  it("lets global disables override standing defaults and inherited true flags", async () => {
    expect(
      await resolveAutomatedThreadConfig(
        statuses(),
        "test-agent",
        location,
        {
          ...settings,
          disabledBuiltInMcpServers: {
            browser: true,
            chrome: true,
            crossagents: true,
            "computer-use": true,
          },
        },
        flags,
      ),
    ).toEqual({});
  });

  it("excludes host-only servers for WSL while keeping browser and crossagents", async () => {
    expect(
      await resolveAutomatedThreadConfig(
        statuses(),
        "test-agent",
        {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/repo",
          uncPath: "//wsl.localhost/Ubuntu/repo",
        },
        settings,
        flags,
      ),
    ).toEqual({ browserMcp: true, crossagentMcp: true });
  });

  it("leaves provider-owned MCP configuration to the provider settings", async () => {
    expect(
      await resolveAutomatedThreadConfig(
        statuses({ mcpConfigSource: "agentSettings" }),
        "test-agent",
        location,
        settings,
        flags,
      ),
    ).toEqual({});
  });

  it("does not enable standing defaults for a provider that hides GUI MCPs", async () => {
    expect(
      await resolveAutomatedThreadConfig(
        statuses({ mcpScope: { gui: "none", terminal: "none" } }),
        "test-agent",
        location,
        settings,
      ),
    ).toEqual({});
  });

  it("carries source opt-ins even with no composer toggles, matching provider handoff", async () => {
    expect(
      await resolveAutomatedThreadConfig(
        statuses({ mcpScope: { gui: "none", terminal: "none" } }),
        "test-agent",
        location,
        { ...settings, enabledMcpServers: {} },
        flags,
      ),
    ).toEqual(flags);
  });

  it("does not carry false source flags over newly enabled defaults", async () => {
    expect(
      await resolveAutomatedThreadConfig(statuses(), "test-agent", location, settings, {
        browserMcp: false,
      }),
    ).toEqual(flags);
  });

  it("keeps MCP defaults when agent discovery fails", async () => {
    expect(
      await resolveAutomatedThreadConfig(
        vi
          .fn<Parameters<typeof resolveAutomatedThreadConfig>[0]>()
          .mockRejectedValue(new Error("unavailable")),
        "test-agent",
        location,
        settings,
      ),
    ).toEqual(flags);
  });
});
