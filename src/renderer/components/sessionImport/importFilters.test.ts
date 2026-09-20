import { describe, expect, it } from "vitest";
import type { ImportableSession } from "@/shared/contracts";
import {
  ALL,
  applyImportFilters,
  EMPTY_FILTERS,
  importFacetOptions,
  selectImportFilter,
} from "./importFilters";

function session(overrides: Partial<ImportableSession>): ImportableSession {
  return {
    id: "x",
    provider: "codex",
    agentKind: "codex",
    providerSessionId: "x",
    path: "/x.jsonl",
    preview: "",
    cwdExists: true,
    ...overrides,
  };
}

const SESSIONS: ImportableSession[] = [
  session({ id: "1", provider: "codex", agentKind: "codex", cwd: "F:\\a", preview: "alpha" }),
  session({ id: "2", provider: "codex", agentKind: "codex:work", cwd: "F:\\b", preview: "beta" }),
  session({ id: "3", provider: "claude", agentKind: "claude", cwd: "F:\\a", preview: "gamma" }),
];

describe("importFacetOptions", () => {
  it("offers every value when nothing is selected", () => {
    expect(importFacetOptions(SESSIONS, EMPTY_FILTERS)).toEqual({
      providers: ["claude", "codex"],
      accounts: ["claude", "codex", "codex:work"],
      folders: ["F:\\a", "F:\\b"],
    });
  });

  it("narrows the other facets to what the selected provider still has", () => {
    const options = importFacetOptions(SESSIONS, { ...EMPTY_FILTERS, provider: "claude" });
    expect(options.accounts).toEqual(["claude"]);
    expect(options.folders).toEqual(["F:\\a"]);
    // A facet never narrows itself, or the user could not switch away.
    expect(options.providers).toEqual(["claude", "codex"]);
  });

  it("narrows by folder and search together", () => {
    const options = importFacetOptions(SESSIONS, {
      ...EMPTY_FILTERS,
      folder: "F:\\a",
      query: "gam",
    });
    expect(options.providers).toEqual(["claude"]);
    expect(options.accounts).toEqual(["claude"]);
  });
});

describe("selectImportFilter", () => {
  it("resets a selection the new one made impossible", () => {
    const withWork = selectImportFilter(SESSIONS, EMPTY_FILTERS, { account: "codex:work" });
    expect(withWork.account).toBe("codex:work");

    const thenClaude = selectImportFilter(SESSIONS, withWork, { provider: "claude" });
    expect(thenClaude.provider).toBe("claude");
    expect(thenClaude.account).toBe(ALL);
  });

  it("keeps selections that remain valid", () => {
    const filters = selectImportFilter(
      SESSIONS,
      { ...EMPTY_FILTERS, folder: "F:\\a" },
      { provider: "codex" },
    );
    expect(filters).toMatchObject({ provider: "codex", folder: "F:\\a" });
  });
});

describe("applyImportFilters", () => {
  it("combines every facet with the search", () => {
    expect(
      applyImportFilters(SESSIONS, {
        provider: "codex",
        account: ALL,
        folder: ALL,
        query: "bet",
      }).map((s) => s.id),
    ).toEqual(["2"]);
  });
});
