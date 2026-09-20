import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, toast } from "@heroui/react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ImportableSession, ImportedSessionProvider } from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";
import { Input, PixelLoader } from "@/renderer/components/common";
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
  const [providerFilter, setProviderFilter] = useState<ImportedSessionProvider | "all">("all");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [folderFilter, setFolderFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

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

  // Accounts are the agent kinds discovery attributed sessions to: the base
  // provider plus every profile that had a home with sessions in it.
  const accounts = useMemo(
    () => [...new Set(sessions.map((session) => session.agentKind))].toSorted(),
    [sessions],
  );

  // Folders are whatever the transcripts recorded, so a project's sessions
  // group under its path even before the project exists in Poracode.
  const folders = useMemo(
    () =>
      [
        ...new Set(sessions.map((session) => session.cwd).filter((cwd): cwd is string => !!cwd)),
      ].toSorted((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })),
    [sessions],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter(
      (session) =>
        (providerFilter === "all" || session.provider === providerFilter) &&
        (accountFilter === "all" || session.agentKind === accountFilter) &&
        (folderFilter === "all" || session.cwd === folderFilter) &&
        (needle.length === 0 ||
          session.preview.toLowerCase().includes(needle) ||
          (session.cwd ?? "").toLowerCase().includes(needle)),
    );
  }, [accountFilter, folderFilter, providerFilter, query, sessions]);

  const importable = useMemo(
    () => visible.filter((session) => session.importedThreadId === undefined),
    [visible],
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

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <select
          aria-label={t`Provider`}
          className="rounded border border-border/20 bg-transparent px-2 py-1 text-xs"
          value={providerFilter}
          onChange={(event) => setProviderFilter(event.target.value as typeof providerFilter)}
        >
          <option value="all">{t`All providers`}</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
        </select>
        <select
          aria-label={t`Account`}
          className="rounded border border-border/20 bg-transparent px-2 py-1 text-xs"
          value={accountFilter}
          onChange={(event) => setAccountFilter(event.target.value)}
        >
          <option value="all">{t`All accounts`}</option>
          {accounts.map((account) => (
            <option key={account} value={account}>
              {account}
            </option>
          ))}
        </select>
        {props.cwd === undefined ? (
          <select
            aria-label={t`Folder`}
            className="max-w-72 rounded border border-border/20 bg-transparent px-2 py-1 font-mono text-xs"
            value={folderFilter}
            onChange={(event) => setFolderFilter(event.target.value)}
          >
            <option value="all">{t`All folders`}</option>
            {folders.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </select>
        ) : null}
        <Input
          aria-label={t`Search sessions`}
          placeholder={t`Search by text or folder`}
          className="min-w-40 flex-1 text-xs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
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
        {visible.length === 0 ? (
          <li className="py-4 text-center text-xs text-muted">
            <Trans>No sessions match the current filters.</Trans>
          </li>
        ) : null}
        {visible.map((session) => {
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
