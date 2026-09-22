import { z } from "zod";

export const MAX_MESSAGE_SEARCH_RESULTS = 200;

export const searchThreadMessagesPayloadSchema = z.object({
  /** Raw user input; the main process decides what is too short to run. */
  query: z.string(),
  limit: z.number().int().min(1).max(MAX_MESSAGE_SEARCH_RESULTS).default(50),
});
export type SearchThreadMessagesPayload = z.infer<typeof searchThreadMessagesPayloadSchema>;

/**
 * Control characters, not markup: the renderer splits the snippet on them and
 * applies its own highlight, so nothing the user typed is interpreted as HTML.
 */
export const SNIPPET_MARK_START = "\u0001";
export const SNIPPET_MARK_END = "\u0002";

export interface ThreadMessageSearchHit {
  threadId: string;
  threadTitle: string;
  projectId: string;
  itemId: string;
  position: number;
  role: "user" | "assistant";
  /** Match wrapped in SNIPPET_MARK_START / SNIPPET_MARK_END. */
  snippet: string;
  updatedAt: string;
}
