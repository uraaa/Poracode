import { toast } from "@heroui/react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ImportableSession, ProjectLocation } from "@/shared/contracts";
import { importedSessionProviderForAgentKind } from "@/shared/contracts";
import { resolveModelSelection } from "@/shared/agentSelection";
import { isWindows, readBridge } from "@/renderer/bridge";
import { useAgentStatusesStore } from "@/renderer/state/agentStatusesStore";
import { useAppStore } from "@/renderer/state/appStore";
import { getActiveWorkspaceId } from "@/renderer/state/workspaceStore";

/** Title lines stay short enough to read in the sidebar. */
const TITLE_MAX_CHARS = 60;

function titleFor(session: ImportableSession): string {
  const preview = session.preview.trim();
  if (preview.length === 0) return i18n._(msg`Imported session`);
  return preview.length > TITLE_MAX_CHARS ? `${preview.slice(0, TITLE_MAX_CHARS)}…` : preview;
}

/**
 * Last resort when neither the project nor detection knows a model. The
 * composer lets the user change it, but a thread cannot be persisted without
 * one: `persistedThreadSchema` requires a non-empty model, and a single
 * invalid thread in the store would fail the whole `dbSyncAll` batch.
 */
const FALLBACK_MODEL: Record<ImportableSession["provider"], string> = {
  codex: "gpt-5.5",
  claude: "claude-opus-5",
};

/**
 * Model for the imported thread: the project's last draft when it was for
 * this same agent, else the agent's first advertised model, else a fallback.
 */
export function resolveImportModel(
  session: ImportableSession,
  projectId: string,
  agentKind: string = session.agentKind,
): string {
  const project = useAppStore.getState().projects.find((entry) => entry.id === projectId);
  const draft = project?.lastDraftConfig;
  if (draft && draft.agentKind === agentKind && draft.model) return draft.model;
  const status = useAgentStatusesStore
    .getState()
    .agentStatuses.find((entry) => entry.kind === agentKind);
  const detected = status ? resolveModelSelection(status.capabilities) : "";
  return detected || FALLBACK_MODEL[session.provider];
}

/**
 * Agent kind an imported thread runs under. The panel's target account only
 * applies to sessions of its own provider — a Codex profile cannot take a
 * Claude log — so every other session stays with the account it came from.
 */
export function resolveImportAgentKind(
  session: ImportableSession,
  targetAgentKind?: string,
): string {
  if (
    targetAgentKind &&
    importedSessionProviderForAgentKind(targetAgentKind) === session.provider
  ) {
    return targetAgentKind;
  }
  return session.agentKind;
}

function hostLocation(path: string): ProjectLocation {
  // The renderer has no `process`; the bridge reports the host platform.
  return isWindows() ? { kind: "windows", path } : { kind: "posix", path };
}

/**
 * The project an imported thread belongs in. A session records the folder it
 * ran in, so the natural home is the project for that folder: reuse it when
 * Poracode already has it, create it when the folder still exists on disk.
 * `addProjectWithResult` dedupes by project identity, so a repeat import is a
 * lookup, not a second row. A new project joins the workspace the user is
 * currently looking at — an unfiled project would otherwise appear in all of
 * them.
 *
 * A session whose folder is gone (repo deleted or moved) creates nothing and
 * falls back to the project the user picked in the panel.
 */
export function resolveImportProjectId(
  session: ImportableSession,
  fallbackProjectId?: string,
): string | undefined {
  if (session.cwd && session.cwdExists) {
    const { project } = useAppStore
      .getState()
      .addProjectWithResult(
        hostLocation(session.cwd),
        undefined,
        getActiveWorkspaceId() ?? undefined,
      );
    return project.id;
  }
  return fallbackProjectId;
}

/**
 * Create one thread per selected session and replay its transcript. The thread
 * is created through the store's normal path, so persistence and the sidebar
 * behave exactly as they do for a thread the user started — and the app can
 * stay open while this runs.
 */
export async function importSessions(input: {
  sessions: readonly ImportableSession[];
  fallbackProjectId?: string;
  /** Account to import into; sessions of another provider keep their own. */
  targetAgentKind?: string;
}): Promise<{ imported: number; failed: number; threadIds: Map<string, string> }> {
  const store = useAppStore.getState();
  let imported = 0;
  let failed = 0;
  /** Session id → thread id, for every session that made it through. */
  const threadIds = new Map<string, string>();

  for (const session of input.sessions) {
    let threadId: string | undefined;
    try {
      const projectId = resolveImportProjectId(session, input.fallbackProjectId);
      if (!projectId) {
        failed += 1;
        toast.danger(i18n._(msg`No project to import into — pick one for ${session.preview}.`));
        continue;
      }
      const agentKind = resolveImportAgentKind(session, input.targetAgentKind);
      const thread = store.createThread({
        projectId,
        agentKind,
        config: {
          model: resolveImportModel(session, projectId, agentKind),
          importedFrom: {
            provider: session.provider,
            path: session.path,
            importedAt: new Date().toISOString(),
          },
        },
        prompt: "",
        title: titleFor(session),
        // The replayed transcript lives in runtime items, which only the chat
        // pane renders; a terminal thread would open on an empty PTY.
        presentationMode: "gui",
        focus: false,
      });
      threadId = thread.id;
      store.updateThreadRuntime(thread.id, {
        status: "idle",
        attention: "none",
        // The imported config is a placeholder until the first launch picks
        // the provider's defaults, so it cannot be replayed as-is.
        canResumeWithConfig: false,
        sessionRef: {
          providerSessionId: session.providerSessionId,
          discoveredAt: new Date().toISOString(),
        },
      });
      await readBridge().importSessionTranscript({
        threadId: thread.id,
        provider: session.provider,
        path: session.path,
        // Another account's home needs its own copy of the transcript before
        // that account can resume the session.
        ...(agentKind !== session.agentKind ? { targetAgentKind: agentKind } : {}),
      });
      threadIds.set(session.id, thread.id);
      imported += 1;
    } catch (error) {
      // A thread without its transcript is worse than no thread: drop the
      // half-built row so a retry does not leave duplicates behind.
      if (threadId) store.deleteThread(threadId);
      failed += 1;
      toast.danger(
        error instanceof Error ? error.message : i18n._(msg`Could not import ${session.preview}.`),
      );
    }
  }
  return { imported, failed, threadIds };
}
