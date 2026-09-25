import { describe, expect, it, vi } from "vitest";
import { agentStatusesResponseSchema, type Project } from "@/shared/contracts";
import { defaultSharedSettings } from "@/shared/settings";
import { createAppThread, type AppThreadLauncherDeps } from "./appThreadLauncher";

const project: Project = {
  id: "project-1",
  name: "Project",
  location: { kind: "windows", path: "C:/repo" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

function harness(overrides: Partial<AppThreadLauncherDeps> = {}) {
  const deps: AppThreadLauncherDeps = {
    startThread: vi.fn<AppThreadLauncherDeps["startThread"]>().mockResolvedValue(undefined),
    getAgentStatuses: vi
      .fn<AppThreadLauncherDeps["getAgentStatuses"]>()
      .mockResolvedValue(
        agentStatusesResponseSchema.parse({ windows: [], wsl: [], fromCache: true }),
      ),
    addWorktree: vi
      .fn<AppThreadLauncherDeps["addWorktree"]>()
      .mockResolvedValue({ path: "C:/worktree" }),
    removeWorktree: vi.fn<AppThreadLauncherDeps["removeWorktree"]>().mockResolvedValue(undefined),
    sendThreadCommand: vi.fn<AppThreadLauncherDeps["sendThreadCommand"]>().mockReturnValue(true),
    ensureHomeProject: () => project,
    getProject: () => project,
    getSharedSettings: vi.fn<AppThreadLauncherDeps["getSharedSettings"]>().mockReturnValue({
      ...defaultSharedSettings,
      enabledMcpServers: { browser: true, chrome: true, crossagents: true, "computer-use": true },
    }),
    upsertThread: vi.fn<AppThreadLauncherDeps["upsertThread"]>(),
    deleteThread: vi.fn<AppThreadLauncherDeps["deleteThread"]>(),
    threadExists: () => false,
    newId: () => "new-thread",
    ...overrides,
  };
  return deps;
}

describe("createAppThread MCP config", () => {
  it("persists, mirrors and launches the same enabled built-in defaults", async () => {
    const deps = harness();
    await createAppThread(deps, {
      projectId: project.id,
      prompt: "Research CRM contacts",
      agentKind: "test-agent",
      model: "test-model",
    });
    const config = {
      model: "test-model",
      browserMcp: true,
      chromeMcp: true,
      crossagentMcp: true,
      computerUse: true,
    };
    expect(deps.upsertThread).toHaveBeenCalledWith(
      expect.objectContaining({ config }),
      expect.any(Number),
    );
    expect(deps.sendThreadCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "start", config }),
    );
    expect(deps.startThread).toHaveBeenCalledWith(expect.objectContaining({ config }));
    expect(deps.getSharedSettings).toHaveBeenCalledTimes(1);
  });
});
