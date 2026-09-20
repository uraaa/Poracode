import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, toast } from "@heroui/react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ImportableSession } from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";
import { Input, PixelLoader } from "@/renderer/components/common";
import { useAppStore } from "@/renderer/state/appStore";
import {
  ALL,
  applyImportFilters,
  EMPTY_FILTERS,
  importFacetOptions,
  selectImportFilter,
  type ImportFilters,
} from "./importFilters";
import { importSessions } from "./importSessionsActions";
import { SearchableSelect } from "./SearchableSelect";

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
  const [sessions, setSessions] = useState<ImportableSession[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState(props.initialProjectId ?? projects[0]?.id ?? "");
  const [filters, setFilters] = useState<ImportFilters>(() => ({
    ...EMPTY_FILTERS,
    ...(props.initialFolder ? { folder: props.initialFolder } : {}),
  }));

  const load = useCallback(() => readBridge().listImportableSessions({}), []);

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

  // Each dropdown offers only values compatible with the other selections;
  // picking one facet drops any other selection it just made impossible.
  const facets = useMemo(() => importFacetOptions(sessions, filters), [filters, sessions]);
  const visible = useMemo(() => applyImportFilters(sessions, filters), [filters, sessions]);
  const select = (patch: Partial<ImportFilters>) =>
    setFilters((current) => selectImportFilter(sessions, current, patch));

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
          label={t`Folder`}
          mono
          className="max-w-80"
          value={filters.folder}
          options={[
            { value: ALL, label: t`All folders` },
            ...facets.folders.map((folder) => ({
              value: folder,
              label: folder.split(/[\\/]/u).filter(Boolean).at(-1) ?? folder,
              hint: folder,
            })),
          ]}
          searchPlaceholder={t`Search folders…`}
          onChange={(value) => select({ folder: value })}
        />
        <Input
          aria-label={t`Search sessions`}
          placeholder={t`Search by text or folder`}
          className="min-w-40 flex-1 text-xs"
          value={filters.query}
          onChange={(event) => select({ query: event.target.value })}
        />
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
