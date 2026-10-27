import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeExtensionStatus } from "@/shared/ipc";
import { createLocalIpcHandlers } from "./localHandlers";

const { openPath } = vi.hoisted(() => ({ openPath: vi.fn<(path: string) => Promise<string>>() }));
vi.mock("electron", () => ({ shell: { openPath } }));

function handlers(status: ChromeExtensionStatus) {
  return createLocalIpcHandlers({ getChromeExtensionStatus: () => status } as unknown as Parameters<
    typeof createLocalIpcHandlers
  >[0]);
}

describe("Chrome extension setup IPC", () => {
  beforeEach(() => {
    openPath.mockReset().mockResolvedValue("");
  });

  it("reports live connection state independently of available install files", () => {
    const status = {
      connected: false,
      extensionPath: "C:\\user\\chrome-extension",
      extensionVersion: "0.1.0",
    };
    const ipc = handlers(status);
    expect(ipc.browserGetChromeExtensionStatus({})).toEqual(status);
    status.connected = true;
    expect(ipc.browserGetChromeExtensionStatus({})).toMatchObject({ connected: true });
  });

  it("opens only the main process's prepared folder", async () => {
    const status = {
      connected: false,
      extensionPath: "C:\\user\\chrome-extension",
      extensionVersion: "0.1.0",
    };
    await handlers(status).browserOpenChromeExtensionFolder({});
    expect(openPath).toHaveBeenCalledWith(status.extensionPath);
  });

  it("does not report success if files are missing or the shell rejects the folder", async () => {
    await expect(
      handlers({
        connected: false,
        extensionPath: null,
        extensionVersion: null,
      }).browserOpenChromeExtensionFolder({}),
    ).rejects.toThrow(/unavailable/);
    expect(openPath).not.toHaveBeenCalled();
    openPath.mockResolvedValue("Access denied");
    await expect(
      handlers({
        connected: false,
        extensionPath: "folder",
        extensionVersion: "0.1.0",
      }).browserOpenChromeExtensionFolder({}),
    ).rejects.toThrow(/Unable to open/);
  });
});
