import type {
  AgentCapability,
  AgentKind,
  AgentStatusesResponse,
  BuiltInMcpServerId,
  ProjectLocation,
  ThreadConfig,
} from "@/shared/contracts";
import { resolveComposerMcpScope } from "@/shared/contracts";
import type { SharedSettings } from "@/shared/settings";
import { getProjectAgentStatuses } from "@/shared/agentStatus";
import { resolveUnrestrictedPermissionConfig } from "@/shared/agents/unrestrictedPermissions";

export type AutomatedThreadMcpConfig = Pick<
  ThreadConfig,
  "browserMcp" | "chromeMcp" | "crossagentMcp" | "computerUse"
>;

/**
 * Resolve MCP defaults and the most-permissive advertised permission policy in a
 * given location. Threads launched from automation (schedules, the app-controls
 * MCP) run their opening turn unattended — nobody is around to answer approval
 * prompts — so they launch with the provider's unrestricted posture (the same
 * capabilities-driven resolution the subagent lane uses; no provider-specific
 * branching). On a lookup failure or unknown agent, fall back to provider
 * defaults rather than failing the launch. MCP defaults follow the GUI composer;
 * source one-off opt-ins follow handoff semantics, including providers whose
 * composer hides toggles. Provider-owned settings and host restrictions still win.
 */
export async function resolveAutomatedThreadConfig(
  getAgentStatuses: (wslDistros: string[]) => Promise<AgentStatusesResponse>,
  agentKind: AgentKind,
  location: ProjectLocation,
  settings: Pick<SharedSettings, "enabledMcpServers" | "disabledBuiltInMcpServers">,
  inherited: AutomatedThreadMcpConfig = {},
): Promise<Partial<ThreadConfig>> {
  let capabilities: AgentCapability | undefined;
  try {
    const statuses = await getAgentStatuses(location.kind === "wsl" ? [location.distro] : []);
    const agents = getProjectAgentStatuses(location, statuses.windows, statuses.wsl);
    capabilities = agents.find((status) => status.kind === agentKind)?.capabilities;
  } catch {
    // Discovery can be unavailable during startup; keep normal GUI defaults.
  }
  const config: Partial<ThreadConfig> = capabilities
    ? resolveUnrestrictedPermissionConfig(capabilities)
    : {};
  if (capabilities?.mcpConfigSource === "agentSettings") return config;

  const supportsDefaults = resolveComposerMcpScope(capabilities?.mcpScope, "gui") !== "none";
  const enabled = (id: BuiltInMcpServerId, key: keyof AutomatedThreadMcpConfig) =>
    settings.disabledBuiltInMcpServers[id] !== true &&
    (inherited[key] === true || (supportsDefaults && settings.enabledMcpServers[id] === true));
  if (enabled("browser", "browserMcp")) config.browserMcp = true;
  if (enabled("crossagents", "crossagentMcp")) config.crossagentMcp = true;
  if (location.kind !== "wsl") {
    if (enabled("chrome", "chromeMcp")) config.chromeMcp = true;
    if (enabled("computer-use", "computerUse")) config.computerUse = true;
  }
  return config;
}
