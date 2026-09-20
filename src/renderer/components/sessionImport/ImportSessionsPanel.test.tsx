import { fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportableSession, Thread } from "@/shared/contracts";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";

const toastMock = vi.hoisted(() => ({
  danger: vi.fn<(message: string) => void>(),
  success: vi.fn<(message: string) => void>(),
}));

vi.mock("@heroui/react", () => ({
  Button: (props: {
    children?: ReactNode;
    "aria-label"?: string;
    isDisabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      type="button"
      aria-label={props["aria-label"]}
      disabled={props.isDisabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
  toast: toastMock,
}));

vi.mock("@/renderer/components/common", () => ({
  PixelLoader: () => <span data-testid="pixel-loader" />,
}));

const listImportableSessionsMock = vi.hoisted(() =>
  vi.fn<(payload: unknown) => Promise<ImportableSession[]>>(),
);
const importSessionTranscriptMock = vi.hoisted(() =>
  vi.fn<(payload: unknown) => Promise<{ messageCount: number }>>(),
);

vi.mock("@/renderer/bridge", () => ({
  readBridge: () => ({
    listImportableSessions: listImportableSessionsMock,
    importSessionTranscript: importSessionTranscriptMock,
  }),
}));

const createThreadMock = vi.hoisted(() => vi.fn<(input: unknown) => Thread>());
const updateThreadRuntimeMock = vi.hoisted(() => vi.fn<(id: string, input: unknown) => void>());
const addProjectWithResultMock = vi.hoisted(() =>
  vi.fn<
    (
      location: unknown,
      name?: string,
      workspaceId?: string,
    ) => { project: { id: string }; created: boolean }
  >(),
);
const storeState = {
  projects: [{ id: "p1", name: "repo", location: { kind: "windows", path: "F:\\repo" } }],
  createThread: createThreadMock,
  updateThreadRuntime: updateThreadRuntimeMock,
  addProjectWithResult: addProjectWithResultMock,
};

vi.mock("@/renderer/state/workspaceStore", () => ({
  getActiveWorkspaceId: () => "ws-active",
}));

vi.mock("@/renderer/state/appStore", () => {
  const useAppStore = ((selector: (state: typeof storeState) => unknown) =>
    selector(storeState)) as unknown as {
    (selector: (state: typeof storeState) => unknown): unknown;
    getState: () => typeof storeState;
  };
  useAppStore.getState = () => storeState;
  return { useAppStore };
});

import { ImportSessionsPanel } from "./ImportSessionsPanel";

function session(overrides: Partial<ImportableSession> = {}): ImportableSession {
  return {
    id: "codex:cx-1",
    provider: "codex",
    agentKind: "codex",
    providerSessionId: "cx-1",
    path: "F:\\home\\.codex\\sessions\\rollout-cx-1.jsonl",
    cwd: "F:\\repo",
    startedAt: "2026-09-20T04:43:18.000Z",
    updatedAt: "2026-09-20T05:00:00.000Z",
    preview: "fix the race condition",
    cwdExists: true,
    ...overrides,
  };
}

beforeEach(() => {
  listImportableSessionsMock.mockReset().mockResolvedValue([session()]);
  importSessionTranscriptMock.mockReset().mockResolvedValue({ messageCount: 4 });
  createThreadMock.mockReset().mockReturnValue({ id: "new-thread" } as Thread);
  updateThreadRuntimeMock.mockReset();
  addProjectWithResultMock
    .mockReset()
    .mockImplementation(() => ({ project: { id: "p-new" }, created: true }));
  toastMock.success.mockReset();
  toastMock.danger.mockReset();
});

describe("ImportSessionsPanel", () => {
  it("lists discovered sessions for the given cwd", async () => {
    render(<ImportSessionsPanel cwd={"F:\\repo"} projectId="p1" />);

    expect(await screen.findByText("fix the race condition")).toBeInTheDocument();
    expect(listImportableSessionsMock).toHaveBeenCalledWith({ cwd: "F:\\repo" });
  });

  it("disables a session that was already imported", async () => {
    listImportableSessionsMock.mockResolvedValue([session({ importedThreadId: "old" })]);
    render(<ImportSessionsPanel cwd={"F:\\repo"} projectId="p1" />);

    const checkbox = await screen.findByRole("checkbox", { name: /fix the race condition/iu });
    expect(checkbox).toBeDisabled();
  });

  it("creates a thread with the session ref and replays the transcript", async () => {
    render(<ImportSessionsPanel cwd={"F:\\repo"} projectId="p1" />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /fix the race condition/iu }));
    fireEvent.click(screen.getByRole("button", { name: /import 1 session/iu }));

    await vi.waitFor(() =>
      expect(createThreadMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentKind: "codex",
          title: "fix the race condition",
          config: expect.objectContaining({
            importedFrom: expect.objectContaining({
              provider: "codex",
              path: "F:\\home\\.codex\\sessions\\rollout-cx-1.jsonl",
            }),
          }),
        }),
      ),
    );
    expect(updateThreadRuntimeMock).toHaveBeenCalledWith(
      "new-thread",
      expect.objectContaining({
        sessionRef: expect.objectContaining({ providerSessionId: "cx-1" }),
      }),
    );
    expect(importSessionTranscriptMock).toHaveBeenCalledWith({
      threadId: "new-thread",
      provider: "codex",
      path: "F:\\home\\.codex\\sessions\\rollout-cx-1.jsonl",
    });
    await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalled());
  });

  it("creates a project for an unknown folder and files it into the active workspace", async () => {
    listImportableSessionsMock.mockResolvedValue([
      session({ cwd: "F:\\brand-new", cwdExists: true }),
    ]);
    render(<ImportSessionsPanel />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /fix the race condition/iu }));
    fireEvent.click(screen.getByRole("button", { name: /import 1 session/iu }));

    await vi.waitFor(() =>
      expect(addProjectWithResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: "F:\\brand-new" }),
        undefined,
        "ws-active",
      ),
    );
    expect(createThreadMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p-new" }));
  });

  it("reuses the existing project when the folder is already one", async () => {
    addProjectWithResultMock.mockReturnValue({ project: { id: "p1" }, created: false });
    listImportableSessionsMock.mockResolvedValue([session({ cwdExists: true })]);
    render(<ImportSessionsPanel />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /fix the race condition/iu }));
    fireEvent.click(screen.getByRole("button", { name: /import 1 session/iu }));

    await vi.waitFor(() =>
      expect(createThreadMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1" })),
    );
  });

  it("falls back to the chosen project when the folder is gone", async () => {
    listImportableSessionsMock.mockResolvedValue([
      session({ cwd: "F:\\deleted", cwdExists: false }),
    ]);
    render(<ImportSessionsPanel projectId="p1" />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /fix the race condition/iu }));
    fireEvent.click(screen.getByRole("button", { name: /import 1 session/iu }));

    await vi.waitFor(() =>
      expect(createThreadMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1" })),
    );
    expect(addProjectWithResultMock).not.toHaveBeenCalled();
  });

  it("reports a failed import without blocking the rest", async () => {
    listImportableSessionsMock.mockResolvedValue([
      session(),
      session({
        id: "codex:cx-2",
        providerSessionId: "cx-2",
        preview: "second",
        path: "F:\\b.jsonl",
      }),
    ]);
    importSessionTranscriptMock
      .mockRejectedValueOnce(new Error("unreadable"))
      .mockResolvedValueOnce({ messageCount: 2 });

    render(<ImportSessionsPanel cwd={"F:\\repo"} projectId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /select all/iu }));
    fireEvent.click(screen.getByRole("button", { name: /import 2 sessions/iu }));

    await vi.waitFor(() => expect(toastMock.danger).toHaveBeenCalled());
    expect(importSessionTranscriptMock).toHaveBeenCalledTimes(2);
  });
});
