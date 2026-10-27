import type { ProjectLocation } from "@/shared/contracts";

// Private, co-bundled worker protocol. No independently deployed or persisted
// copy exists; both endpoints must come from the same supervisor build.
export const REPOSITORY_COMMAND_PROTOCOL_VERSION = 2;

export interface RepositoryCommandOptions {
  cwd?: string;
  /** Overrides merged into the worker's ambient environment. */
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  windowsHide?: boolean;
}

export interface RepositoryCommand {
  command: string;
  args: string[];
  options: RepositoryCommandOptions;
  input?: string;
  /** Build platform argv and resolve executables on the worker, never the caller. */
  preparation?: {
    location: Exclude<ProjectLocation, { kind: "wsl" }>;
    shellEnv?: Record<string, string>;
    /** POSIX machine-readable commands bypass login-shell output. */
    direct?: boolean;
    /** Remove ambient overrides before applying explicit options.env. */
    omitEnv?: string[];
  };
}

export interface RepositoryCommandResult {
  stdout: string;
  stderr: string;
}

export interface RepositoryCommandError {
  message: string;
  name: string;
  stack?: string;
  code?: string | number;
  signal?: string | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

export type RepositoryWorkerRequest =
  | {
      version: typeof REPOSITORY_COMMAND_PROTOCOL_VERSION;
      id: number;
      command: RepositoryCommand;
      /** Included at boot and after an explicit executable/environment refresh. */
      ambientEnv?: NodeJS.ProcessEnv;
      cacheGeneration: number;
    }
  | { version: typeof REPOSITORY_COMMAND_PROTOCOL_VERSION; shutdown: true; drain: boolean };

export type RepositoryWorkerReply =
  | {
      id: number;
      result: RepositoryCommandResult;
    }
  | { id: number; error: RepositoryCommandError };
