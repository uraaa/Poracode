import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";

const bridge = vi.hoisted(() => ({
  remote: false,
  browserGetChromeExtensionStatus: vi.fn<
    () => Promise<{
      connected: boolean;
      extensionPath: string | null;
      extensionVersion: string | null;
    }>
  >(),
  browserOpenChromeExtensionFolder: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/renderer/bridge", () => ({
  isRemoteSession: () => bridge.remote,
  readBridge: () => bridge,
}));

import { ChromeExtensionSettings } from "./ChromeExtensionSettings";

const extensionPath = "C:\\Users\\Alice\\.poracode\\chrome-extension";

describe("ChromeExtensionSettings", () => {
  beforeEach(() => {
    bridge.remote = false;
    bridge.browserGetChromeExtensionStatus.mockReset().mockResolvedValue({
      connected: false,
      extensionPath,
      extensionVersion: "1.0.0",
    });
    bridge.browserOpenChromeExtensionFolder.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it("shows the managed folder and three setup steps in the desired signed-in profile", async () => {
    render(<ChromeExtensionSettings />);

    expect(await screen.findByText(extensionPath)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Not connected");
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent("chrome://extensions");
    expect(steps[0]).toHaveTextContent("signed-in Chrome profile");
    expect(steps[1]).toHaveTextContent("Developer mode");
    expect(steps[2]).toHaveTextContent("Load unpacked");
    expect(steps[2]).toHaveTextContent("folder shown below");
  });

  it("shows the connected state", async () => {
    bridge.browserGetChromeExtensionStatus.mockResolvedValue({
      connected: true,
      extensionPath,
      extensionVersion: "1.0.0",
    });
    render(<ChromeExtensionSettings />);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/^Connected$/));
  });

  it("opens the prepared extension folder", async () => {
    render(<ChromeExtensionSettings />);
    await screen.findByText(extensionPath);
    fireEvent.click(screen.getByRole("button", { name: "Open extension folder" }));

    await waitFor(() => expect(bridge.browserOpenChromeExtensionFolder).toHaveBeenCalledOnce());
  });

  it("disables the folder action when extension files are unavailable", async () => {
    bridge.browserGetChromeExtensionStatus.mockResolvedValue({
      connected: false,
      extensionPath: null,
      extensionVersion: null,
    });
    render(<ChromeExtensionSettings />);

    expect(await screen.findByText(/Chrome extension files are unavailable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Open extension folder" })).toBeDisabled();
  });

  it("reports a status failure without claiming the extension is disconnected", async () => {
    bridge.browserGetChromeExtensionStatus.mockRejectedValue(new Error("IPC unavailable"));
    render(<ChromeExtensionSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to check Chrome extension status.",
    );
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open extension folder" })).toBeDisabled();
  });

  it("reports a folder action failure", async () => {
    bridge.browserOpenChromeExtensionFolder.mockRejectedValue(new Error("Explorer unavailable"));
    render(<ChromeExtensionSettings />);
    await screen.findByText(extensionPath);
    fireEvent.click(screen.getByRole("button", { name: "Open extension folder" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to open the Chrome extension folder.",
    );
  });

  it("refreshes the connection while mounted and stops on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<ChromeExtensionSettings />);
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent("Not connected");
    bridge.browserGetChromeExtensionStatus.mockResolvedValue({
      connected: true,
      extensionPath,
      extensionVersion: "1.0.0",
    });

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByRole("status")).toHaveTextContent(/^Connected$/);
    unmount();
    bridge.browserGetChromeExtensionStatus.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(bridge.browserGetChromeExtensionStatus).not.toHaveBeenCalled();
  });

  it("hides setup and does not call the host bridge in remote or mobile sessions", () => {
    bridge.remote = true;
    const { container } = render(<ChromeExtensionSettings />);

    expect(container).toBeEmptyDOMElement();
    expect(bridge.browserGetChromeExtensionStatus).not.toHaveBeenCalled();
  });
});
