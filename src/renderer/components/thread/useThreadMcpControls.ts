import { useState } from "react";
import { toast } from "@heroui/react";
import { useLingui } from "@lingui/react/macro";
import {
  mergeMcpServers,
  type AgentStatus,
  type ProjectLocation,
  type Thread,
  type ThreadPresentationMode,
} from "@/shared/contracts";
import { friendlyError } from "@/shared/messages";
import { isRemoteSession } from "@/renderer/bridge";
import {
  canReconnectThreadMcp,
  changeThreadMcp,
  type ThreadMcpChange,
} from "@/renderer/actions/threadMcpActions";
import { useAppStore } from "@/renderer/state/appStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { composerMcpServers, providerOwnsMcpConfig } from "../composer/composerMcpServers";
import { getComputerUseScope } from "../composer/computerUseScope";
import type { ComposerCustomMcpItem } from "../composer/ComposerMcpServersMenu";

/** Controls for persisted threads; a change resumes the existing conversation with new tools. */
export function useThreadMcpControls(
  thread: Thread,
  agent: AgentStatus | undefined,
  location: ProjectLocation,
  presentation: ThreadPresentationMode,
) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const disabled = useSharedSettings((s) => s.disabledBuiltInMcpServers);
  const userServers = useSharedSettings((s) => s.mcpServers);
  const project = useAppStore((s) => s.projects.find((item) => item.id === thread.projectId));
  const launchConfig = useAppStore((s) => s.runtimeLaunchConfigByThreadId[thread.id]);
  const launchNames = useAppStore((s) => s.mcpLaunchCustomServerNamesByThreadId[thread.id]);
  const connecting = useAppStore((s) => s.connectingThreadIds[thread.id] !== undefined);
  const providerOwnsMcp = agent ? providerOwnsMcpConfig(agent.capabilities) : false;
  // Paired desktop settings are not mirrored into a desktop client's shared-settings store.
  const remoteDesktop = thread.remoteServerId !== undefined || isRemoteSession();
  const manageable = !providerOwnsMcp && !remoteDesktop;
  const customManageable = manageable && !isRemoteSession();
  const readOnly =
    !manageable || !canReconnectThreadMcp(thread, agent?.capabilities) || busy || connecting;
  const effectiveMcpConfig = launchConfig ?? thread.config;
  const change = (value: ThreadMcpChange) => {
    if (readOnly || !agent) return;
    setBusy(true);
    void changeThreadMcp(thread.id, value, agent.capabilities)
      .catch((error: unknown) => toast.danger(friendlyError(error)))
      .finally(() => setBusy(false));
  };
  const mcpServers = composerMcpServers.map((descriptor) => ({
    descriptor,
    enabled: effectiveMcpConfig[descriptor.configKey] === true,
    visible:
      descriptor.isAvailable(location) &&
      (manageable
        ? disabled[descriptor.id] !== true &&
          !!agent &&
          descriptor.getScope(agent.capabilities, presentation, location) !== "none"
        : effectiveMcpConfig[descriptor.configKey] === true),
    onToggle: (enabled: boolean) => change({ kind: "builtin", key: descriptor.configKey, enabled }),
  }));
  const projectServers = project?.mcpServers ?? [];
  const customMcpServers: ComposerCustomMcpItem[] = customManageable
    ? mergeMcpServers(userServers, projectServers).map((server) => ({
        id: server.id,
        name: server.name,
        enabled: launchNames?.includes(server.name) === true,
        onToggle: (enabled: boolean) =>
          change({
            kind: "custom",
            id: server.id,
            enabled,
            scope: projectServers.some((item) => item.id === server.id) ? "project" : "user",
          }),
      }))
    : (providerOwnsMcp && remoteDesktop ? [] : (launchNames ?? [])).map((name) => ({
        id: name,
        name,
        enabled: true,
      }));
  // Plugin-provided and since-removed configurations may still be bound to this session.
  // Keep them visible; only their owner can change the definition.
  for (const name of customManageable ? (launchNames ?? []) : []) {
    if (!customMcpServers.some((server) => server.name === name)) {
      customMcpServers.push({ id: `bound:${name}`, name, enabled: true });
    }
  }
  const caption =
    busy || connecting
      ? t`Reconnecting tools…`
      : providerOwnsMcp
        ? t`Manage tools in the provider settings.`
        : remoteDesktop
          ? t`Manage tools on the paired desktop.`
          : agent?.capabilities.supportsResume !== true
            ? t`Tools can only be changed in a new thread for this provider.`
            : readOnly
              ? t`Wait for the current reply to finish before changing tools.`
              : t`Changing tools reconnects this conversation and keeps its history.`;
  return {
    busy,
    readOnly,
    caption,
    effectiveMcpConfig,
    mcpServers,
    customMcpServers,
    customReadOnly: readOnly || !customManageable,
    customCaption: isRemoteSession() ? t`Manage tools on the paired desktop.` : caption,
    computerUse: {
      enabled: effectiveMcpConfig.computerUse === true,
      visible:
        location.kind !== "wsl" &&
        (manageable
          ? disabled["computer-use"] !== true &&
            !!agent &&
            getComputerUseScope(agent.capabilities, presentation, location) !== "none"
          : effectiveMcpConfig.computerUse === true),
      onToggle: (enabled: boolean) => change({ kind: "builtin", key: "computerUse", enabled }),
    },
  };
}
