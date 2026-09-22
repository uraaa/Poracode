import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SNIPPET_MARK_END, SNIPPET_MARK_START, type Thread } from "@/shared/contracts";
import { closeDatabase, getSqlite, initDatabase } from "./connection";
import { dbSearchThreadMessages } from "./messageSearchStore";
import { dbUpsertProject, dbUpsertThread } from "./projectsThreads";
import { dbReplaceThreadRuntimeItems } from "./runtimeItems";

const serverNativeBinding = join(process.cwd(), "dist", "server-native", "better_sqlite3.node");
let nativeBindingEnv: string | undefined;
let sqliteAvailable = true;
try {
  new Database(":memory:").close();
} catch {
  if (existsSync(serverNativeBinding)) nativeBindingEnv = serverNativeBinding;
  else sqliteAvailable = false;
}

function thread(id: string, title: string, archived = false): Thread {
  return {
    id,
    projectId: "project-1",
    title,
    agentKind: "codex",
    config: { model: "gpt-5" },
    status: "idle",
    attention: "none",
    canResumeWithConfig: false,
    archived,
    done: false,
    starred: false,
    presentationMode: "gui",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function userItem(id: string, text: string) {
  return {
    id,
    type: "user_message",
    state: "completed" as const,
    payload: { content: [{ kind: "text", text }] },
    streams: {},
  };
}

describe.skipIf(!sqliteAvailable)("dbSearchThreadMessages", () => {
  let dir: string;

  beforeEach(() => {
    if (nativeBindingEnv) process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING = nativeBindingEnv;
    dir = mkdtempSync(join(tmpdir(), "poracode-search-db-test-"));
    initDatabase(join(dir, "state.sqlite"));
    dbUpsertProject(
      {
        id: "project-1",
        name: "Test project",
        location: { kind: "posix", path: "/tmp/project" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      0,
    );
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING;
  });

  it("matches a lowercase Cyrillic query against capitalised text", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "Импорт Сессий работает")]);

    const hits = dbSearchThreadMessages("импорт", 50);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      threadId: "t1",
      threadTitle: "Первый",
      itemId: "i1",
      role: "user",
    });
  });

  it("marks the match inside the snippet", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "Импорт сессий работает")]);

    const [hit] = dbSearchThreadMessages("сессий", 50);
    expect(hit!.snippet).toContain(`${SNIPPET_MARK_START}сессий${SNIPPET_MARK_END}`);
  });

  it("requires the words to be adjacent and in order", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "импорт сессий работает")]);

    expect(dbSearchThreadMessages("импорт сессий", 50)).toHaveLength(1);
    expect(dbSearchThreadMessages("сессий импорт", 50)).toHaveLength(0);
  });

  it("skips archived threads", () => {
    dbUpsertThread(thread("t1", "Архив", true), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "импорт сессий")]);

    expect(dbSearchThreadMessages("импорт", 50)).toHaveLength(0);
  });

  it("returns nothing for a query below the minimum length", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "импорт")]);

    expect(dbSearchThreadMessages("и", 50)).toEqual([]);
    expect(dbSearchThreadMessages("   ", 50)).toEqual([]);
  });

  it("does not throw on input full of FTS5 operators", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", 'он сказал "нет" NEAR(a b)')]);

    expect(() => dbSearchThreadMessages('"нет" NEAR(a', 50)).not.toThrow();
    expect(dbSearchThreadMessages('сказал "нет"', 50)).toHaveLength(1);
  });

  it("returns nothing instead of throwing when the index is missing", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "импорт сессий")]);
    // An interrupted migration, simulated: the index is gone but the app runs.
    getSqlite().exec("DROP TABLE thread_message_fts");

    expect(() => dbSearchThreadMessages("импорт", 50)).not.toThrow();
    expect(dbSearchThreadMessages("импорт", 50)).toEqual([]);
  });

  it("honours the limit", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems(
      "t1",
      Array.from({ length: 5 }, (_, index) => userItem(`i${index}`, "импорт сессий")),
    );

    expect(dbSearchThreadMessages("импорт", 3)).toHaveLength(3);
  });
});
