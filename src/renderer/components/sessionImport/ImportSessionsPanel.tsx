import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, toast } from "@heroui/react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ImportableSession } from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";
import { PixelLoader } from "@/renderer/components/common";
import { useAppStore } from "@/renderer/state/appStore";
import { importSessions } from "./importSessionsActions";

/**
 * Lists Codex and Claude Code conversations found on disk and turns the chosen
 * ones into threads. Rendered both as the project sidebar's import dialog
 * (scoped to that project's directory) and as the Settings → Import page.
 */
export function ImportSessionsPanel(props: { cwd?: string; projectId?: string }) {
  const { t } = useLingui();
  const projects = useAppStore((state) => state.projects);
  const [sessions, setSessions] = useState<ImportableSession[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState(props.projectId ?? projects[0]?.id ?? "");

  const load = useCallback(
    () => readBridge().listImportableSessions(props.cwd ? { cwd: props.cwd } : {}),
    [props.cwd],
  );

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((found) => {
        if (!cancelled) setSessions(found);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.danger(
            error instanceof Error
              ? error.message
              : i18n._(msg`Could not read existing CLI sessions.`),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const importable = useMemo(
    () => sessions.filter((session) => session.importedThreadId === undefined),
    [sessions],
  );

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected((current) =>
      current.size === importable.length
        ? new Set()
        : new Set(importable.map((session) => session.id)),
    );
  }, [importable]);

  // Not memoized: it only ever runs from the confirm button's press handler,
  // so a stable identity buys nothing and the dependency list would just be
  // one more thing to keep honest.
  const runImport = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const chosen = sessions.filter((session) => selected.has(session.id));
      const { imported, failed } = await importSessions({
        sessions: chosen,
        ...(projectId ? { fallbackProjectId: projectId } : {}),
      });
      if (imported > 0) {
        toast.success(i18n._(msg`Imported ${imported} session(s).`));
        setSelected(new Set());
        setSessions(await load());
      }
      if (failed > 0 && imported === 0) {
        toast.danger(i18n._(msg`No sessions could be imported.`));
      }
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <PixelLoader />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted">
        <Trans>No Codex or Claude Code sessions found on this computer.</Trans>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">
          <Trans>
            Import a conversation from Codex CLI or Claude Code. The thread keeps its provider
            session, so your next message continues where you left off.
          </Trans>
        </p>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t`Select all`}
          isDisabled={importable.length === 0}
          onPress={selectAll}
        >
          <Trans>Select all</Trans>
        </Button>
      </div>

      {props.projectId === undefined ? (
        <label className="flex items-center gap-2 text-xs text-muted">
          <Trans>If the folder is missing, import into</Trans>
          <select
            aria-label={t`Target project`}
            className="rounded border border-border/20 bg-transparent px-2 py-1 text-xs"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
        {sessions.map((session) => {
          const alreadyImported = session.importedThreadId !== undefined;
          return (
            <li
              key={session.id}
              className="flex items-start gap-2 rounded border border-border/10 px-2 py-1.5"
            >
              <input
                type="checkbox"
                aria-label={session.preview || session.providerSessionId}
                className="mt-1"
                checked={selected.has(session.id)}
                disabled={alreadyImported || busy}
                onChange={() => toggle(session.id)}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-foreground">
                  {session.preview || session.providerSessionId}
                </p>
                <p className="truncate font-mono text-[10px] text-muted">
                  {session.agentKind} · {session.cwd ?? t`unknown folder`}
                </p>
                {session.cwd && !session.cwdExists ? (
                  <p className="text-[10px] text-warning">
                    <Trans>Folder no longer exists — imports into the project chosen above.</Trans>
                  </p>
                ) : null}
              </div>
              {alreadyImported ? (
                <span className="text-[10px] text-muted">
                  <Trans>Imported</Trans>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="tertiary"
          aria-label={t`Import ${selected.size} sessions`}
          isDisabled={selected.size === 0 || busy}
          onPress={() => void runImport()}
        >
          <Trans>Import {selected.size} session(s)</Trans>
        </Button>
      </div>
    </div>
  );
}
