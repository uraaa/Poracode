// @vitest-environment jsdom
import { Readable } from "node:stream";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryServeBuiltMobileApp } from "./staticMobileApp";

// A previous desktop build's relative asset URLs must still load when its
// mobile.html is served at a trailing-slash or nested browser-history route.
const { releasedHtml } = vi.hoisted(() => ({
  releasedHtml:
    '<!doctype html><html><head><script type="module" src="./assets/mobile-old.js"></script>' +
    '<link rel="stylesheet" href="./assets/mobile-old.css">' +
    '<link rel="manifest" href="./manifest.webmanifest"></head><body></body></html>',
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const mock = {
    ...actual,
    existsSync: () => true,
    statSync: () => ({ isFile: () => true, size: releasedHtml.length }),
    createReadStream: () => Readable.from([releasedHtml]),
    readFile: (_path: string, _encoding: string, callback: (error: null, html: string) => void) =>
      callback(null, releasedHtml),
  };
  return { ...mock, default: mock };
});

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe("desktop-served mobile HTML", () => {
  it.each(["/app", "/app/", "/app/settings/appearance", "/pair"])(
    "loads the released bundle's resources from the origin at %s",
    async (route) => {
      server = createServer((req, res) => {
        if (!tryServeBuiltMobileApp(req.url ?? "/", res)) {
          res.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${origin}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const page = new DOMParser().parseFromString(await response.text(), "text/html");
      const base = new URL(page.querySelector("base")?.getAttribute("href") ?? route, origin);
      expect(new URL(page.querySelector("script")!.getAttribute("src")!, base).pathname).toBe(
        "/assets/mobile-old.js",
      );
      expect(new URL(page.querySelector("link")!.getAttribute("href")!, base).pathname).toBe(
        "/assets/mobile-old.css",
      );
      expect(
        new URL(page.querySelector('[rel="manifest"]')!.getAttribute("href")!, base).pathname,
      ).toBe("/manifest.webmanifest");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    },
  );
});
