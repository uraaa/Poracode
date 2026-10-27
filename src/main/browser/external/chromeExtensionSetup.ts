import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export interface PreparedChromeExtension {
  extensionPath: string;
  extensionVersion: string;
}

const manifestSchema = z.object({
  manifest_version: z.literal(3),
  version: z.string().min(1),
  background: z.object({ service_worker: z.string().min(1) }),
  action: z.object({ default_popup: z.string().min(1) }),
  icons: z.record(z.string(), z.string()),
});

/** Deploy the bundled extension to a stable, user-readable Load unpacked directory.
 * Existing profiles need no migration: a missing directory is populated, and changed
 * bundled files replace stale copies at the same path Chrome already registered. */
export function prepareChromeExtension(
  sourceDirectory: string,
  dataDirectory: string,
): PreparedChromeExtension | null {
  const files = new Map<string, Buffer>();
  let extensionVersion: string;
  try {
    const collect = (relative: string) => {
      for (const entry of readdirSync(join(sourceDirectory, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) collect(name);
        else if (entry.isFile()) files.set(name, readFileSync(join(sourceDirectory, name)));
      }
    };
    collect("");
    const manifest = manifestSchema.parse(
      JSON.parse(files.get("manifest.json")?.toString("utf8") ?? "null"),
    );
    const required = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      "popup.js",
      ...Object.values(manifest.icons),
    ];
    if (required.some((name) => !files.has(name))) return null;
    extensionVersion = manifest.version;
  } catch {
    return null;
  }
  const extensionPath = join(dataDirectory, "chrome-extension");
  for (const [relative, contents] of files) {
    const target = join(extensionPath, relative);
    if (existsSync(target) && readFileSync(target).equals(contents)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return { extensionPath, extensionVersion };
}
