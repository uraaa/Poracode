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

function claudeHome(
  sessions: Array<{ id: string; cwd: string; prompt: string; owner?: string }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "poracode-scan-claude-"));
  for (const session of sessions) {
    const projectDir = join(dir, "projects", session.cwd.replace(/[:\\/]/gu, "-"));
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      ...(session.owner
        ? [
            JSON.stringify({
              type: "bridge-session",
              sessionId: session.id,
              ownerAccountUuid: session.owner,
            }),
          ]
        : []),
      JSON.stringify({
        type: "user",
        sessionId: session.id,
        cwd: session.cwd,
        timestamp: "2026-09-20T05:00:00.000Z",
        message: { role: "user", content: session.prompt },
      }),
    ];
    writeFileSync(join(projectDir, `${session.id}.jsonl`), lines.join("\n"), "utf8");
  }
  return dir;
}

/** A rollout whose `session_meta` carries exactly the fields a test needs. */
function writeRollout(
  sessionsDir: string,
  id: string,
  meta: Record<string, unknown>,
  userText: string,
): void {
  writeFileSync(
    join(sessionsDir, `rollout-${id}.jsonl`),
    [
      JSON.stringify({
        type: "session_meta",
        payload: { session_id: id, cwd: "F:\\repo", ...meta },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText }],
        },
      }),
    ].join("\n"),
    "utf8",
  );
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
    const { sessions } = scanImportableSessions({ homes });
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.provider === "codex")).toMatchObject({
      id: "codex:cx-1",
      agentKind: "codex:work",
      providerSessionId: "cx-1",
      cwd: "F:\\repo",
      preview: "fix the bug",
      // The fixture records a cwd that does not exist on this machine.
      cwdExists: false,
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
    const { sessions: matching } = scanImportableSessions({ homes, cwd: "f:\\REPO" });
    expect(matching).toHaveLength(2);
    expect(matching.map((s) => s.providerSessionId).sort()).toEqual(["cl-here", "cx-here"]);
    expect(
      scanImportableSessions({ homes, provider: "codex" }).sessions.every(
        (s) => s.provider === "codex",
      ),
    ).toBe(true);
  });

  it("lists a Claude session under the profile whose login owns it", () => {
    const base = claudeHome([
      { id: "cl-work", cwd: "F:\\repo", prompt: "work chat", owner: "acct-work" },
      { id: "cl-mine", cwd: "F:\\repo", prompt: "my chat", owner: "acct-base" },
      { id: "cl-other", cwd: "F:\\repo", prompt: "unknown owner", owner: "acct-nobody" },
    ]);
    const { sessions } = scanImportableSessions({
      homes: [
        { provider: "claude", agentKind: "claude", dir: base, accountId: "acct-base" },
        {
          provider: "claude",
          agentKind: "claude:work",
          dir: claudeHome([]),
          accountId: "acct-work",
        },
        // A second profile on the base login must not steal the base home's own sessions.
        {
          provider: "claude",
          agentKind: "claude:mine",
          dir: claudeHome([]),
          accountId: "acct-base",
        },
      ],
    });
    const kinds = Object.fromEntries(sessions.map((s) => [s.providerSessionId, s.agentKind]));
    expect(kinds).toEqual({ "cl-work": "claude:work", "cl-mine": "claude", "cl-other": "claude" });
    // The file stays where it is; the import copies it into the profile's home.
    expect(sessions.find((s) => s.providerSessionId === "cl-work")?.path).toContain(base);
  });

  it("dedupes a session visible in two homes and skips missing directories", () => {
    const shared = codexHome([{ id: "cx-dup", cwd: "F:\\repo", prompt: "dup" }]);
    const homes: ImportHome[] = [
      { provider: "codex", agentKind: "codex", dir: shared },
      { provider: "codex", agentKind: "codex:work", dir: shared },
      { provider: "codex", agentKind: "codex:gone", dir: join(tmpdir(), "poracode-not-there") },
    ];
    expect(scanImportableSessions({ homes }).sessions).toHaveLength(1);
  });

  it("returns an empty list rather than throwing on an unreadable transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-scan-bad-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // Content that isn't even JSON: no field regex can match anything in it,
    // so — unlike a session whose preview alone is out of reach (see the
    // "beyond the preview window" case above) — nothing was ever read out of
    // this file's head. The filename alone ("rollout-broken.jsonl") must not
    // be enough to manufacture a session out of that.
    writeFileSync(join(sessionsDir, "rollout-broken.jsonl"), "{ not json", "utf8");
    expect(
      scanImportableSessions({ homes: [{ provider: "codex", agentKind: "codex", dir }] }).sessions,
    ).toEqual([]);
  });

  it("returns an empty list for a file that is empty on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-scan-empty-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // Empty on disk (e.g. a crash mid-write): `readPrefix` returns "" and
    // `readHead` bails before any field regex even runs.
    writeFileSync(join(sessionsDir, "rollout-empty.jsonl"), "", "utf8");
    expect(
      scanImportableSessions({ homes: [{ provider: "codex", agentKind: "codex", dir }] }).sessions,
    ).toEqual([]);
  });

  it("hides sub-agent fan-outs and one-shot exec runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-scan-machine-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeRollout(sessionsDir, "sub", { thread_source: "subagent" }, "spawned work");
    writeRollout(sessionsDir, "exec", { originator: "codex_exec", source: "exec" }, "title this");
    writeRollout(
      sessionsDir,
      "real",
      { originator: "Codex Desktop", source: "vscode", thread_source: "user" },
      "real words",
    );

    const { sessions } = scanImportableSessions({
      homes: [{ provider: "codex", agentKind: "codex", dir }],
    });
    expect(sessions.map((session) => session.providerSessionId)).toEqual(["real"]);
  });

  it("strips injected context out of the preview", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-scan-injected-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeRollout(
      sessionsDir,
      "inj",
      {},
      "# AGENTS.md instructions\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>\n\nship it",
    );

    const [session] = scanImportableSessions({
      homes: [{ provider: "codex", agentKind: "codex", dir }],
    }).sessions;
    expect(session?.preview).toBe("ship it");
  });

  it("marks a session whose folder still exists", () => {
    const realFolder = mkdtempSync(join(tmpdir(), "poracode-scan-cwd-"));
    const homes: ImportHome[] = [
      {
        provider: "codex",
        agentKind: "codex",
        dir: codexHome([{ id: "cx-real", cwd: realFolder, prompt: "real folder" }]),
      },
    ];
    expect(scanImportableSessions({ homes }).sessions[0]?.cwdExists).toBe(true);
  });

  it("reports every folder it saw, including folders past the page limit", () => {
    const homes: ImportHome[] = [
      {
        provider: "codex",
        agentKind: "codex",
        dir: codexHome([
          { id: "cx-1", cwd: "F:\\busy", prompt: "one" },
          { id: "cx-2", cwd: "F:\\busy", prompt: "two" },
          { id: "cx-3", cwd: "F:\\busy", prompt: "three" },
          { id: "cx-4", cwd: "F:\\quiet", prompt: "four" },
        ]),
      },
    ];

    const result = scanImportableSessions({ homes, limit: 2 });

    expect(result.sessions).toHaveLength(2);
    expect(result.facets.folders).toEqual(expect.arrayContaining(["F:\\busy", "F:\\quiet"]));
  });

  it("reports truncated when the page fills before the candidates run out", () => {
    const homes: ImportHome[] = [
      {
        provider: "codex",
        agentKind: "codex",
        dir: codexHome([
          { id: "cx-1", cwd: "F:\\repo", prompt: "one" },
          { id: "cx-2", cwd: "F:\\repo", prompt: "two" },
          { id: "cx-3", cwd: "F:\\repo", prompt: "three" },
          { id: "cx-4", cwd: "F:\\repo", prompt: "four" },
        ]),
      },
    ];

    expect(scanImportableSessions({ homes, limit: 2 }).truncated).toBe(true);
  });

  it("reports not truncated when every matching session fit on the page", () => {
    const homes: ImportHome[] = [
      {
        provider: "codex",
        agentKind: "codex",
        dir: codexHome([
          { id: "cx-1", cwd: "F:\\repo", prompt: "one" },
          { id: "cx-2", cwd: "F:\\repo", prompt: "two" },
        ]),
      },
    ];

    expect(scanImportableSessions({ homes, limit: 2 }).truncated).toBe(false);
  });

  it("lists a session whose first user text is beyond the preview window", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-scan-nopreview-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "rollout-cx-quiet.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            session_id: "cx-quiet",
            cwd: "F:\\repo",
            timestamp: "2026-09-20T04:43:18.000Z",
          },
        }),
        // A turn of pure injected context: stripping leaves nothing.
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<recommended_plugins>catalogue</recommended_plugins>" },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { sessions } = scanImportableSessions({
      homes: [{ provider: "codex", agentKind: "codex", dir }],
    });

    expect(sessions.map((s) => s.providerSessionId)).toEqual(["cx-quiet"]);
    expect(sessions[0]?.preview).toBe("");
  });

  it("checks a folder once however many sessions share it", () => {
    const calls: string[] = [];
    const homes: ImportHome[] = [
      {
        provider: "codex",
        agentKind: "codex",
        dir: codexHome([
          { id: "cx-1", cwd: "F:\\repo", prompt: "one" },
          { id: "cx-2", cwd: "F:\\repo", prompt: "two" },
          { id: "cx-3", cwd: "F:\\other", prompt: "three" },
        ]),
      },
    ];

    scanImportableSessions({
      homes,
      exists: (path) => {
        calls.push(path);
        return true;
      },
    });

    expect(calls.toSorted()).toEqual(["F:\\other", "F:\\repo"]);
  });

  // Companion assertion, not the regression guard: this fixture passes even
  // without the Task 4 fix, because `JSON.stringify` escapes the quotes
  // inside `content[].text`, so a pasted `"cwd"` can never appear unescaped
  // in the file and a plain regex can't match it either way. It's kept as a
  // pinned, brief-specified case. The test below ("claude: a non-conversation
  // record's cwd must not win by appearing first") is the one that actually
  // fails before the fix and passes after — that's the real regression guard
  // for this task.
  it("ignores a cwd pasted inside a user message", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-scan-paste-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "rollout-cx-paste.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            session_id: "cx-paste",
            cwd: "F:\\real",
            timestamp: "2026-09-20T04:43:18.000Z",
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: '{"cwd":"F:\\\\pasted"}' }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { sessions } = scanImportableSessions({
      homes: [{ provider: "codex", agentKind: "codex", dir }],
    });

    expect(sessions[0]?.cwd).toBe("F:\\real");
  });

  // The Codex fixture above can only pass "by luck" of session_meta being
  // first in the file: any regex over the concatenated head text will hit
  // session_meta's own (unescaped, top-level) cwd before anything nested
  // inside a later message's escaped string content. Claude's format makes
  // the same bug directly reachable, because every record — not just the
  // conversational ones — carries cwd as a plain top-level field: a
  // `file-history-snapshot` (or any record type outside the allowed set)
  // that happens to come first must not be allowed to win over the real
  // `user` record's cwd purely because it appears earlier in the file.
  it("claude: a non-conversation record's cwd must not win by appearing first", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-scan-claude-paste-"));
    const projectDir = join(dir, "projects", "F--real");
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "file-history-snapshot",
        sessionId: "cl-paste",
        cwd: "F:\\pasted",
        timestamp: "2026-09-20T04:00:00.000Z",
      }),
      JSON.stringify({
        type: "user",
        sessionId: "cl-paste",
        cwd: "F:\\real",
        timestamp: "2026-09-20T05:00:00.000Z",
        message: { role: "user", content: "hello" },
      }),
    ];
    writeFileSync(join(projectDir, "cl-paste.jsonl"), lines.join("\n"), "utf8");

    const { sessions } = scanImportableSessions({
      homes: [{ provider: "claude", agentKind: "claude", dir }],
    });

    expect(sessions[0]?.cwd).toBe("F:\\real");
  });

  it("compares folders case-insensitively on win32 and case-sensitively elsewhere", () => {
    const homes: ImportHome[] = [
      {
        provider: "codex",
        agentKind: "codex",
        dir: codexHome([
          { id: "cx-upper", cwd: "/home/u/Repo", prompt: "upper" },
          { id: "cx-lower", cwd: "/home/u/repo", prompt: "lower" },
        ]),
      },
    ];

    const onWindows = scanImportableSessions({ homes, cwd: "/home/u/repo", platform: "win32" });
    expect(onWindows.sessions.map((s) => s.providerSessionId).sort()).toEqual([
      "cx-lower",
      "cx-upper",
    ]);

    const onLinux = scanImportableSessions({ homes, cwd: "/home/u/repo", platform: "linux" });
    expect(onLinux.sessions.map((s) => s.providerSessionId)).toEqual(["cx-lower"]);
  });

  it("degrades to undefined, not a partial match, when a field is cut off mid-value", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-scan-cut-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // session_id is complete and unescaped before the cut; cwd's value never
    // reaches a closing quote — simulating a head chunk that sliced through
    // session_meta mid-field. rawField requires a closing quote, so cwd must
    // come back undefined rather than matching a prefix of the file path.
    writeFileSync(
      join(sessionsDir, "rollout-cx-cut.jsonl"),
      '{"type":"session_meta","payload":{"session_id":"cx-cut","cwd":"F:\\\\re',
      "utf8",
    );

    const { sessions } = scanImportableSessions({
      homes: [{ provider: "codex", agentKind: "codex", dir }],
    });

    expect(sessions.map((s) => s.providerSessionId)).toEqual(["cx-cut"]);
    expect(sessions[0]?.cwd).toBeUndefined();
  });
});
