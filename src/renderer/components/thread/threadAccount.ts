import {
  extractClaudeProfileInstanceId,
  extractCodexProfileInstanceId,
  extractCursorProfileInstanceId,
  type AgentInstanceConfigMap,
  type AgentProviderMetadata,
} from "@/shared/contracts";

/**
 * Which account a thread runs on — the header needs it because a provider icon
 * looks identical for every profile of the same provider, so two threads on two
 * logins are otherwise indistinguishable once the composer placeholder is gone.
 */

/** Instance id behind a profile kind ("claude:work" → "work"), if any. */
function profileInstanceId(agentKind: string): string | undefined {
  return (
    extractClaudeProfileInstanceId(agentKind) ??
    extractCodexProfileInstanceId(agentKind) ??
    extractCursorProfileInstanceId(agentKind)
  );
}

/**
 * Name of the account the thread runs on. A profile thread is named by the
 * profile the user typed ("Work"), falling back to the raw instance id when the
 * profile carries no display name. A thread on the provider's default login has
 * no profile to name, so it falls back to the provider label — the line stays
 * present rather than appearing only for some threads.
 */
export function threadAccountName(
  agentKind: string,
  agentInstances: AgentInstanceConfigMap | undefined,
  agentLabel: string | undefined,
): string | undefined {
  const instanceId = profileInstanceId(agentKind);
  if (instanceId) {
    const displayName = agentInstances?.[instanceId]?.displayName?.trim();
    return displayName || instanceId;
  }
  return agentLabel?.trim() || undefined;
}

/**
 * The identity behind that name, for the tooltip: the signed-in email, the
 * plan, and the organization, in the order a user scans them. Empty when the
 * provider reports no account metadata (many report none).
 */
export function threadAccountDetails(
  metadata: AgentProviderMetadata | undefined,
): { authenticatedAs?: string; plan?: string; organization?: string } | undefined {
  const authenticatedAs = metadata?.authenticatedAs?.trim();
  const plan = metadata?.plan?.trim();
  const organization = metadata?.organization?.trim();
  if (!authenticatedAs && !plan && !organization) return undefined;
  return {
    ...(authenticatedAs ? { authenticatedAs } : {}),
    ...(plan ? { plan } : {}),
    ...(organization ? { organization } : {}),
  };
}
