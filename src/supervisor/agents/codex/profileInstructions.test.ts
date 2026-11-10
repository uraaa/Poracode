import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inheritCodexProfileInstructions } from "./profileInstructions";
import { seedNativeCodexHome } from "./plugin/install";

const directories: string[] = [];
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "poracode-profile-instructions-"));
  directories.push(base);
  const source = join(base, "user");
  const profile = join(base, "profile");
  mkdirSync(source);
  mkdirSync(profile);
  return { source, profile };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Codex profile instructions", () => {
  it("inherits instructions from the configured global CODEX_HOME", () => {
    const { source, profile } = fixture();
    writeFileSync(join(source, "AGENTS.md"), "Rules from custom home");
    vi.stubEnv("CODEX_HOME", source);
    inheritCodexProfileInstructions(profile);
    expect(readFileSync(join(profile, "AGENTS.md"), "utf8")).toBe("Rules from custom home");
  });

  it("adds inherited rules to a previously installed private hook home", () => {
    const { source, profile } = fixture();
    const overlay = join(profile, "old-overlay");
    mkdirSync(overlay);
    writeFileSync(join(source, "AGENTS.md"), "Keep working after clarifications.");
    inheritCodexProfileInstructions(profile, source);
    // The previous plugin linked credentials and sessions, but no instruction files.
    expect(existsSync(join(overlay, "AGENTS.md"))).toBe(false);
    seedNativeCodexHome(overlay, profile);
    expect(readFileSync(join(overlay, "AGENTS.md"), "utf8")).toBe(
      "Keep working after clarifications.",
    );
  });
  it("upgrades an existing profile without instructions to the user's global rules", () => {
    const { source, profile } = fixture();
    writeFileSync(join(source, "AGENTS.md"), "Recommend a useful next step.");
    inheritCodexProfileInstructions(profile, source);
    expect(readFileSync(join(profile, "AGENTS.md"), "utf8")).toBe("Recommend a useful next step.");
    inheritCodexProfileInstructions(profile, source);
    expect(readFileSync(join(profile, "AGENTS.md"), "utf8")).toBe("Recommend a useful next step.");
  });
  it("preserves a profile's explicit instructions and does not supersede them with an override", () => {
    const { source, profile } = fixture();
    writeFileSync(join(source, "AGENTS.override.md"), "Global override");
    writeFileSync(join(profile, "AGENTS.md"), "Profile-specific rules");
    inheritCodexProfileInstructions(profile, source);
    expect(readFileSync(join(profile, "AGENTS.md"), "utf8")).toBe("Profile-specific rules");
    expect(existsSync(join(profile, "AGENTS.override.md"))).toBe(false);
  });
  it("uses the global override when no profile customization exists", () => {
    const { source, profile } = fixture();
    writeFileSync(join(source, "AGENTS.override.md"), "Override");
    inheritCodexProfileInstructions(profile, source);
    expect(readFileSync(join(profile, "AGENTS.override.md"), "utf8")).toBe("Override");
  });
});
