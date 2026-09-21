import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent, Thread } from "@/shared/contracts";
import { defaultSharedSettings } from "@/shared/settings";
import { importSessionTranscript, listImportableSessions } from "./index";

function codexHomeWith(id: string, cwd: string, prompt: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "poracode-import-home-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const path = join(sessionsDir, `rollout-${id}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { session_id: id, cwd, timestamp: "2026-09-20T04:43:18.000Z" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
      }),
    ].join("\n"),
    "utf8",
  );
  return { dir, path };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    projectId: "p1",
    title: "Imported",
    agentKind: "codex",
    config: { model: "gpt-5.5" },
    status: "idle",
    attention: "none",
    canResumeWithConfig: false,
    archived: false,
    done: false,
    starred: false,
    createdAt: "2026-09-20T06:00:00.000Z",
    updatedAt: "2026-09-20T06:00:00.000Z",
    ...overrides,
  } as Thread;
}

function settingsWithHome(dir: string) {
  return {
    ...defaultSharedSettings,
    agentInstances: {
      work: { id: "work", driver: "codex", displayName: "Work", config: { homeDir: dir } },
    },
  };
}

describe("listImportableSessions", () => {
  it("marks a session that a thread already imported", () => {
    const { dir, path } = codexHomeWith("cx-1", "F:\\repo", "fix the bug");
    const imported = thread({
      id: "already",
      config: {
        model: "gpt-5.5",
        importedFrom: { provider: "codex", path, importedAt: "2026-09-20T06:00:00.000Z" },
      },
    });

    const { sessions } = listImportableSessions(
      {},
      {
        readSharedSettings: () => settingsWithHome(dir),
        getThreads: () => [imported],
        applyRuntimeEvents: vi.fn<(threadId: string, events: readonly RuntimeEvent[]) => void>(),
        flushRuntimeWrites: vi.fn<(threadId: string) => void>(),
      },
    );

    expect(sessions.find((session) => session.providerSessionId === "cx-1")?.importedThreadId).toBe(
      "already",
    );
  });

  it("marks a session that is already a live thread", () => {
    const { dir } = codexHomeWith("cx-live", "F:\\repo", "still running");
    const live = thread({
      id: "live",
      sessionRef: { providerSessionId: "cx-live", discoveredAt: "2026-09-20T06:00:00.000Z" },
    });

    const { sessions } = listImportableSessions(
      {},
      {
        readSharedSettings: () => settingsWithHome(dir),
        getThreads: () => [live],
        applyRuntimeEvents: vi.fn<(threadId: string, events: readonly RuntimeEvent[]) => void>(),
        flushRuntimeWrites: vi.fn<(threadId: string) => void>(),
      },
    );

    expect(
      sessions.find((session) => session.providerSessionId === "cx-live")?.importedThreadId,
    ).toBe("live");
  });

  it("filters by account and still reports the accounts it saw", () => {
    const { dir } = codexHomeWith("cx-1", "F:\\repo", "fix the bug");
    const deps = {
      readSharedSettings: () => settingsWithHome(dir),
      getThreads: () => [],
      applyRuntimeEvents: vi.fn<(threadId: string, events: readonly RuntimeEvent[]) => void>(),
      flushRuntimeWrites: vi.fn<(threadId: string) => void>(),
    };

    const mine = listImportableSessions({ agentKind: "codex:work" }, deps);
    expect(mine.sessions.map((session) => session.providerSessionId)).toEqual(["cx-1"]);

    const other = listImportableSessions({ agentKind: "codex:nobody" }, deps);
    expect(other.sessions).toEqual([]);
    // The account facet ignores the account filter, or picking one account
    // would leave the dropdown holding only that account.
    expect(other.facets.accounts).toContain("codex:work");
  });
});

describe("importSessionTranscript", () => {
  it("replays the transcript into the thread and reports the message count", () => {
    const { path } = codexHomeWith("cx-2", "F:\\repo", "hello");
    const applied: RuntimeEvent[] = [];
    const flushRuntimeWrites = vi.fn<(threadId: string) => void>();

    const result = importSessionTranscript(
      { threadId: "t1", provider: "codex", path },
      {
        readSharedSettings: () => defaultSharedSettings,
        getThreads: () => [thread()],
        applyRuntimeEvents: (_threadId, events) => applied.push(...events),
        flushRuntimeWrites,
      },
    );

    expect(result).toEqual({ messageCount: 2, path });
    expect(applied.filter((event) => event.type === "item.started")).toHaveLength(2);
    expect(flushRuntimeWrites).toHaveBeenCalledExactlyOnceWith("t1");
  });

  it("copies the transcript into the target profile home before replaying", () => {
    const { dir, path } = codexHomeWith("cx-copy", "F:\repo", "hello");
    const profileDir = mkdtempSync(join(tmpdir(), "poracode-import-profile-"));
    const applied: RuntimeEvent[] = [];

    const result = importSessionTranscript(
      { threadId: "t1", provider: "codex", path, targetAgentKind: "codex:work" },
      {
        readSharedSettings: () => ({
          ...defaultSharedSettings,
          agentInstances: {
            src: { id: "src", driver: "codex", displayName: "Source", config: { homeDir: dir } },
            work: {
              id: "work",
              driver: "codex",
              displayName: "Work",
              config: { homeDir: profileDir },
            },
          },
        }),
        getThreads: () => [thread({ agentKind: "codex:work" })],
        applyRuntimeEvents: (_threadId, events) => applied.push(...events),
        flushRuntimeWrites: vi.fn<(threadId: string) => void>(),
      },
    );

    expect(result.path).toBe(join(profileDir, "sessions", "rollout-cx-copy.jsonl"));
    expect(result.messageCount).toBe(2);
    expect(existsSync(result.path)).toBe(true);
    // The base home keeps its file: the copy is the profile's own.
    expect(existsSync(join(dir, "sessions", "rollout-cx-copy.jsonl"))).toBe(true);
  });

  it("throws for an unknown thread and for a missing file", () => {
    const { path } = codexHomeWith("cx-3", "F:\\repo", "hello");
    const deps = {
      readSharedSettings: () => defaultSharedSettings,
      getThreads: () => [] as Thread[],
      applyRuntimeEvents: vi.fn<(threadId: string, events: readonly RuntimeEvent[]) => void>(),
      flushRuntimeWrites: vi.fn<(threadId: string) => void>(),
    };
    expect(() =>
      importSessionTranscript({ threadId: "gone", provider: "codex", path }, deps),
    ).toThrow(/thread/iu);
    expect(() =>
      importSessionTranscript(
        { threadId: "t1", provider: "codex", path: join(tmpdir(), "not-there.jsonl") },
        { ...deps, getThreads: () => [thread()] },
      ),
    ).toThrow(Error);
  });
});
