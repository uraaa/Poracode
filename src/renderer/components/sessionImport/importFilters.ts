import type { ImportableSession, ImportedSessionProvider } from "@/shared/contracts";

/**
 * Faceted filtering over discovered sessions. Each dropdown offers only the
 * values that still have matches under the *other* active filters, so picking
 * "Claude Code" never leaves a Codex-only account or folder in the lists.
 */

export const ALL = "all";

export interface ImportFilters {
  provider: ImportedSessionProvider | typeof ALL;
  account: string;
  folder: string;
  query: string;
}

export const EMPTY_FILTERS: ImportFilters = { provider: ALL, account: ALL, folder: ALL, query: "" };

type Facet = "provider" | "account" | "folder";

function matches(session: ImportableSession, filters: ImportFilters, skip?: Facet): boolean {
  if (skip !== "provider" && filters.provider !== ALL && session.provider !== filters.provider) {
    return false;
  }
  if (skip !== "account" && filters.account !== ALL && session.agentKind !== filters.account) {
    return false;
  }
  if (skip !== "folder" && filters.folder !== ALL && session.cwd !== filters.folder) {
    return false;
  }
  const needle = filters.query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    session.preview.toLowerCase().includes(needle) ||
    (session.title ?? "").toLowerCase().includes(needle) ||
    (session.cwd ?? "").toLowerCase().includes(needle)
  );
}

export function applyImportFilters(
  sessions: readonly ImportableSession[],
  filters: ImportFilters,
): ImportableSession[] {
  return sessions.filter((session) => matches(session, filters));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

/** Values each dropdown should offer, given every *other* filter's selection. */
export function importFacetOptions(
  sessions: readonly ImportableSession[],
  filters: ImportFilters,
): { providers: ImportedSessionProvider[]; accounts: string[]; folders: string[] } {
  const under = (skip: Facet) => sessions.filter((session) => matches(session, filters, skip));
  return {
    providers: sortedUnique(under("provider").map((s) => s.provider)) as ImportedSessionProvider[],
    accounts: sortedUnique(under("account").map((s) => s.agentKind)),
    folders: sortedUnique(
      under("folder")
        .map((s) => s.cwd)
        .filter((cwd): cwd is string => cwd !== undefined),
    ),
  };
}

/**
 * Apply one selection and drop any other selection it just made impossible,
 * so a stale "account" can't silently keep filtering after "provider" moved.
 */
export function selectImportFilter(
  sessions: readonly ImportableSession[],
  filters: ImportFilters,
  patch: Partial<ImportFilters>,
): ImportFilters {
  const next: ImportFilters = { ...filters, ...patch };
  // The facet just chosen is authoritative; only the others are re-validated
  // against it. Resetting to ALL only ever widens, so one pass settles it.
  const options = importFacetOptions(sessions, next);
  const keep = <T extends string>(
    facet: Facet,
    value: T,
    valid: readonly string[],
  ): T | typeof ALL => (facet in patch || value === ALL || valid.includes(value) ? value : ALL);
  return {
    ...next,
    provider: keep("provider", next.provider, options.providers),
    account: keep("account", next.account, options.accounts),
    folder: keep("folder", next.folder, options.folders),
  };
}
