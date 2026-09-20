# Import existing CLI sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user turn an existing Codex CLI or Claude Code conversation on disk into a Poracode thread that both shows the past messages and resumes the real provider session.

**Architecture:** A scanner in the main process walks the provider home directories Poracode already knows about (base homes plus every profile's `CODEX_HOME` / `CLAUDE_CONFIG_DIR`) and returns session metadata. The renderer creates the thread through its normal store action, then calls a main-local IPC that parses the transcript and replays it as canonical runtime events through `dbApplyThreadRuntimeEvents`, so persistence, ordering, and schema handling are the existing ones.

**Tech Stack:** TypeScript, Electron (main + renderer), zod contracts, better-sqlite3 via the existing `src/main/db` layer, React + lingui in the renderer, vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-import-cli-sessions-design.md`

## Global Constraints

- Providers in scope: `codex` and `claude` only. Other providers are out of scope.
- Replayed transcript is **text only**: `user` and `assistant` messages. No tool calls, reasoning, attachments, or sub-agent rows.
- Source `.jsonl` files are never modified, moved, or deleted.
- Host filesystem only. WSL and remote-machine homes are out of scope; the scanner skips project locations of kind `wsl`.
- A single replayed message is capped at 100 000 characters, truncated with the marker `\n\n[… truncated on import]`.
- Runtime events are applied in batches of 200.
- Every new user-visible string goes through lingui (`t\`\``/`<Trans>`), and `pnpm run i18n:extract`must leave the catalogs with 0 untranslated entries for`ru`, `de`, `es`, `fr`, `ja`, `ko`, `pl`, `pt-BR`, `tr`, `uk`, `vi`, `zh-CN`.
- Run `pnpm exec tsc --noEmit -p tsconfig.json` before every commit; it is also enforced by the pre-commit hook.
- Test command shape: `pnpm exec vitest run <path>`.
- `pnpm` must be on PATH (`$env:Path += ";$(npm prefix -g)"` in PowerShell) — the repo's pre-commit hook shells out to it.

---

### Task 1: Shared contracts for importable sessions

**Files:**

- Create: `src/shared/contracts/sessionImport.ts`
- Modify: `src/shared/contracts.ts` (add the re-export next to the other `export * from "./contracts/…"` lines)
- Modify: `src/shared/contracts/config.ts:4-20` (add `importedFrom` to `threadConfigShape`)
- Test: `src/shared/contracts/sessionImport.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `importedSessionProviderSchema: z.ZodEnum<["codex", "claude"]>`, type `ImportedSessionProvider`
  - `importableSessionSchema`, type `ImportableSession` with fields `id`, `provider`, `agentKind`, `providerSessionId`, `path`, `cwd?`, `startedAt?`, `updatedAt?`, `messageCount`, `preview`, `importedThreadId?`
  - `listImportableSessionsPayloadSchema`, type `ListImportableSessionsPayload` = `{ cwd?: string; provider?: ImportedSessionProvider }`
  - `importSessionTranscriptPayloadSchema`, type `ImportSessionTranscriptPayload` = `{ threadId: string; provider: ImportedSessionProvider; path: string }`
  - `importSessionTranscriptResultSchema`, type `ImportSessionTranscriptResult` = `{ messageCount: number }`
  - `threadImportedFromSchema`, type `ThreadImportedFrom` = `{ provider: ImportedSessionProvider; path: string; importedAt: string }`, reachable as `ThreadConfig["importedFrom"]`

- [ ] **Step 1: Write the failing test**

Create `src/shared/contracts/sessionImport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  importableSessionSchema,
  importSessionTranscriptPayloadSchema,
  listImportableSessionsPayloadSchema,
  threadImportedFromSchema,
} from "./sessionImport";
import { threadConfigSchema } from "./config";

describe("importableSessionSchema", () => {
  it("parses a discovered Codex session", () => {
    const parsed = importableSessionSchema.parse({
      id: "codex:01a0bc7b-6665-7473-bad7-4d7866c20dea",
      provider: "codex",
      agentKind: "codex:work",
      providerSessionId: "01a0bc7b-6665-7473-bad7-4d7866c20dea",
      path: "C:\\Users\\demo\\.codex\\sessions\\2026\\09\\20\\rollout-x.jsonl",
      cwd: "F:\\repo",
      startedAt: "2026-09-20T04:43:18.000Z",
      messageCount: 12,
      preview: "fix the race condition",
    });
    expect(parsed.provider).toBe("codex");
    expect(parsed.importedThreadId).toBeUndefined();
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      importableSessionSchema.parse({
        id: "gemini:1",
        provider: "gemini",
        agentKind: "gemini",
        providerSessionId: "1",
        path: "/tmp/x.jsonl",
        messageCount: 0,
        preview: "",
      }),
    ).toThrow(Error);
  });
});

describe("import payloads", () => {
  it("accepts an empty filter and a provider filter", () => {
    expect(listImportableSessionsPayloadSchema.parse({})).toEqual({});
    expect(listImportableSessionsPayloadSchema.parse({ provider: "claude" }).provider).toBe(
      "claude",
    );
  });

  it("requires a thread, provider, and path to import", () => {
    expect(() => importSessionTranscriptPayloadSchema.parse({ threadId: "t1" })).toThrow(Error);
    expect(
      importSessionTranscriptPayloadSchema.parse({
        threadId: "t1",
        provider: "codex",
        path: "/tmp/x.jsonl",
      }).threadId,
    ).toBe("t1");
  });
});

describe("thread config importedFrom", () => {
  it("round-trips the import marker on a thread config", () => {
    const config = threadConfigSchema.parse({
      model: "gpt-5.5",
      importedFrom: {
        provider: "codex",
        path: "/tmp/x.jsonl",
        importedAt: "2026-09-20T10:00:00.000Z",
      },
    });
    expect(config.importedFrom?.provider).toBe("codex");
    expect(threadImportedFromSchema.parse(config.importedFrom)).toEqual(config.importedFrom);
  });

  it("leaves importedFrom absent for a normal config", () => {
    expect(threadConfigSchema.parse({ model: "gpt-5.5" }).importedFrom).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/shared/contracts/sessionImport.test.ts`
Expected: FAIL — `Failed to resolve import "./sessionImport"`.

- [ ] **Step 3: Write the contracts**

Create `src/shared/contracts/sessionImport.ts`:

```ts
import { z } from "zod";

/**
 * Importing an existing CLI conversation into a Poracode thread. Discovery
 * reads the provider's own transcript files (Codex rollouts, Claude Code
 * project logs) and never writes to them; the import replays their text into a
 * new thread whose `sessionRef` resumes the original provider session.
 */

export const importedSessionProviderSchema = z.enum(["codex", "claude"]);
export type ImportedSessionProvider = z.infer<typeof importedSessionProviderSchema>;

export const threadImportedFromSchema = z.object({
  provider: importedSessionProviderSchema,
  /** Absolute path of the transcript the thread was imported from. */
  path: z.string().min(1),
  importedAt: z.string().min(1),
});
export type ThreadImportedFrom = z.infer<typeof threadImportedFromSchema>;

export const importableSessionSchema = z.object({
  /** `<provider>:<providerSessionId>` — stable across scans, used as a React key. */
  id: z.string().min(1),
  provider: importedSessionProviderSchema,
  /** Agent kind owning the home this was found in (`codex`, `codex:work`, …). */
  agentKind: z.string().min(1),
  providerSessionId: z.string().min(1),
  path: z.string().min(1),
  /** Working directory recorded in the transcript, when it records one. */
  cwd: z.string().optional(),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  messageCount: z.number().int().nonnegative(),
  /** First user message, trimmed — the list's title line. */
  preview: z.string(),
  /** Thread already imported from this session, when one exists. */
  importedThreadId: z.string().optional(),
});
export type ImportableSession = z.infer<typeof importableSessionSchema>;

export const listImportableSessionsPayloadSchema = z.object({
  /** Keep only sessions recorded against this working directory. */
  cwd: z.string().min(1).optional(),
  provider: importedSessionProviderSchema.optional(),
});
export type ListImportableSessionsPayload = z.infer<typeof listImportableSessionsPayloadSchema>;

export const importSessionTranscriptPayloadSchema = z.object({
  /** Thread the renderer already created; the transcript is replayed into it. */
  threadId: z.string().min(1),
  provider: importedSessionProviderSchema,
  path: z.string().min(1),
});
export type ImportSessionTranscriptPayload = z.infer<typeof importSessionTranscriptPayloadSchema>;

export const importSessionTranscriptResultSchema = z.object({
  messageCount: z.number().int().nonnegative(),
});
export type ImportSessionTranscriptResult = z.infer<typeof importSessionTranscriptResultSchema>;
```

- [ ] **Step 4: Wire the re-export and the config field**

In `src/shared/contracts.ts`, add next to the other contract re-exports:

```ts
export * from "./contracts/sessionImport";
```

In `src/shared/contracts/config.ts`, add the import at the top:

```ts
import { threadImportedFromSchema } from "./sessionImport";
```

and add the field to `threadConfigShape` (after `executionEnvironment`):

```ts
  /**
   * Set when the thread was created by importing an existing CLI transcript.
   * Drives the "Imported from …" line in the chat header and makes a repeat
   * import of the same session detectable.
   */
  importedFrom: threadImportedFromSchema.optional(),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run src/shared/contracts/sessionImport.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
git add src/shared/contracts.ts src/shared/contracts/sessionImport.ts src/shared/contracts/sessionImport.test.ts src/shared/contracts/config.ts
git commit -m "feat(contracts): add importable-session contracts"
```

---

### Task 2: Codex transcript parser

**Files:**

- Create: `src/main/sessionImport/codexTranscript.ts`
- Create: `src/main/sessionImport/transcript.ts`
- Test: `src/main/sessionImport/codexTranscript.test.ts`

**Interfaces:**

- Consumes: `ImportedSessionProvider` from Task 1.
- Produces:
  - `transcript.ts`: `MAX_IMPORTED_MESSAGE_CHARS = 100_000`, `TRUNCATION_MARKER = "\n\n[… truncated on import]"`, `capMessageText(text: string): string`, and
    ```ts
    export interface ImportedMessage {
      role: "user" | "assistant";
      text: string;
      at?: string;
    }
    export interface ImportedTranscript {
      providerSessionId?: string;
      cwd?: string;
      startedAt?: string;
      messages: ImportedMessage[];
    }
    ```
  - `codexTranscript.ts`: `parseCodexTranscript(path: string): ImportedTranscript` and `readCodexSessionHead(path: string): { providerSessionId?: string; cwd?: string; startedAt?: string } | undefined`

- [ ] **Step 1: Write the failing test**

Create `src/main/sessionImport/codexTranscript.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodexTranscript, readCodexSessionHead } from "./codexTranscript";
import { MAX_IMPORTED_MESSAGE_CHARS } from "./transcript";

function writeRollout(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "poracode-codex-transcript-"));
  const path = join(dir, "rollout-test.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return path;
}

const META = {
  type: "session_meta",
  payload: {
    session_id: "01a0bc7b-6665-7473-bad7-4d7866c20dea",
    cwd: "F:\\repo",
    timestamp: "2026-09-20T04:43:18.000Z",
  },
};

function message(role: string, text: string, kind = "input_text") {
  return {
    type: "response_item",
    timestamp: "2026-09-20T04:44:00.000Z",
    payload: { type: "message", role, content: [{ type: kind, text }] },
  };
}

describe("readCodexSessionHead", () => {
  it("reads id, cwd, and start time from the first line only", () => {
    const path = writeRollout([META, message("user", "hi")]);
    expect(readCodexSessionHead(path)).toEqual({
      providerSessionId: "01a0bc7b-6665-7473-bad7-4d7866c20dea",
      cwd: "F:\\repo",
      startedAt: "2026-09-20T04:43:18.000Z",
    });
  });

  it("returns undefined when the file does not start with session_meta", () => {
    expect(readCodexSessionHead(writeRollout([message("user", "hi")]))).toBeUndefined();
  });
});

describe("parseCodexTranscript", () => {
  it("keeps user and assistant text in order", () => {
    const path = writeRollout([
      META,
      message("user", "fix the bug"),
      message("assistant", "done", "output_text"),
      message("user", "thanks"),
    ]);
    const transcript = parseCodexTranscript(path);
    expect(transcript.providerSessionId).toBe("01a0bc7b-6665-7473-bad7-4d7866c20dea");
    expect(transcript.cwd).toBe("F:\\repo");
    expect(transcript.messages).toEqual([
      { role: "user", text: "fix the bug", at: "2026-09-20T04:44:00.000Z" },
      { role: "assistant", text: "done", at: "2026-09-20T04:44:00.000Z" },
      { role: "user", text: "thanks", at: "2026-09-20T04:44:00.000Z" },
    ]);
  });

  it("drops developer messages, tool calls, and reasoning", () => {
    const path = writeRollout([
      META,
      message("developer", "You are Codex"),
      { type: "response_item", payload: { type: "reasoning", summary: [] } },
      { type: "response_item", payload: { type: "custom_tool_call", id: "ctc_1" } },
      { type: "event_msg", payload: { type: "task_started" } },
      message("user", "real prompt"),
    ]);
    expect(parseCodexTranscript(path).messages).toEqual([
      { role: "user", text: "real prompt", at: "2026-09-20T04:44:00.000Z" },
    ]);
  });

  it("drops a user message that is only injected context", () => {
    const path = writeRollout([
      META,
      message("user", "<recommended_plugins>\n- Airtable\n</recommended_plugins>"),
      message("user", "<environment_context>cwd=F:\\repo</environment_context>"),
      message("user", "<user_instructions>be brief</user_instructions>"),
      message("user", "actual question"),
    ]);
    expect(parseCodexTranscript(path).messages.map((m) => m.text)).toEqual(["actual question"]);
  });

  it("joins multi-part content and skips malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-codex-transcript-"));
    const path = join(dir, "rollout-test.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(META),
        "{ not json",
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "part one " },
              { type: "output_text", text: "part two" },
            ],
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    expect(parseCodexTranscript(path).messages).toEqual([
      { role: "assistant", text: "part one part two" },
    ]);
  });

  it("caps a runaway message", () => {
    const path = writeRollout([
      META,
      message("user", "x".repeat(MAX_IMPORTED_MESSAGE_CHARS + 500)),
    ]);
    const [only] = parseCodexTranscript(path).messages;
    expect(only?.text.length).toBeLessThanOrEqual(MAX_IMPORTED_MESSAGE_CHARS);
    expect(only?.text.endsWith("[… truncated on import]")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/sessionImport/codexTranscript.test.ts`
Expected: FAIL — `Failed to resolve import "./codexTranscript"`.

- [ ] **Step 3: Write the shared transcript types**

Create `src/main/sessionImport/transcript.ts`:

```ts
/**
 * Shared shape every provider transcript parser produces. Import replays text
 * only: a chat pane of half-mapped tool rows reads worse than a clean
 * conversation, and the resumed provider session still has the real history.
 */

export interface ImportedMessage {
  role: "user" | "assistant";
  text: string;
  /** Timestamp recorded by the provider, when the line carries one. */
  at?: string;
}

export interface ImportedTranscript {
  providerSessionId?: string;
  cwd?: string;
  startedAt?: string;
  messages: ImportedMessage[];
}

/** One pasted file should not put megabytes into a single chat row. */
export const MAX_IMPORTED_MESSAGE_CHARS = 100_000;
export const TRUNCATION_MARKER = "\n\n[… truncated on import]";

export function capMessageText(text: string): string {
  if (text.length <= MAX_IMPORTED_MESSAGE_CHARS) return text;
  return text.slice(0, MAX_IMPORTED_MESSAGE_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
```

- [ ] **Step 4: Write the Codex parser**

Create `src/main/sessionImport/codexTranscript.ts`:

```ts
import { readFileSync } from "node:fs";
import { capMessageText, type ImportedMessage, type ImportedTranscript } from "./transcript";

/**
 * Codex rollout files are JSONL. The first line is `session_meta`; conversation
 * turns are `response_item` lines whose payload is a `message`. Everything else
 * (`reasoning`, `*_tool_call*`, `event_msg`, `turn_context`, `world_state`) is
 * machinery the import deliberately drops.
 */

interface CodexHead {
  providerSessionId?: string;
  cwd?: string;
  startedAt?: string;
}

/**
 * Text Codex injects into the conversation as a `user` message. Importing it
 * would show the user words they never typed, so a message made only of these
 * wrappers is dropped.
 */
const INJECTED_WRAPPER_RE =
  /^\s*<(app-context|recommended_plugins|environment_context|user_instructions)>[\s\S]*<\/\1>\s*$/u;

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function headFrom(entry: Record<string, unknown>): CodexHead | undefined {
  if (entry["type"] !== "session_meta") return undefined;
  const payload = entry["payload"];
  if (!payload || typeof payload !== "object") return undefined;
  const meta = payload as Record<string, unknown>;
  const head: CodexHead = {};
  if (typeof meta["session_id"] === "string") head.providerSessionId = meta["session_id"];
  if (typeof meta["cwd"] === "string") head.cwd = meta["cwd"];
  if (typeof meta["timestamp"] === "string") head.startedAt = meta["timestamp"];
  return head;
}

/** Read only the first line — enough to list a session without parsing it all. */
export function readCodexSessionHead(path: string): CodexHead | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const [firstLine = ""] = raw.split(/\r?\n/u, 1);
  const entry = parseLine(firstLine);
  return entry ? headFrom(entry) : undefined;
}

function messageFrom(entry: Record<string, unknown>): ImportedMessage | undefined {
  if (entry["type"] !== "response_item") return undefined;
  const payload = entry["payload"];
  if (!payload || typeof payload !== "object") return undefined;
  const item = payload as Record<string, unknown>;
  if (item["type"] !== "message") return undefined;
  const role = item["role"];
  if (role !== "user" && role !== "assistant") return undefined;

  const content = item["content"];
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      const kind = block["type"];
      if (kind !== "input_text" && kind !== "output_text") return "";
      return typeof block["text"] === "string" ? block["text"] : "";
    })
    .join("");
  if (text.trim().length === 0) return undefined;
  if (role === "user" && INJECTED_WRAPPER_RE.test(text)) return undefined;

  const at = entry["timestamp"];
  return {
    role,
    text: capMessageText(text),
    ...(typeof at === "string" ? { at } : {}),
  };
}

export function parseCodexTranscript(path: string): ImportedTranscript {
  const raw = readFileSync(path, "utf8");
  const transcript: ImportedTranscript = { messages: [] };
  for (const line of raw.split(/\r?\n/u)) {
    const entry = parseLine(line);
    if (!entry) continue;
    const head = headFrom(entry);
    if (head) {
      Object.assign(transcript, head);
      continue;
    }
    const message = messageFrom(entry);
    if (message) transcript.messages.push(message);
  }
  return transcript;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run src/main/sessionImport/codexTranscript.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
git add src/main/sessionImport/transcript.ts src/main/sessionImport/codexTranscript.ts src/main/sessionImport/codexTranscript.test.ts
git commit -m "feat(import): parse Codex rollout transcripts"
```

---

### Task 3: Claude transcript parser

**Files:**

- Create: `src/main/sessionImport/claudeTranscript.ts`
- Test: `src/main/sessionImport/claudeTranscript.test.ts`

**Interfaces:**

- Consumes: `ImportedTranscript`, `ImportedMessage`, `capMessageText` from Task 2's `transcript.ts`.
- Produces: `parseClaudeTranscript(path: string): ImportedTranscript`, `readClaudeSessionHead(path: string): { providerSessionId?: string; cwd?: string; startedAt?: string } | undefined`

- [ ] **Step 1: Write the failing test**

Create `src/main/sessionImport/claudeTranscript.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript, readClaudeSessionHead } from "./claudeTranscript";
import { MAX_IMPORTED_MESSAGE_CHARS } from "./transcript";

function writeLog(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "poracode-claude-transcript-"));
  const path = join(dir, "9f1c6b22-0000-4000-8000-000000000001.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return path;
}

const USER_TEXT = {
  type: "user",
  sessionId: "9f1c6b22-0000-4000-8000-000000000001",
  cwd: "F:\\repo",
  timestamp: "2026-09-20T05:00:00.000Z",
  message: { role: "user", content: "fix the bug" },
};

const ASSISTANT_TEXT = {
  type: "assistant",
  timestamp: "2026-09-20T05:00:10.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "on it" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ],
  },
};

describe("readClaudeSessionHead", () => {
  it("takes the session id from the first line that carries one", () => {
    const path = writeLog([{ type: "mode", mode: "normal" }, USER_TEXT]);
    expect(readClaudeSessionHead(path)).toEqual({
      providerSessionId: "9f1c6b22-0000-4000-8000-000000000001",
      cwd: "F:\\repo",
      startedAt: "2026-09-20T05:00:00.000Z",
    });
  });

  it("falls back to the file name when no line carries a session id", () => {
    const path = writeLog([{ type: "mode", mode: "normal" }]);
    expect(readClaudeSessionHead(path)?.providerSessionId).toBe(
      "9f1c6b22-0000-4000-8000-000000000001",
    );
  });
});

describe("parseClaudeTranscript", () => {
  it("keeps string and text-array content, dropping thinking and tool_use", () => {
    const path = writeLog([USER_TEXT, ASSISTANT_TEXT]);
    expect(parseClaudeTranscript(path).messages).toEqual([
      { role: "user", text: "fix the bug", at: "2026-09-20T05:00:00.000Z" },
      { role: "assistant", text: "on it", at: "2026-09-20T05:00:10.000Z" },
    ]);
  });

  it("drops a user line that only carries tool results", () => {
    const path = writeLog([
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      },
      USER_TEXT,
    ]);
    expect(parseClaudeTranscript(path).messages.map((m) => m.text)).toEqual(["fix the bug"]);
  });

  it("drops sub-agent lines and meta line types", () => {
    const path = writeLog([
      { type: "bridge-session", sessionId: "x" },
      { type: "queue-operation", operation: "enqueue" },
      { type: "system", subtype: "stop_hook_summary" },
      { type: "attachment", attachment: { type: "hook_success" } },
      {
        type: "assistant",
        isSidechain: true,
        message: { content: [{ type: "text", text: "sub" }] },
      },
      USER_TEXT,
    ]);
    expect(parseClaudeTranscript(path).messages.map((m) => m.text)).toEqual(["fix the bug"]);
  });

  it("skips malformed lines and caps a runaway message", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-claude-transcript-"));
    const path = join(dir, "sess.jsonl");
    writeFileSync(
      path,
      [
        "{ not json",
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "y".repeat(MAX_IMPORTED_MESSAGE_CHARS + 500) },
        }),
      ].join("\n"),
      "utf8",
    );
    const [only] = parseClaudeTranscript(path).messages;
    expect(only?.text.length).toBeLessThanOrEqual(MAX_IMPORTED_MESSAGE_CHARS);
    expect(only?.text.endsWith("[… truncated on import]")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/sessionImport/claudeTranscript.test.ts`
Expected: FAIL — `Failed to resolve import "./claudeTranscript"`.

- [ ] **Step 3: Write the Claude parser**

Create `src/main/sessionImport/claudeTranscript.ts`:

```ts
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { capMessageText, type ImportedMessage, type ImportedTranscript } from "./transcript";

/**
 * Claude Code writes one JSONL file per session under
 * `<home>/projects/<encoded cwd>/<session id>.jsonl`. Conversation lines are
 * `type: "user" | "assistant"`; everything else on the stream (hooks, queue
 * operations, bridge/session bookkeeping) is machinery. `isSidechain` marks
 * sub-agent traffic, which the import drops so the transcript matches what the
 * user actually saw in their own pane.
 */

interface ClaudeHead {
  providerSessionId?: string;
  cwd?: string;
  startedAt?: string;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sessionIdFromFileName(path: string): string {
  return basename(path).replace(/\.jsonl$/iu, "");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      if (block["type"] !== "text") return "";
      return typeof block["text"] === "string" ? block["text"] : "";
    })
    .join("");
}

function messageFrom(entry: Record<string, unknown>): ImportedMessage | undefined {
  const role = entry["type"];
  if (role !== "user" && role !== "assistant") return undefined;
  if (entry["isSidechain"] === true) return undefined;
  const message = entry["message"];
  if (!message || typeof message !== "object") return undefined;
  const text = textFromContent((message as Record<string, unknown>)["content"]);
  if (text.trim().length === 0) return undefined;
  const at = entry["timestamp"];
  return {
    role,
    text: capMessageText(text),
    ...(typeof at === "string" ? { at } : {}),
  };
}

export function readClaudeSessionHead(path: string): ClaudeHead | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const head: ClaudeHead = { providerSessionId: sessionIdFromFileName(path) };
  for (const line of raw.split(/\r?\n/u)) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (typeof entry["sessionId"] === "string") head.providerSessionId = entry["sessionId"];
    if (!head.cwd && typeof entry["cwd"] === "string") head.cwd = entry["cwd"];
    if (!head.startedAt && typeof entry["timestamp"] === "string") {
      head.startedAt = entry["timestamp"];
    }
    if (head.cwd && head.startedAt) break;
  }
  return head;
}

export function parseClaudeTranscript(path: string): ImportedTranscript {
  const raw = readFileSync(path, "utf8");
  const transcript: ImportedTranscript = {
    providerSessionId: sessionIdFromFileName(path),
    messages: [],
  };
  for (const line of raw.split(/\r?\n/u)) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (typeof entry["sessionId"] === "string") transcript.providerSessionId = entry["sessionId"];
    if (!transcript.cwd && typeof entry["cwd"] === "string") transcript.cwd = entry["cwd"];
    if (!transcript.startedAt && typeof entry["timestamp"] === "string") {
      transcript.startedAt = entry["timestamp"];
    }
    const message = messageFrom(entry);
    if (message) transcript.messages.push(message);
  }
  return transcript;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/main/sessionImport/claudeTranscript.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
git add src/main/sessionImport/claudeTranscript.ts src/main/sessionImport/claudeTranscript.test.ts
git commit -m "feat(import): parse Claude Code transcripts"
```

---

### Task 4: Home enumeration and session scanner

**Files:**

- Create: `src/main/sessionImport/homes.ts`
- Create: `src/main/sessionImport/scan.ts`
- Test: `src/main/sessionImport/homes.test.ts`
- Test: `src/main/sessionImport/scan.test.ts`

**Interfaces:**

- Consumes: `readCodexSessionHead`, `parseCodexTranscript` (Task 2); `readClaudeSessionHead`, `parseClaudeTranscript` (Task 3); `ImportableSession`, `ImportedSessionProvider` (Task 1); `SharedSettings` from `@/shared/settings`; `parseCodexProfileInstanceConfig`, `parseClaudeProfileInstanceConfig`, `codexProfileKind`, `claudeProfileKind` from `@/shared/contracts`.
- Produces:
  - `homes.ts`: `export interface ImportHome { provider: ImportedSessionProvider; agentKind: string; dir: string }` and `resolveImportHomes(settings: SharedSettings): ImportHome[]`
  - `scan.ts`: `scanImportableSessions(input: { homes: readonly ImportHome[]; cwd?: string; provider?: ImportedSessionProvider }): ImportableSession[]`

- [ ] **Step 1: Write the failing test for home enumeration**

Create `src/main/sessionImport/homes.test.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSharedSettings } from "@/shared/settings";
import { resolveImportHomes } from "./homes";

describe("resolveImportHomes", () => {
  it("always includes the base Codex and Claude homes", () => {
    expect(resolveImportHomes(defaultSharedSettings)).toEqual([
      { provider: "codex", agentKind: "codex", dir: join(homedir(), ".codex") },
      { provider: "claude", agentKind: "claude", dir: join(homedir(), ".claude") },
    ]);
  });

  it("adds a home per enabled Codex and Claude profile, expanding ~/", () => {
    const homes = resolveImportHomes({
      ...defaultSharedSettings,
      agentInstances: {
        work: {
          id: "work",
          driver: "codex",
          displayName: "Work",
          config: { homeDir: "~/.poracode/codex-profiles/work" },
        },
        glm: {
          id: "glm",
          driver: "claude",
          displayName: "GLM",
          config: { configDir: "/abs/claude-glm" },
        },
      },
    });
    expect(homes).toContainEqual({
      provider: "codex",
      agentKind: "codex:work",
      dir: join(homedir(), ".poracode/codex-profiles/work"),
    });
    expect(homes).toContainEqual({
      provider: "claude",
      agentKind: "claude:glm",
      dir: "/abs/claude-glm",
    });
  });

  it("skips disabled profiles, other drivers, and malformed configs", () => {
    const homes = resolveImportHomes({
      ...defaultSharedSettings,
      agentInstances: {
        off: {
          id: "off",
          driver: "codex",
          displayName: "Off",
          enabled: false,
          config: { homeDir: "~/.codex-off" },
        },
        broken: { id: "broken", driver: "codex", displayName: "Broken", config: {} },
        cursor: { id: "cursor", driver: "cursor", displayName: "Cursor" },
      },
    });
    expect(homes.map((home) => home.agentKind)).toEqual(["codex", "claude"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/sessionImport/homes.test.ts`
Expected: FAIL — `Failed to resolve import "./homes"`.

- [ ] **Step 3: Write the home resolver**

Create `src/main/sessionImport/homes.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeProfileKind,
  codexProfileKind,
  parseClaudeProfileInstanceConfig,
  parseCodexProfileInstanceConfig,
  type ImportedSessionProvider,
} from "@/shared/contracts";
import type { SharedSettings } from "@/shared/settings";

/**
 * Every provider home whose transcripts can be imported: the base account plus
 * one per enabled profile. Import is a host-only feature, so WSL homes are not
 * enumerated here.
 */
export interface ImportHome {
  provider: ImportedSessionProvider;
  /** Agent kind that owns this home — an imported thread is created under it. */
  agentKind: string;
  dir: string;
}

function resolveNativeTildePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function resolveImportHomes(settings: SharedSettings): ImportHome[] {
  const homes: ImportHome[] = [
    { provider: "codex", agentKind: "codex", dir: join(homedir(), ".codex") },
    { provider: "claude", agentKind: "claude", dir: join(homedir(), ".claude") },
  ];
  for (const instance of Object.values(settings.agentInstances)) {
    if (instance.enabled === false) continue;
    try {
      if (instance.driver === "codex") {
        const config = parseCodexProfileInstanceConfig(instance.config);
        homes.push({
          provider: "codex",
          agentKind: codexProfileKind(instance.id),
          dir: resolveNativeTildePath(config.homeDir),
        });
      } else if (instance.driver === "claude") {
        const config = parseClaudeProfileInstanceConfig(instance.config);
        homes.push({
          provider: "claude",
          agentKind: claudeProfileKind(instance.id),
          dir: resolveNativeTildePath(config.configDir),
        });
      }
    } catch {
      // Malformed profile records are skipped by the agent registry too.
    }
  }
  return homes;
}
```

- [ ] **Step 4: Run the home test to verify it passes**

Run: `pnpm exec vitest run src/main/sessionImport/homes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing scanner test**

Create `src/main/sessionImport/scan.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanImportableSessions } from "./scan";
import type { ImportHome } from "./homes";

function codexHome(sessions: Array<{ id: string; cwd: string; prompt: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "poracode-scan-codex-"));
  const sessionsDir = join(dir, "sessions", "2026", "09", "20");
  mkdirSync(sessionsDir, { recursive: true });
  for (const session of sessions) {
    writeFileSync(
      join(sessionsDir, `rollout-2026-09-20T04-43-18-${session.id}.jsonl`),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            session_id: session.id,
            cwd: session.cwd,
            timestamp: "2026-09-20T04:43:18.000Z",
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: session.prompt }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
  }
  return dir;
}

function claudeHome(sessions: Array<{ id: string; cwd: string; prompt: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "poracode-scan-claude-"));
  for (const session of sessions) {
    const projectDir = join(dir, "projects", session.cwd.replace(/[:\\/]/gu, "-"));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${session.id}.jsonl`),
      JSON.stringify({
        type: "user",
        sessionId: session.id,
        cwd: session.cwd,
        timestamp: "2026-09-20T05:00:00.000Z",
        message: { role: "user", content: session.prompt },
      }),
      "utf8",
    );
  }
  return dir;
}

describe("scanImportableSessions", () => {
  it("lists sessions from both providers with preview and attribution", () => {
    const homes: ImportHome[] = [
      {
        provider: "codex",
        agentKind: "codex:work",
        dir: codexHome([{ id: "cx-1", cwd: "F:\\repo", prompt: "fix the bug" }]),
      },
      {
        provider: "claude",
        agentKind: "claude",
        dir: claudeHome([{ id: "cl-1", cwd: "F:\\repo", prompt: "write a test" }]),
      },
    ];
    const sessions = scanImportableSessions({ homes });
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.provider === "codex")).toMatchObject({
      id: "codex:cx-1",
      agentKind: "codex:work",
      providerSessionId: "cx-1",
      cwd: "F:\\repo",
      preview: "fix the bug",
      messageCount: 1,
    });
    expect(sessions.find((s) => s.provider === "claude")).toMatchObject({
      id: "claude:cl-1",
      agentKind: "claude",
      preview: "write a test",
    });
  });

  it("filters by cwd case-insensitively and by provider", () => {
    const homes: ImportHome[] = [
      {
        provider: "codex",
        agentKind: "codex",
        dir: codexHome([
          { id: "cx-here", cwd: "F:\\repo", prompt: "here" },
          { id: "cx-elsewhere", cwd: "F:\\other", prompt: "elsewhere" },
        ]),
      },
      {
        provider: "claude",
        agentKind: "claude",
        dir: claudeHome([{ id: "cl-here", cwd: "F:\\repo", prompt: "claude here" }]),
      },
    ];
    expect(
      scanImportableSessions({ homes, cwd: "f:\\REPO" }).map((s) => s.providerSessionId),
    ).toEqual(expect.arrayContaining(["cx-here", "cl-here"]));
    expect(scanImportableSessions({ homes, cwd: "f:\\REPO" })).toHaveLength(2);
    expect(
      scanImportableSessions({ homes, provider: "codex" }).every((s) => s.provider === "codex"),
    ).toBe(true);
  });

  it("dedupes a session visible in two homes and skips missing directories", () => {
    const shared = codexHome([{ id: "cx-dup", cwd: "F:\\repo", prompt: "dup" }]);
    const homes: ImportHome[] = [
      { provider: "codex", agentKind: "codex", dir: shared },
      { provider: "codex", agentKind: "codex:work", dir: shared },
      { provider: "codex", agentKind: "codex:gone", dir: join(tmpdir(), "poracode-not-there") },
    ];
    expect(scanImportableSessions({ homes })).toHaveLength(1);
  });

  it("returns an empty list rather than throwing on an unreadable transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-scan-bad-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "rollout-broken.jsonl"), "{ not json", "utf8");
    expect(
      scanImportableSessions({ homes: [{ provider: "codex", agentKind: "codex", dir }] }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the scanner test to verify it fails**

Run: `pnpm exec vitest run src/main/sessionImport/scan.test.ts`
Expected: FAIL — `Failed to resolve import "./scan"`.

- [ ] **Step 7: Write the scanner**

Create `src/main/sessionImport/scan.ts`:

```ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ImportableSession, ImportedSessionProvider } from "@/shared/contracts";
import { parseClaudeTranscript, readClaudeSessionHead } from "./claudeTranscript";
import { parseCodexTranscript, readCodexSessionHead } from "./codexTranscript";
import type { ImportHome } from "./homes";
import type { ImportedTranscript } from "./transcript";

/** Preview lines are a list affordance, not a document. */
const PREVIEW_MAX_CHARS = 200;

function walkFiles(root: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && accept(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string) => value.replace(/[\\/]+$/u, "").replace(/\\/gu, "/");
  return (
    normalize(left).localeCompare(normalize(right), undefined, { sensitivity: "accent" }) === 0
  );
}

function previewOf(transcript: ImportedTranscript): string {
  const first = transcript.messages.find((message) => message.role === "user");
  const text = (first?.text ?? "").replace(/\s+/gu, " ").trim();
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

function updatedAtOf(path: string): string | undefined {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

function sessionFilesFor(home: ImportHome): string[] {
  return home.provider === "codex"
    ? walkFiles(
        join(home.dir, "sessions"),
        (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
      )
    : walkFiles(join(home.dir, "projects"), (name) => name.endsWith(".jsonl"));
}

function describeSession(home: ImportHome, path: string): ImportableSession | undefined {
  const head = home.provider === "codex" ? readCodexSessionHead(path) : readClaudeSessionHead(path);
  if (!head?.providerSessionId) return undefined;
  let transcript: ImportedTranscript;
  try {
    transcript =
      home.provider === "codex" ? parseCodexTranscript(path) : parseClaudeTranscript(path);
  } catch {
    return undefined;
  }
  if (transcript.messages.length === 0) return undefined;
  const cwd = transcript.cwd ?? head.cwd;
  const startedAt = transcript.startedAt ?? head.startedAt;
  const updatedAt = updatedAtOf(path);
  return {
    id: `${home.provider}:${head.providerSessionId}`,
    provider: home.provider,
    agentKind: home.agentKind,
    providerSessionId: head.providerSessionId,
    path,
    ...(cwd ? { cwd } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    messageCount: transcript.messages.length,
    preview: previewOf(transcript),
  };
}

/**
 * Discover importable transcripts across the given homes. Never throws: an
 * unreadable file or a missing home is skipped so one bad session cannot hide
 * the rest of a user's history.
 */
export function scanImportableSessions(input: {
  homes: readonly ImportHome[];
  cwd?: string;
  provider?: ImportedSessionProvider;
}): ImportableSession[] {
  const byId = new Map<string, ImportableSession>();
  for (const home of input.homes) {
    if (input.provider && home.provider !== input.provider) continue;
    for (const path of sessionFilesFor(home)) {
      const session = describeSession(home, path);
      if (!session) continue;
      if (input.cwd && !samePath(session.cwd, input.cwd)) continue;
      if (!byId.has(session.id)) byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((left, right) =>
    (right.updatedAt ?? right.startedAt ?? "").localeCompare(
      left.updatedAt ?? left.startedAt ?? "",
    ),
  );
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `pnpm exec vitest run src/main/sessionImport/homes.test.ts src/main/sessionImport/scan.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 9: Typecheck and commit**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
git add src/main/sessionImport/homes.ts src/main/sessionImport/homes.test.ts src/main/sessionImport/scan.ts src/main/sessionImport/scan.test.ts
git commit -m "feat(import): discover importable CLI sessions across provider homes"
```

---

### Task 5: Transcript replay into a thread

**Files:**

- Create: `src/main/sessionImport/replay.ts`
- Test: `src/main/sessionImport/replay.test.ts`

**Interfaces:**

- Consumes: `ImportedTranscript`, `ImportedMessage` (Task 2); `RuntimeEvent`, `CanonicalContentBlock` from `@/shared/contracts`.
- Produces:
  - `REPLAY_BATCH_SIZE = 200`
  - `buildReplayEvents(threadId: string, transcript: ImportedTranscript): RuntimeEvent[]`
  - `replayTranscript(input: { threadId: string; transcript: ImportedTranscript; apply: (threadId: string, events: readonly RuntimeEvent[]) => void; flush: (threadId: string) => void }): number` — returns the replayed message count

- [ ] **Step 1: Write the failing test**

Create `src/main/sessionImport/replay.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@/shared/contracts";
import { buildReplayEvents, REPLAY_BATCH_SIZE, replayTranscript } from "./replay";

describe("buildReplayEvents", () => {
  it("emits a started/completed pair per user message with text content", () => {
    const events = buildReplayEvents("t1", {
      messages: [{ role: "user", text: "hello" }],
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "item.started",
      threadId: "t1",
      itemType: "user_message",
      payload: { content: [{ kind: "text", text: "hello" }] },
    });
    expect(events[1]).toMatchObject({ type: "item.completed", threadId: "t1" });
    expect((events[0] as { itemId: string }).itemId).toBe((events[1] as { itemId: string }).itemId);
  });

  it("streams assistant text through the assistant_text stream", () => {
    const events = buildReplayEvents("t1", {
      messages: [{ role: "assistant", text: "done" }],
    });
    expect(events.map((event) => event.type)).toEqual([
      "item.started",
      "content.delta",
      "item.completed",
    ]);
    expect(events[1]).toMatchObject({ stream: "assistant_text", delta: "done" });
  });

  it("gives every item a distinct id and preserves order", () => {
    const events = buildReplayEvents("t1", {
      messages: [
        { role: "user", text: "one" },
        { role: "assistant", text: "two" },
        { role: "user", text: "three" },
      ],
    });
    const startedIds = events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "item.started" }> =>
          event.type === "item.started",
      )
      .map((event) => event.itemId);
    expect(new Set(startedIds).size).toBe(3);
  });

  it("returns nothing for an empty transcript", () => {
    expect(buildReplayEvents("t1", { messages: [] })).toEqual([]);
  });
});

describe("replayTranscript", () => {
  it("applies events in batches and flushes once", () => {
    const apply = vi.fn<(threadId: string, events: readonly RuntimeEvent[]) => void>();
    const flush = vi.fn<(threadId: string) => void>();
    const messages = Array.from({ length: 150 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `m${index}`,
    }));

    const count = replayTranscript({ threadId: "t1", transcript: { messages }, apply, flush });

    expect(count).toBe(150);
    // 75 user messages × 2 events + 75 assistant × 3 = 375 events → 2 batches.
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0]?.[1].length).toBe(REPLAY_BATCH_SIZE);
    expect(flush).toHaveBeenCalledExactlyOnceWith("t1");
  });

  it("does not touch the database for an empty transcript", () => {
    const apply = vi.fn();
    const flush = vi.fn();
    expect(replayTranscript({ threadId: "t1", transcript: { messages: [] }, apply, flush })).toBe(
      0,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/sessionImport/replay.test.ts`
Expected: FAIL — `Failed to resolve import "./replay"`.

- [ ] **Step 3: Write the replay builder**

Create `src/main/sessionImport/replay.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "@/shared/contracts";
import type { ImportedTranscript } from "./transcript";

/**
 * An imported transcript is replayed as the same canonical runtime events a
 * live session emits, so the existing persistence layer owns ordering,
 * positions, and stream storage. Assistant text rides the `assistant_text`
 * stream exactly as it would during streaming; user text is a content block on
 * the item payload.
 */

export const REPLAY_BATCH_SIZE = 200;

export function buildReplayEvents(
  threadId: string,
  transcript: ImportedTranscript,
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const message of transcript.messages) {
    const itemId = `import-${randomUUID()}`;
    if (message.role === "user") {
      events.push({
        type: "item.started",
        threadId,
        itemId,
        itemType: "user_message",
        payload: { content: [{ kind: "text", text: message.text }] },
      });
    } else {
      events.push({ type: "item.started", threadId, itemId, itemType: "assistant_message" });
      events.push({
        type: "content.delta",
        threadId,
        itemId,
        stream: "assistant_text",
        delta: message.text,
      });
    }
    events.push({ type: "item.completed", threadId, itemId });
  }
  return events;
}

export function replayTranscript(input: {
  threadId: string;
  transcript: ImportedTranscript;
  apply: (threadId: string, events: readonly RuntimeEvent[]) => void;
  flush: (threadId: string) => void;
}): number {
  const events = buildReplayEvents(input.threadId, input.transcript);
  if (events.length === 0) return 0;
  for (let index = 0; index < events.length; index += REPLAY_BATCH_SIZE) {
    input.apply(input.threadId, events.slice(index, index + REPLAY_BATCH_SIZE));
  }
  input.flush(input.threadId);
  return input.transcript.messages.length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/main/sessionImport/replay.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
git add src/main/sessionImport/replay.ts src/main/sessionImport/replay.test.ts
git commit -m "feat(import): replay transcripts as canonical runtime events"
```

---

### Task 6: IPC procedures and main handlers

**Files:**

- Create: `src/shared/ipc/procedures/sessionImport.ts`
- Modify: `src/shared/ipc/procedureMap.ts` (import the new group, add it to `groupedIpcProcedures`)
- Create: `src/main/sessionImport/index.ts`
- Modify: `src/main/ipc/localHandlers.ts` (register the two handlers next to `createProfile` at line ~460)
- Test: `src/main/sessionImport/index.test.ts`

**Interfaces:**

- Consumes: `resolveImportHomes` (Task 4), `scanImportableSessions` (Task 4), `parseCodexTranscript` / `parseClaudeTranscript` (Tasks 2–3), `replayTranscript` (Task 5), payload schemas (Task 1); `dbApplyThreadRuntimeEvents`, `dbFlushThreadRuntimeWrites` from `@/main/db/runtimeItems`; `dbGetThreads` from `@/main/db/projectsThreads`.
- Produces:
  - `sessionImportProcedures` with `listImportableSessions` (payload `ListImportableSessionsPayload` → `ImportableSession[]`, `"main-local"`) and `importSessionTranscript` (payload `ImportSessionTranscriptPayload` → `ImportSessionTranscriptResult`, `"main-local"`)
  - `src/main/sessionImport/index.ts`: `listImportableSessions(payload, deps)` and `importSessionTranscript(payload, deps)` where
    ```ts
    export interface SessionImportDeps {
      readSharedSettings: () => SharedSettings;
      getThreads: () => readonly Thread[];
      applyRuntimeEvents: (threadId: string, events: readonly RuntimeEvent[]) => void;
      flushRuntimeWrites: (threadId: string) => void;
    }
    ```
  - Renderer call sites use `readBridge().listImportableSessions(payload)` and `readBridge().importSessionTranscript(payload)`.

- [ ] **Step 1: Write the failing test**

Create `src/main/sessionImport/index.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("listImportableSessions", () => {
  it("marks a session that a thread already imported", () => {
    const { dir, path } = codexHomeWith("cx-1", "F:\\repo", "fix the bug");
    const settings = {
      ...defaultSharedSettings,
      agentInstances: {
        work: {
          id: "work",
          driver: "codex",
          displayName: "Work",
          config: { homeDir: dir },
        },
      },
    };
    const imported = thread({
      id: "already",
      config: {
        model: "gpt-5.5",
        importedFrom: { provider: "codex", path, importedAt: "2026-09-20T06:00:00.000Z" },
      },
    });

    const sessions = listImportableSessions(
      {},
      {
        readSharedSettings: () => settings,
        getThreads: () => [imported],
        applyRuntimeEvents: vi.fn(),
        flushRuntimeWrites: vi.fn(),
      },
    );

    expect(sessions.find((session) => session.providerSessionId === "cx-1")?.importedThreadId).toBe(
      "already",
    );
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

    expect(result).toEqual({ messageCount: 2 });
    expect(applied.filter((event) => event.type === "item.started")).toHaveLength(2);
    expect(flushRuntimeWrites).toHaveBeenCalledExactlyOnceWith("t1");
  });

  it("throws for an unknown thread and for a missing file", () => {
    const { path } = codexHomeWith("cx-3", "F:\\repo", "hello");
    const deps = {
      readSharedSettings: () => defaultSharedSettings,
      getThreads: () => [] as Thread[],
      applyRuntimeEvents: vi.fn(),
      flushRuntimeWrites: vi.fn(),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/sessionImport/index.test.ts`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: Write the main-side entry points**

Create `src/main/sessionImport/index.ts`:

```ts
import type {
  ImportSessionTranscriptPayload,
  ImportSessionTranscriptResult,
  ImportableSession,
  ListImportableSessionsPayload,
  RuntimeEvent,
  Thread,
} from "@/shared/contracts";
import type { SharedSettings } from "@/shared/settings";
import { parseClaudeTranscript } from "./claudeTranscript";
import { parseCodexTranscript } from "./codexTranscript";
import { resolveImportHomes } from "./homes";
import { replayTranscript } from "./replay";
import { scanImportableSessions } from "./scan";

export interface SessionImportDeps {
  readSharedSettings: () => SharedSettings;
  getThreads: () => readonly Thread[];
  applyRuntimeEvents: (threadId: string, events: readonly RuntimeEvent[]) => void;
  flushRuntimeWrites: (threadId: string) => void;
}

/** Transcript path → thread that already imported it. */
function importedThreadsByPath(threads: readonly Thread[]): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const thread of threads) {
    const imported = thread.config.importedFrom;
    if (imported && !byPath.has(imported.path)) byPath.set(imported.path, thread.id);
  }
  return byPath;
}

export function listImportableSessions(
  payload: ListImportableSessionsPayload,
  deps: SessionImportDeps,
): ImportableSession[] {
  const homes = resolveImportHomes(deps.readSharedSettings());
  const sessions = scanImportableSessions({
    homes,
    ...(payload.cwd ? { cwd: payload.cwd } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
  });
  const imported = importedThreadsByPath(deps.getThreads());
  return sessions.map((session) => {
    const threadId = imported.get(session.path);
    return threadId ? { ...session, importedThreadId: threadId } : session;
  });
}

export function importSessionTranscript(
  payload: ImportSessionTranscriptPayload,
  deps: SessionImportDeps,
): ImportSessionTranscriptResult {
  const exists = deps.getThreads().some((thread) => thread.id === payload.threadId);
  if (!exists) {
    throw new Error(`Cannot import into unknown thread ${payload.threadId}.`);
  }
  const transcript =
    payload.provider === "codex"
      ? parseCodexTranscript(payload.path)
      : parseClaudeTranscript(payload.path);
  const messageCount = replayTranscript({
    threadId: payload.threadId,
    transcript,
    apply: deps.applyRuntimeEvents,
    flush: deps.flushRuntimeWrites,
  });
  return { messageCount };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/main/sessionImport/index.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Declare the IPC procedures**

Create `src/shared/ipc/procedures/sessionImport.ts`:

```ts
import {
  importSessionTranscriptPayloadSchema,
  listImportableSessionsPayloadSchema,
  type ImportSessionTranscriptPayload,
  type ImportSessionTranscriptResult,
  type ImportableSession,
  type ListImportableSessionsPayload,
} from "../../contracts";
import { definePayloadProcedure } from "../core";

export const sessionImportProcedures = {
  listImportableSessions: definePayloadProcedure<
    ListImportableSessionsPayload,
    ImportableSession[],
    "main-local"
  >("listImportableSessions", "main-local", listImportableSessionsPayloadSchema),
  importSessionTranscript: definePayloadProcedure<
    ImportSessionTranscriptPayload,
    ImportSessionTranscriptResult,
    "main-local"
  >("importSessionTranscript", "main-local", importSessionTranscriptPayloadSchema),
} as const;
```

In `src/shared/ipc/procedureMap.ts`, add the import alongside the others:

```ts
import { sessionImportProcedures } from "./procedures/sessionImport";
```

and the group inside `groupedIpcProcedures`:

```ts
  sessionImport: sessionImportProcedures,
```

- [ ] **Step 6: Register the handlers in main**

In `src/main/ipc/localHandlers.ts`, add the imports at the top:

```ts
import {
  importSessionTranscript as runImportSessionTranscript,
  listImportableSessions as runListImportableSessions,
  type SessionImportDeps,
} from "../sessionImport";
import { dbApplyThreadRuntimeEvents, dbFlushThreadRuntimeWrites } from "../db/runtimeItems";
```

(`dbGetThreads` is already imported in this file; if it is not, add it from `../db/projectsThreads`.)

Then, immediately after the `createProfile:` entry, add:

```ts
    listImportableSessions: async (payload) =>
      runListImportableSessions(payload, sessionImportDeps()),
    importSessionTranscript: async (payload) =>
      runImportSessionTranscript(payload, sessionImportDeps()),
```

and define the dependency bundle next to the other helpers in the same factory:

```ts
const sessionImportDeps = (): SessionImportDeps => ({
  readSharedSettings: () => readSharedSettingsFile(settingsPath),
  getThreads: () => dbGetThreads(),
  applyRuntimeEvents: dbApplyThreadRuntimeEvents,
  flushRuntimeWrites: dbFlushThreadRuntimeWrites,
});
```

Use whatever the file already calls to read shared settings — if a local helper
such as `getSharedSettings()` exists in this factory, call that instead of
`readSharedSettingsFile(settingsPath)` rather than adding a second reader.

- [ ] **Step 7: Verify the IPC surface typechecks**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no output. A missing handler for a declared procedure fails here, which is the point of this step.

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc/procedures/sessionImport.ts src/shared/ipc/procedureMap.ts src/main/sessionImport/index.ts src/main/sessionImport/index.test.ts src/main/ipc/localHandlers.ts
git commit -m "feat(import): expose session discovery and transcript replay over IPC"
```

---

### Task 7: Import panel component

**Files:**

- Create: `src/renderer/components/sessionImport/ImportSessionsPanel.tsx`
- Create: `src/renderer/components/sessionImport/importSessionsActions.ts`
- Test: `src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx`

**Interfaces:**

- Consumes: `readBridge().listImportableSessions`, `readBridge().importSessionTranscript` (Task 6); `useAppStore` with `createThread` and `updateThreadRuntime` from `src/renderer/state/appStore`; `ImportableSession` (Task 1).
- Produces:
  - `importSessionsActions.ts`: `importSessions(input: { sessions: readonly ImportableSession[]; projectId: string }): Promise<{ imported: number; failed: number }>`
  - `ImportSessionsPanel.tsx`: `ImportSessionsPanel(props: { cwd?: string; projectId?: string })`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx`:

```tsx
import { fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportableSession, Thread } from "@/shared/contracts";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";

const toastMock = vi.hoisted(() => ({
  danger: vi.fn<(message: string) => void>(),
  success: vi.fn<(message: string) => void>(),
}));

vi.mock("@heroui/react", () => ({
  Button: (props: {
    children?: ReactNode;
    "aria-label"?: string;
    isDisabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      type="button"
      aria-label={props["aria-label"]}
      disabled={props.isDisabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
  toast: toastMock,
}));

vi.mock("@/renderer/components/common", () => ({
  PixelLoader: () => <span data-testid="pixel-loader" />,
}));

const listImportableSessionsMock = vi.hoisted(() =>
  vi.fn<(payload: unknown) => Promise<ImportableSession[]>>(),
);
const importSessionTranscriptMock = vi.hoisted(() =>
  vi.fn<(payload: unknown) => Promise<{ messageCount: number }>>(),
);

vi.mock("@/renderer/bridge", () => ({
  readBridge: () => ({
    listImportableSessions: listImportableSessionsMock,
    importSessionTranscript: importSessionTranscriptMock,
  }),
}));

const createThreadMock = vi.hoisted(() => vi.fn<(input: unknown) => Thread>());
const updateThreadRuntimeMock = vi.hoisted(() => vi.fn<(id: string, input: unknown) => void>());
const storeState = {
  projects: [{ id: "p1", name: "repo", location: { kind: "windows", path: "F:\\repo" } }],
  createThread: createThreadMock,
  updateThreadRuntime: updateThreadRuntimeMock,
};

vi.mock("@/renderer/state/appStore", () => {
  const useAppStore = ((selector: (state: typeof storeState) => unknown) =>
    selector(storeState)) as unknown as {
    (selector: (state: typeof storeState) => unknown): unknown;
    getState: () => typeof storeState;
  };
  useAppStore.getState = () => storeState;
  return { useAppStore };
});

import { ImportSessionsPanel } from "./ImportSessionsPanel";

function session(overrides: Partial<ImportableSession> = {}): ImportableSession {
  return {
    id: "codex:cx-1",
    provider: "codex",
    agentKind: "codex",
    providerSessionId: "cx-1",
    path: "F:\\home\\.codex\\sessions\\rollout-cx-1.jsonl",
    cwd: "F:\\repo",
    startedAt: "2026-09-20T04:43:18.000Z",
    updatedAt: "2026-09-20T05:00:00.000Z",
    messageCount: 4,
    preview: "fix the race condition",
    ...overrides,
  };
}

beforeEach(() => {
  listImportableSessionsMock.mockReset().mockResolvedValue([session()]);
  importSessionTranscriptMock.mockReset().mockResolvedValue({ messageCount: 4 });
  createThreadMock.mockReset().mockReturnValue({ id: "new-thread" } as Thread);
  updateThreadRuntimeMock.mockReset();
  toastMock.success.mockReset();
  toastMock.danger.mockReset();
});

describe("ImportSessionsPanel", () => {
  it("lists discovered sessions for the given cwd", async () => {
    render(<ImportSessionsPanel cwd="F:\\repo" projectId="p1" />);

    expect(await screen.findByText("fix the race condition")).toBeInTheDocument();
    expect(listImportableSessionsMock).toHaveBeenCalledWith({ cwd: "F:\\repo" });
  });

  it("disables a session that was already imported", async () => {
    listImportableSessionsMock.mockResolvedValue([session({ importedThreadId: "old" })]);
    render(<ImportSessionsPanel cwd="F:\\repo" projectId="p1" />);

    const checkbox = await screen.findByRole("checkbox", { name: /fix the race condition/iu });
    expect(checkbox).toBeDisabled();
  });

  it("creates a thread with the session ref and replays the transcript", async () => {
    render(<ImportSessionsPanel cwd="F:\\repo" projectId="p1" />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /fix the race condition/iu }));
    fireEvent.click(screen.getByRole("button", { name: /import 1 session/iu }));

    await vi.waitFor(() =>
      expect(createThreadMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          agentKind: "codex",
          title: "fix the race condition",
          config: expect.objectContaining({
            importedFrom: expect.objectContaining({
              provider: "codex",
              path: "F:\\home\\.codex\\sessions\\rollout-cx-1.jsonl",
            }),
          }),
        }),
      ),
    );
    expect(updateThreadRuntimeMock).toHaveBeenCalledWith(
      "new-thread",
      expect.objectContaining({
        sessionRef: expect.objectContaining({ providerSessionId: "cx-1" }),
      }),
    );
    expect(importSessionTranscriptMock).toHaveBeenCalledWith({
      threadId: "new-thread",
      provider: "codex",
      path: "F:\\home\\.codex\\sessions\\rollout-cx-1.jsonl",
    });
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("reports a failed import without blocking the rest", async () => {
    listImportableSessionsMock.mockResolvedValue([
      session(),
      session({
        id: "codex:cx-2",
        providerSessionId: "cx-2",
        preview: "second",
        path: "F:\\b.jsonl",
      }),
    ]);
    importSessionTranscriptMock
      .mockRejectedValueOnce(new Error("unreadable"))
      .mockResolvedValueOnce({ messageCount: 2 });

    render(<ImportSessionsPanel cwd="F:\\repo" projectId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /select all/iu }));
    fireEvent.click(screen.getByRole("button", { name: /import 2 sessions/iu }));

    await vi.waitFor(() => expect(toastMock.danger).toHaveBeenCalled());
    expect(importSessionTranscriptMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx`
Expected: FAIL — `Failed to resolve import "./ImportSessionsPanel"`.

- [ ] **Step 3: Write the import action**

Create `src/renderer/components/sessionImport/importSessionsActions.ts`:

```ts
import { toast } from "@heroui/react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ImportableSession } from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";
import { useAppStore } from "@/renderer/state/appStore";

/** Title lines stay short enough to read in the sidebar. */
const TITLE_MAX_CHARS = 60;

function titleFor(session: ImportableSession): string {
  const preview = session.preview.trim();
  if (preview.length === 0) return i18n._(msg`Imported session`);
  return preview.length > TITLE_MAX_CHARS ? `${preview.slice(0, TITLE_MAX_CHARS)}…` : preview;
}

/**
 * Create one thread per selected session and replay its transcript. The thread
 * is created through the store's normal path, so persistence and the sidebar
 * behave exactly as they do for a thread the user started.
 */
export async function importSessions(input: {
  sessions: readonly ImportableSession[];
  projectId: string;
}): Promise<{ imported: number; failed: number }> {
  const store = useAppStore.getState();
  let imported = 0;
  let failed = 0;

  for (const session of input.sessions) {
    try {
      const thread = store.createThread({
        projectId: input.projectId,
        agentKind: session.agentKind,
        config: {
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
```

The empty `model` is replaced by the thread's own provider default on its first
launch; a config without `model` fails schema validation, so the field is present
and blank rather than absent.

- [ ] **Step 4: Write the panel**

Create `src/renderer/components/sessionImport/ImportSessionsPanel.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, toast } from "@heroui/react";
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void readBridge()
      .listImportableSessions(props.cwd ? { cwd: props.cwd } : {})
      .then((found) => {
        if (!cancelled) setSessions(found);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.danger(
            error instanceof Error ? error.message : t`Could not read existing CLI sessions.`,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.cwd, t]);

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

  const runImport = useCallback(async () => {
    if (selected.size === 0 || !projectId) return;
    setBusy(true);
    try {
      const chosen = sessions.filter((session) => selected.has(session.id));
      const { imported, failed } = await importSessions({ sessions: chosen, projectId });
      if (imported > 0) {
        toast.success(t`Imported ${imported} session(s).`);
        setSelected(new Set());
        setSessions(await readBridge().listImportableSessions(props.cwd ? { cwd: props.cwd } : {}));
      }
      if (failed > 0 && imported === 0) {
        toast.danger(t`No sessions could be imported.`);
      }
    } finally {
      setBusy(false);
    }
  }, [projectId, props.cwd, selected, sessions, t]);

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
          <Trans>Import into</Trans>
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
                  {session.agentKind} · {session.cwd ?? t`unknown folder`} ·{" "}
                  <Trans>{session.messageCount} messages</Trans>
                </p>
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
          isDisabled={selected.size === 0 || !projectId || busy}
          onPress={() => void runImport()}
        >
          <Trans>Import {selected.size} session(s)</Trans>
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx`
Expected: PASS (4 tests). If the import button's accessible name does not match the test's `/import 1 session/iu`, adjust the `aria-label` — not the test's intent.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
git add src/renderer/components/sessionImport
git commit -m "feat(import): add the session import panel"
```

---

### Task 8: Sidebar and settings entry points

**Files:**

- Modify: `src/renderer/views/MainView/parts/Sidebar/Sidebar.tsx:313-319` (add the import button next to "New thread")
- Create: `src/renderer/views/SettingsOverlay/parts/ImportSettings.tsx`
- Modify: `src/renderer/views/SettingsOverlay/parts/types.ts` (add `"import"` to `SettingsSection`)
- Modify: `src/renderer/views/SettingsOverlay/parts/SettingsSidebar.tsx:268-279` (add the sidebar entry to the same group as `usage`)
- Modify: `src/renderer/views/SettingsOverlay/SettingsOverlay.tsx:18,68` (import and map the section component)
- Test: `src/renderer/views/SettingsOverlay/parts/ImportSettings.test.tsx`

**Interfaces:**

- Consumes: `ImportSessionsPanel` (Task 7).
- Produces: `ImportSettings()` — the Settings → Import page; a sidebar button that opens the project-scoped dialog.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/views/SettingsOverlay/parts/ImportSettings.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";

vi.mock("@/renderer/components/sessionImport/ImportSessionsPanel", () => ({
  ImportSessionsPanel: (props: { cwd?: string; projectId?: string }) => (
    <div
      data-testid="import-panel"
      data-cwd={props.cwd ?? ""}
      data-project={props.projectId ?? ""}
    />
  ),
}));

import { ImportSettings } from "./ImportSettings";
import { SETTINGS_SECTION_COMPONENTS } from "../SettingsOverlay";

describe("ImportSettings", () => {
  it("renders the panel unscoped so every session is listed", () => {
    render(<ImportSettings />);
    const panel = screen.getByTestId("import-panel");
    expect(panel).toHaveAttribute("data-cwd", "");
    expect(panel).toHaveAttribute("data-project", "");
  });

  it("is registered as the import settings section", () => {
    expect(SETTINGS_SECTION_COMPONENTS.import).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/renderer/views/SettingsOverlay/parts/ImportSettings.test.tsx`
Expected: FAIL — `Failed to resolve import "./ImportSettings"`.

- [ ] **Step 3: Write the settings page**

Create `src/renderer/views/SettingsOverlay/parts/ImportSettings.tsx`:

```tsx
import { Trans } from "@lingui/react/macro";
import { ImportSessionsPanel } from "@/renderer/components/sessionImport/ImportSessionsPanel";

/**
 * Settings → Import. Unscoped: lists every discovered session across projects
 * and profiles, for a one-time move of an existing backlog into Poracode. The
 * project sidebar hosts the same panel scoped to one project's folder.
 */
export function ImportSettings() {
  return (
    <div className="flex flex-col gap-4 border-t border-border/10 pt-4">
      <div>
        <p className="text-sm font-medium text-foreground">
          <Trans>Import sessions</Trans>
        </p>
        <p className="text-xs text-muted">
          <Trans>
            Bring conversations you started in Codex CLI or Claude Code into Poracode. Transcript
            files are read, never modified.
          </Trans>
        </p>
      </div>
      <ImportSessionsPanel />
    </div>
  );
}
```

- [ ] **Step 4: Register the section**

In `src/renderer/views/SettingsOverlay/parts/types.ts`, add `"import"` to the union, after `"usage"`:

```ts
  | "import"
```

In `src/renderer/views/SettingsOverlay/SettingsOverlay.tsx`, add the import near the other section imports (line ~18):

```ts
import { ImportSettings } from "./parts/ImportSettings";
```

and the entry to the section component map (line ~68), directly after `usage`:

```ts
  import: () => <ImportSettings />,
```

Export the map so the test can assert the registration — if it is currently a
module-private `const`, rename the declaration to:

```ts
export const SETTINGS_SECTION_COMPONENTS = {/* … existing entries … */} as const;
```

and update its in-file references.

In `src/renderer/views/SettingsOverlay/parts/SettingsSidebar.tsx`, add the entry right after the `usage` entry in the same group:

```tsx
        {
          id: "import",
          icon: <Download className="size-4" />,
          label: t({
            message: "Import",
            comment: "Settings section: import existing CLI sessions as threads",
          }),
        },
```

and add `Download` to the existing `lucide-react` import in that file.

- [ ] **Step 5: Run the settings test to verify it passes**

Run: `pnpm exec vitest run src/renderer/views/SettingsOverlay/parts/ImportSettings.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Add the sidebar entry**

In `src/renderer/views/MainView/parts/Sidebar/Sidebar.tsx`, add local state next to the other sidebar state hooks:

```tsx
const [importOpen, setImportOpen] = useState(false);
```

Add the button immediately after the existing "New thread" `SidebarButton` (line ~319):

```tsx
<SidebarButton
  iconOnly
  icon={<Download className="size-3.5" />}
  label={t`Import session`}
  isActive={importOpen}
  onPress={() => setImportOpen(true)}
/>
```

Render the dialog at the end of the component's returned tree, before its
closing fragment:

```tsx
<ConfirmDialog
  isOpen={importOpen}
  title={t`Import session`}
  body={
    <ImportSessionsPanel
      {...(activeProject?.location.kind !== "wsl" && activeProject?.location.path
        ? { cwd: activeProject.location.path }
        : {})}
      {...(activeProject ? { projectId: activeProject.id } : {})}
    />
  }
  confirmLabel={t`Close`}
  onConfirm={() => setImportOpen(false)}
  onClose={() => setImportOpen(false)}
/>
```

Add the imports this needs at the top of the file:

```tsx
import { Download } from "lucide-react";
import { ConfirmDialog } from "@/renderer/components/common";
import { ImportSessionsPanel } from "@/renderer/components/sessionImport/ImportSessionsPanel";
```

`Download` joins the file's existing `lucide-react` import list rather than a
second import statement, and `activeProject` is the project the sidebar already
resolves for its thread list — reuse that variable rather than introducing
another selector.

- [ ] **Step 7: Verify the sidebar still renders**

Run: `pnpm exec vitest run src/renderer/views/MainView`
Expected: PASS — no new failures. If the sidebar has no existing test file, run `pnpm exec tsc --noEmit -p tsconfig.json` instead and confirm no output.

- [ ] **Step 8: Commit**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
git add src/renderer/views/SettingsOverlay src/renderer/views/MainView/parts/Sidebar/Sidebar.tsx
git commit -m "feat(import): add sidebar and settings entry points"
```

---

### Task 9: Imported-thread marker in the chat header

**Files:**

- Modify: `src/renderer/components/thread/ChatPane/ChatPane.tsx` (render the marker above the transcript)
- Test: `src/renderer/components/thread/ChatPane/importedThreadNotice.test.tsx`
- Create: `src/renderer/components/thread/ChatPane/parts/ImportedThreadNotice.tsx`

**Interfaces:**

- Consumes: `ThreadImportedFrom` (Task 1).
- Produces: `ImportedThreadNotice(props: { importedFrom: ThreadImportedFrom })`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/components/thread/ChatPane/importedThreadNotice.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { ImportedThreadNotice } from "./parts/ImportedThreadNotice";

describe("ImportedThreadNotice", () => {
  it("names the source provider and file", () => {
    render(
      <ImportedThreadNotice
        importedFrom={{
          provider: "codex",
          path: "F:\\home\\.codex\\sessions\\rollout-cx-1.jsonl",
          importedAt: "2026-09-20T06:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByText(/imported from codex cli/iu)).toBeInTheDocument();
    expect(screen.getByTitle("F:\\home\\.codex\\sessions\\rollout-cx-1.jsonl")).toBeInTheDocument();
  });

  it("names Claude Code for a Claude import", () => {
    render(
      <ImportedThreadNotice
        importedFrom={{
          provider: "claude",
          path: "/home/demo/.claude/projects/repo/sess.jsonl",
          importedAt: "2026-09-20T06:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByText(/imported from claude code/iu)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/renderer/components/thread/ChatPane/importedThreadNotice.test.tsx`
Expected: FAIL — `Failed to resolve import "./parts/ImportedThreadNotice"`.

- [ ] **Step 3: Write the notice**

Create `src/renderer/components/thread/ChatPane/parts/ImportedThreadNotice.tsx`:

```tsx
import { Trans } from "@lingui/react/macro";
import type { ThreadImportedFrom } from "@/shared/contracts";

/**
 * A one-line provenance marker above an imported transcript. The replayed rows
 * are text only, so the reader needs to know the original conversation had
 * tool calls the pane is not showing — and where the file lives.
 */
export function ImportedThreadNotice(props: { importedFrom: ThreadImportedFrom }) {
  return (
    <p className="px-3 py-2 text-[11px] text-muted">
      {props.importedFrom.provider === "codex" ? (
        <Trans>Imported from Codex CLI — text only, tool calls are not shown.</Trans>
      ) : (
        <Trans>Imported from Claude Code — text only, tool calls are not shown.</Trans>
      )}{" "}
      <span className="font-mono" title={props.importedFrom.path}>
        {props.importedFrom.path.split(/[\\/]/u).at(-1)}
      </span>
    </p>
  );
}
```

- [ ] **Step 4: Render it in the chat pane**

In `src/renderer/components/thread/ChatPane/ChatPane.tsx`, import the notice:

```tsx
import { ImportedThreadNotice } from "./parts/ImportedThreadNotice";
```

and render it immediately before the item list, reading the flag off the thread
the pane already has in scope:

```tsx
{
  thread?.config.importedFrom ? (
    <ImportedThreadNotice importedFrom={thread.config.importedFrom} />
  ) : null;
}
```

Use whatever local variable the file already holds for the current thread rather
than adding a new store selector.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run src/renderer/components/thread/ChatPane/importedThreadNotice.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
git add src/renderer/components/thread/ChatPane
git commit -m "feat(import): mark imported threads in the chat header"
```

---

### Task 10: Translations and full verification

**Files:**

- Modify: `src/renderer/locales/{de,es,fr,ja,ko,pl,pt-BR,ru,tr,uk,vi,zh-CN}/messages.po`
- Modify: `src/renderer/locales/en/messages.po`

**Interfaces:**

- Consumes: every user-visible string added in Tasks 7–9.
- Produces: catalogs with no empty `msgstr` for the new ids.

- [ ] **Step 1: Extract the new messages**

Run: `pnpm run i18n:extract`
Expected: the summary table lists a non-zero "Missing" count for the 12 non-English locales.

- [ ] **Step 2: List what needs translating**

Run:

```bash
python -c "
import re
s=open('src/renderer/locales/ru/messages.po',encoding='utf-8').read()
for block in s.split('\n\n'):
    if 'msgstr \"\"' in block and 'msgid \"\"' not in block:
        m=re.search(r'msgid \"(.*)\"',block)
        if m: print(m.group(1))
"
```

Expected: the import strings from Tasks 7–9 (panel copy, settings page copy, the
two "Imported from …" lines, toasts, aria-labels).

- [ ] **Step 3: Fill every locale**

For each of `de`, `es`, `fr`, `ja`, `ko`, `pl`, `pt-BR`, `ru`, `tr`, `uk`, `vi`,
`zh-CN`, translate each id listed in Step 2 and write it into that locale's
`messages.po`. Match the terminology the catalog already uses for neighbouring
strings (e.g. whatever it uses for "thread", "session", and "profile") rather
than inventing new words.

- [ ] **Step 4: Verify the catalogs are complete**

Run: `pnpm run i18n:extract`
Expected: the summary table shows `0` missing for every locale.

- [ ] **Step 5: Run the full affected test surface**

Run:

```bash
pnpm exec vitest run src/main/sessionImport src/shared/contracts src/renderer/components/sessionImport src/renderer/views/SettingsOverlay src/renderer/components/thread/ChatPane
```

Expected: PASS. Pre-existing failures unrelated to this feature (the
locale-dependent currency formatting in `src/renderer/components/providers/usageFormat.test.ts`)
are out of scope — do not "fix" them here.

- [ ] **Step 6: Lint and typecheck**

```bash
pnpm exec oxlint --deny-warnings src/main/sessionImport src/renderer/components/sessionImport
pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: no output from either.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/locales
git commit -m "i18n: translate session import strings"
```

- [ ] **Step 8: Manual verification in the dev app**

```bash
pnpm run dev:test
```

(If port 3100 is taken, prefix with `PORACODE_DEV_SERVER_PORT=3177`.)

Check, in order:

1. Settings → Import lists sessions from `~/.codex/sessions` and `~/.claude/projects`, including any profile homes.
2. Importing one creates a thread whose chat pane shows the past messages and the "Imported from …" line.
3. Sending a message in that thread continues the original conversation (the agent knows the earlier context).
4. Re-opening the import list shows that session as "Imported" and disabled.
5. The project sidebar's "Import session" dialog lists only sessions whose folder matches that project.

---

## Self-Review

**Spec coverage**

| Spec section                                                            | Task |
| ----------------------------------------------------------------------- | ---- |
| Shared contracts / `importedFrom`                                       | 1    |
| Codex parsing rules                                                     | 2    |
| Claude parsing rules, sidechain and meta filtering                      | 3    |
| Profile-aware home enumeration, cwd filter, dedupe, missing dirs        | 4    |
| Replay through canonical events, batching                               | 5    |
| Discovery + import IPC, duplicate detection                             | 6    |
| Import panel, multi-select, disabled imported rows, per-session failure | 7    |
| Sidebar dialog + Settings → Import                                      | 8    |
| "Imported from …" marker                                                | 9    |
| i18n, full verification, manual pass                                    | 10   |

Spec items deliberately reshaped during planning, both recorded here rather than
silently dropped:

- The spec put the scanner in the supervisor; the plan puts it in main. Main
  already owns SQLite (where the replay lands) and shared settings (where the
  profile homes live), so a supervisor hop would add a process boundary for no
  gain. Update the spec's "Discovery (supervisor)" heading when this lands.
- The spec had main create the thread; the plan has the renderer create it
  through the existing store action and main only replay into it. Main-created
  threads need extra mirroring (`noteMainCreatedThread`) to appear in the
  renderer's store; going through the store avoids that entirely.

**Placeholder scan:** none — every step carries the code or the exact command it
needs, including the i18n step, which enumerates what to translate rather than
saying "translate the strings".

**Type consistency:** `ImportableSession`, `ImportedTranscript`, `ImportHome`,
and `SessionImportDeps` keep the same field names across Tasks 1–7;
`parseCodexTranscript` / `parseClaudeTranscript` and `readCodexSessionHead` /
`readClaudeSessionHead` keep their names in Tasks 2–4 and 6; `importSessions`
(renderer action) and `importSessionTranscript` (IPC) are deliberately distinct
names for distinct things.
