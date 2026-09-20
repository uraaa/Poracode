import { z } from "zod";

/**
 * Importing an existing CLI conversation into a Poracode thread. Discovery
 * reads the provider's own transcript files (Codex rollouts, Claude Code
 * project logs) and never writes to them; the import replays their text into a
 * new thread whose `sessionRef` resumes the original provider session — so the
 * agent keeps the full history (tool calls, file contents) even though the
 * chat pane only replays the text.
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
  /**
   * Whether `cwd` still exists on disk. A session whose folder is gone cannot
   * auto-create a project, so the UI makes the user pick a target instead.
   */
  cwdExists: z.boolean(),
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
