import { toast } from "@heroui/react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ImportableSession, ProjectLocation } from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";
import { useAppStore } from "@/renderer/state/appStore";
import { getActiveWorkspaceId } from "@/renderer/state/workspaceStore";

/** Title lines stay short enough to read in the sidebar. */
const TITLE_MAX_CHARS = 60;

function titleFor(session: ImportableSession): string {
  const preview = session.preview.trim();
  if (preview.length === 0) return i18n._(msg`Imported session`);
  return preview.length > TITLE_MAX_CHARS ? `${preview.slice(0, TITLE_MAX_CHARS)}…` : preview;
}

function hostLocation(path: string): ProjectLocation {
  return process.platform === "win32" ? { kind: "windows", path } : { kind: "posix", path };
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
}): Promise<{ imported: number; failed: number }> {
  const store = useAppStore.getState();
  let imported = 0;
  let failed = 0;

  for (const session of input.sessions) {
    try {
      const projectId = resolveImportProjectId(session, input.fallbackProjectId);
      if (!projectId) {
        failed += 1;
        toast.danger(i18n._(msg`No project to import into — pick one for ${session.preview}.`));
        continue;
      }
      const thread = store.createThread({
        projectId,
        agentKind: session.agentKind,
        config: {
          // The provider's own default replaces this on the first launch; the
          // schema requires the field, so it is present and blank rather than
          // absent.
          model: "",
          importedFrom: {
            provider: session.provider,
            path: session.path,
            importedAt: new Date().toISOString(),
          },
        },
        prompt: "",
        title: titleFor(session),
        focus: false,
      });
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
      });
      imported += 1;
    } catch (error) {
      failed += 1;
      toast.danger(
        error instanceof Error ? error.message : i18n._(msg`Could not import ${session.preview}.`),
      );
    }
  }
  return { imported, failed };
}
