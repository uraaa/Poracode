import { msg } from "@lingui/core/macro";
import {
  DEFAULT_TERMINAL_SIZE,
  isThreadTurnActive,
  type AgentCapability,
  type BuiltInMcpServerId,
  type Thread,
} from "@/shared/contracts";
import { resolveProjectLocation } from "@/shared/worktree";
import { readBridge } from "@/renderer/bridge";
import { i18n } from "@/renderer/i18n/i18n";
import { useAppStore } from "@/renderer/state/appStore";
import { flushSharedSettings, useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { performInitialThreadLaunch } from "./threadLaunchActions";

export type ThreadMcpChange =
  | {
      kind: "builtin";
      key: "browserMcp" | "chromeMcp" | "crossagentMcp" | "computerUse";
      enabled: boolean;
    }
  | { kind: "custom"; scope: "user" | "project"; id: string; enabled: boolean };

export function canReconnectThreadMcp(
  thread: Thread,
  capabilities?: Pick<AgentCapability, "supportsResume">,
): boolean {
  return (
    capabilities?.supportsResume === true &&
    Boolean(thread.sessionRef) &&
    !isThreadTurnActive(thread.status)
  );
}

const reconnecting = new Set<string>();

/** Reopen the same provider conversation with fresh launch bindings, without sending a turn. */
export async function changeThreadMcp(
  threadId: string,
  change: ThreadMcpChange,
  capabilities: Pick<AgentCapability, "supportsResume">,
): Promise<void> {
  const store = useAppStore.getState();
  const thread = store.threads.find((item) => item.id === threadId);
  const project = store.projects.find((item) => item.id === thread?.projectId);
  if (!thread || !project || reconnecting.has(threadId)) return;
  if (!canReconnectThreadMcp(thread, capabilities)) {
    throw new Error(i18n._(msg`Wait for the current reply to finish before changing tools.`));
  }
  reconnecting.add(threadId);
  const token = store.beginThreadConnecting(threadId);
  let closed = false;
  try {
    // Closing must succeed before either the stored choices or the visible bindings change.
    await readBridge().closeThread({ threadId, onlyIfIdle: true });
    closed = true;
    const latest = useAppStore.getState().threads.find((item) => item.id === threadId);
    if (!latest) return;
    if (change.kind === "builtin") {
      const ids: Record<typeof change.key, BuiltInMcpServerId> = {
        browserMcp: "browser",
        chromeMcp: "chrome",
        crossagentMcp: "crossagents",
        computerUse: "computer-use",
      };
      const disabled = new Set(latest.config.disabledBuiltInMcpServerIds);
      if (change.enabled) disabled.delete(ids[change.key]);
      else disabled.add(ids[change.key]);
      store.updateThreadConfig(threadId, {
        ...latest.config,
        [change.key]: change.enabled,
        disabledBuiltInMcpServerIds: [...disabled],
      });
    } else if (change.scope === "user") {
      const settings = useSharedSettings.getState();
      settings.setMcpServers(
        settings.mcpServers.map((server) =>
          server.id === change.id ? { ...server, enabled: change.enabled } : server,
        ),
      );
      await flushSharedSettings();
    } else {
      const servers =
        useAppStore.getState().projects.find((item) => item.id === project.id)?.mcpServers ?? [];
      store.updateProjectMcpServers(
        project.id,
        servers.map((server) =>
          server.id === change.id ? { ...server, enabled: change.enabled } : server,
        ),
      );
    }
    const updated = useAppStore.getState().threads.find((item) => item.id === threadId);
    if (!updated) return;
    store.updateThreadRuntime(threadId, {
      status: "idle",
      attention: "none",
      canResumeWithConfig: updated.canResumeWithConfig,
      ...(updated.sessionRef ? { sessionRef: updated.sessionRef } : {}),
    });
    await performInitialThreadLaunch({
      thread: updated,
      projectLocation: resolveProjectLocation(project.location, updated.worktreePath),
      prompt: "",
      initialSize: DEFAULT_TERMINAL_SIZE,
    });
  } catch (error) {
    if (closed && useAppStore.getState().threads.some((item) => item.id === threadId)) {
      // Keep the composer usable: its next submit can retry resuming this same session.
      store.updateThreadRuntime(threadId, {
        status: "error",
        attention: "error",
        canResumeWithConfig: true,
      });
    }
    throw error;
  } finally {
    store.finishThreadConnecting(threadId, token);
    reconnecting.delete(threadId);
  }
}
