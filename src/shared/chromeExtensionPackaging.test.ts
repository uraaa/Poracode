import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const packaging = createRequire(import.meta.url)("../../scripts/build-desktop-artifact.mjs") as {
  buildElectronBuilderConfig: () => string;
  stageChromeExtension: (stageRoot: string) => void;
};

describe("desktop Chrome extension packaging", () => {
  it("ships the actual loadable extension outside app.asar", () => {
    const config = parse(packaging.buildElectronBuilderConfig()) as {
      extraResources: Array<{ from: string; to: string }>;
    };
    const resource = config.extraResources.find((entry) => entry.to === "chrome-extension");
    expect(resource).toBeDefined();
    const stage = mkdtempSync(join(tmpdir(), "poracode-extension-package-"));
    try {
      packaging.stageChromeExtension(stage);
      const directory = resolve(stage, resource!.from);
      const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
      for (const file of [
        manifest.background.service_worker,
        manifest.action.default_popup,
        ...Object.values(manifest.icons),
      ]) {
        expect(existsSync(join(directory, file as string))).toBe(true);
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
