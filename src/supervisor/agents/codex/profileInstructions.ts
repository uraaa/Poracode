import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureNativeStateLink } from "../plugin/installerBase";

/** Accounts isolate credentials, while an uncustomized profile inherits user preferences. */
export function inheritCodexProfileInstructions(
  profileHome: string,
  userHome = join(homedir(), ".codex"),
): void {
  const files = ["AGENTS.override.md", "AGENTS.md"];
  if (files.some((file) => existsSync(join(profileHome, file)))) return;
  const source = files.find((file) => existsSync(join(userHome, file)));
  if (source) ensureNativeStateLink(join(userHome, source), join(profileHome, source), "file");
}
