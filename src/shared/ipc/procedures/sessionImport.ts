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
