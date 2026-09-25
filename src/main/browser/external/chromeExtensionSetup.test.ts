import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareChromeExtension } from "./chromeExtensionSetup";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "poracode-chrome-setup-"));
  temporaryDirectories.push(root);
  const source = join(root, "resources", "chrome-extension");
  cpSync(resolve("chrome-extension"), source, { recursive: true });
  return { root, source, data: join(root, "data") };
}

describe("Chrome extension deployment", () => {
  it("prepares a loadable extension in a stable path for a pre-upgrade profile", () => {
    const { source, data } = fixture();
    const deployed = prepareChromeExtension(source, data);
    expect(deployed?.extensionPath).toBe(join(data, "chrome-extension"));
    const manifest = JSON.parse(
      readFileSync(join(deployed!.extensionPath, "manifest.json"), "utf8"),
    );
    expect(manifest.manifest_version).toBe(3);
    for (const asset of [
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...Object.values(manifest.icons),
    ]) {
      expect(existsSync(join(deployed!.extensionPath, asset as string))).toBe(true);
    }
  });

  it("updates stale deployed files in place without changing the path Chrome loaded", () => {
    const { source, data } = fixture();
    const before = prepareChromeExtension(source, data);
    expect(before).not.toBeNull();
    writeFileSync(join(before!.extensionPath, "background.js"), "old extension");
    const after = prepareChromeExtension(source, data);
    expect(after).toEqual(before);
    expect(readFileSync(join(after!.extensionPath, "background.js"), "utf8")).toBe(
      readFileSync(join(source, "background.js"), "utf8"),
    );
  });

  it("does not rewrite unchanged extension files on every app launch", () => {
    const { source, data } = fixture();
    const prepared = prepareChromeExtension(source, data);
    expect(prepared).not.toBeNull();
    const file = join(prepared!.extensionPath, "background.js");
    const before = statSync(file).mtimeMs;
    prepareChromeExtension(source, data);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("does not claim a missing or incomplete bundle can be installed", () => {
    const { source, data } = fixture();
    rmSync(join(source, "background.js"));
    expect(prepareChromeExtension(source, data)).toBeNull();
    expect(prepareChromeExtension(join(source, "missing"), data)).toBeNull();
    expect(existsSync(join(data, "chrome-extension"))).toBe(false);
  });
});
