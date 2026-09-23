import {
  searchThreadMessagesPayloadSchema,
  type SearchThreadMessagesPayload,
  type ThreadMessageSearchHit,
} from "../../contracts";
import { definePayloadProcedure } from "../core";

export const messageSearchProcedures = {
  searchThreadMessages: definePayloadProcedure<
    SearchThreadMessagesPayload,
    ThreadMessageSearchHit[],
    "main-local"
  >("searchThreadMessages", "main-local", searchThreadMessagesPayloadSchema),
} as const;
