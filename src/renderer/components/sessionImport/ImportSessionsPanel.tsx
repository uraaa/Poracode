import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, toast } from "@heroui/react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ImportSessionFacets, ImportableSession } from "@/shared/contracts";
import { importedSessionProviderForAgentKind } from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";
import { Input, PixelLoader } from "@/renderer/components/common";
import { useAgentStatusesStore } from "@/renderer/state/agentStatusesStore";
import { useAppStore } from "@/renderer/state/appStore";
import {
  ALL,
  applyImportFilters,
  EMPTY_FILTERS,
  reconcileFilters,
  type ImportFilters,
} from "./importFilters";
import { importSessions } from "./importSessionsActions";
import { SearchableSelect } from "./SearchableSelect";

/** Target-account value meaning "the account each session was found under". */
const SOURCE_ACCOUNT = "";

/**
 * Lists Codex and Claude Code conversations found on disk and turns the chosen
 * ones into threads. The same full panel backs the Settings → Import page and
 * a project's import dialog; the dialog merely arrives with that project's
 * folder preselected in the folder filter and the project as the fallback
 * target, and every filter stays available.
 */
export function ImportSessionsPanel(props: { initialFolder?: string; initialProjectId?: string }) {
  const { t } = useLingui();
  const projects = useAppStore((state) => state.projects);
  const agentStatuses = useAgentStatusesStore((state) => state.agentStatuses);
  const [sessions, setSessions] = useState<ImportableSession[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState(props.initialProjectId ?? projects[0]?.id ?? "");
  const [targetAgentKind, setTargetAgentKind] = useState(SOURCE_ACCOUNT);
  // Every installed account that can own a Codex or Claude session. The
  // target only applies to sessions of its own provider (see
  // `resolveImportAgentKind`), which the label makes visible.
  const accounts = useMemo(
    () =>
      agentStatuses.flatMap((status) => {
        const provider = importedSessionProviderForAgentKind(status.kind);
        if (!provider || !status.installed) return [];
        return [
          {
            value: status.kind,
            label: status.label,
            hint: provider === "codex" ? "Codex" : "Claude Code",
          },
        ];
      }),
    [agentStatuses],
  );
  const [filters, setFilters] = useState<ImportFilters>(() => ({
    ...EMPTY_FILTERS,
    ...(props.initialFolder ? { folder: props.initialFolder } : {}),
  }));
  const [facets, setFacets] = useState<ImportSessionFacets>({
    providers: [],
    accounts: [],
    folders: [],
  });
  // Whether the last scan had to cut more sessions than the page limit could
  // hold. The notice tells the user the list isn't the whole story instead of
  // letting it quietly look complete.
  const [truncated, setTruncated] = useState(false);

  // The query text the scan searches with, debounced so typing doesn't
  // trigger a rescan (and the file reads that pay for it) on every keystroke.
  // 400ms rather than 200ms: 200 is shorter than a normal mid-word typing
  // pause, so a several-character query could still fire a handful of scans.
  // The panel's own `applyImportFilters` below still matches `filters.query`
  // immediately against the returned page, so the visible list reacts at
  // once even while the debounced scan is still catching up.
  const [debouncedQuery, setDebouncedQuery] = useState(filters.query);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(filters.query), 400);
    return () => clearTimeout(handle);
  }, [filters.query]);

  // The scan applies these itself. Filtering client-side instead would only
  // ever see the newest page of sessions, so a folder whose conversations are
  // older than that page would look empty however far back its history goes.
  const load = useCallback(
    () =>
      readBridge().listImportableSessions({
        ...(filters.provider === ALL ? {} : { provider: filters.provider }),
        ...(filters.account === ALL ? {} : { agentKind: filters.account }),
        ...(filters.folder === ALL ? {} : { cwd: filters.folder }),
        ...(debouncedQuery ? { query: debouncedQuery } : {}),
      }),
    [filters.account, filters.folder, filters.provider, debouncedQuery],
  );

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((found) => {
        if (cancelled) return;
        setSessions(found.sessions);
        setFacets(found.facets);
        setTruncated(found.truncated);
        setFilters((current) => reconcileFilters(current, found.facets));
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

  // The scan has already applied the dropdowns; this is the search text, plus
  // a harmless re-check while a scan for new filters is still in flight.
  const visible = useMemo(() => applyImportFilters(sessions, filters), [filters, sessions]);
  const select = (patch: Partial<ImportFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));

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
      const { imported, failed, threadIds } = await importSessions({
        sessions: chosen,
        ...(projectId ? { fallbackProjectId: projectId } : {}),
        ...(targetAgentKind !== SOURCE_ACCOUNT ? { targetAgentKind } : {}),
      });
      if (imported > 0) {
        toast.success(i18n._(msg`Imported ${imported} session(s).`));
        setSelected(new Set());
        // Mark locally rather than re-scanning: the renderer persists the new
        // threads to SQLite asynchronously, so a fresh scan can race ahead of
        // them and miss the marks it would otherwise derive from the database.
        setSessions((current) =>
          current.map((session) => {
            const threadId = threadIds.get(session.id);
            return threadId ? { ...session, importedThreadId: threadId } : session;
          }),
        );
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

  // "Nothing on this computer" is only true when nothing was asked for. Once
  // a filter or a query is active an empty scan means "nothing matched", and
  // replacing the panel would take the filter bar — and the input still
  // holding the typed query — away with it, leaving no way back short of
  // reopening the dialog. The list body already says "no matches" on its own.
  const narrowed =
    filters.provider !== ALL ||
    filters.account !== ALL ||
    filters.folder !== ALL ||
    filters.query.trim().length > 0;

  if (sessions.length === 0 && !narrowed) {
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
        <SearchableSelect
          label={t`Provider`}
          value={filters.provider}
          options={[
            { value: ALL, label: t`All providers` },
            ...facets.providers.map((provider) => ({
              value: provider,
              label: provider === "codex" ? "Codex" : "Claude Code",
            })),
          ]}
          onChange={(value) => select({ provider: value as ImportFilters["provider"] })}
        />
        <SearchableSelect
          label={t`Account`}
          value={filters.account}
          options={[
            { value: ALL, label: t`All accounts` },
            ...facets.accounts.map((account) => ({ value: account, label: account })),
          ]}
          onChange={(value) => select({ account: value })}
        />
        <SearchableSelect
          label={t`Project`}
          mono
          className="max-w-80"
          value={filters.folder}
          options={[
            { value: ALL, label: t`All projects` },
            ...facets.folders.map((folder) => ({
              value: folder,
              label: folder.split(/[\\/]/u).filter(Boolean).at(-1) ?? folder,
              hint: folder,
            })),
          ]}
          searchPlaceholder={t`Search projects…`}
          onChange={(value) => select({ folder: value })}
        />
        <Input
          aria-label={t`Search sessions`}
          placeholder={t`Search title or folder everywhere, message text in what's shown`}
          className="min-w-40 flex-1 text-xs"
          value={filters.query}
          onChange={(event) => select({ query: event.target.value })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          <Trans>Import into account</Trans>
        </span>
        <SearchableSelect
          label={t`Target account`}
          value={targetAgentKind}
          options={[{ value: SOURCE_ACCOUNT, label: t`Same account as the session` }, ...accounts]}
          searchPlaceholder={t`Search accounts…`}
          onChange={setTargetAgentKind}
        />
        {targetAgentKind !== SOURCE_ACCOUNT ? (
          <span className="basis-full text-[10px]">
            <Trans>
              The transcript is copied into that account's home so it can resume the session.
              Sessions from the other provider keep their own account.
            </Trans>
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted">
        <span>
          <Trans>If the folder is missing, import into</Trans>
        </span>
        <SearchableSelect
          label={t`Target project`}
          value={projectId}
          options={projects.map((project) => ({
            value: project.id,
            label: project.name,
            ...(project.location.kind === "wsl"
              ? { hint: project.location.linuxPath }
              : { hint: project.location.path }),
          }))}
          searchPlaceholder={t`Search projects…`}
          onChange={setProjectId}
        />
      </div>

      {truncated ? (
        <p className="text-[10px] text-muted">
          <Trans>Showing the 200 most recent — narrow the filters to see more</Trans>
        </p>
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
                aria-label={session.title ?? (session.preview || session.providerSessionId)}
                className="mt-1"
                checked={selected.has(session.id)}
                disabled={alreadyImported || busy}
                onChange={() => toggle(session.id)}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-foreground">
                  {session.title ?? (session.preview || session.providerSessionId)}
                </p>
                {session.title && session.preview ? (
                  <p className="truncate text-[10px] text-muted">{session.preview}</p>
                ) : null}
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
