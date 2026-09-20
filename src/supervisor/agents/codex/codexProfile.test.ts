import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectLocation } from "@/shared/contracts";

// These tests only exercise env plumbing. Skip the real `~/.codex/sessions`
// walk and the `codex --version` probe, both of which flake under parallel
// load (a large session store, an 8s exec timeout) and prove nothing here.
vi.mock("./plugin/install", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin/install")>();
  return {
    ...actual,
    isCodexSemverSupportedForGoals: () => true,
    probeCodexCliSemver: () => [999, 0, 0] as [number, number, number],
    codexHooksFeatureFlagForSemver: () => "hooks",
  };
});
vi.mock("./sessionFiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sessionFiles")>();
  return { ...actual, readCodexSessionIndex: () => [] };
});

import { createCodexAdapter, createCodexProfileAdapter } from "./index";
import { codexTerminalAuthMethod } from "./detection";
import { codexAppServerPoolKey } from "./serverPool";
import { buildCodexAppServerCommand } from "./argv";
import {
  readCodexRolloutsForLocation,
  readCodexSessionIndexForLocation,
  resolveCodexSessionWatchPaths,
} from "./session";

const projectLocation: ProjectLocation = { kind: "posix", path: "/repo" };

function workProfile() {
  return createCodexProfileAdapter({
    id: "work",
    driver: "codex",
    displayName: "Work",
    config: { homeDir: "~/.codex-work" },
  });
}

describe("createCodexProfileAdapter", () => {
  const expectedHome = path.join(homedir(), ".codex-work");

  it("creates a distinct Codex adapter backed by a separate CODEX_HOME", () => {
    const adapter = workProfile();
    expect(adapter.kind).toBe("codex:work");
    expect(adapter.label).toBe("Codex Work");
    expect(adapter.binary).toBe("codex");

    expect(
      adapter.buildLaunchArgv(projectLocation, { model: "gpt-5.5" }, "hello").env?.CODEX_HOME,
    ).toBe(expectedHome);
    expect(
      adapter.buildResumeArgv?.(projectLocation, { model: "gpt-5.5" }, "hello", {
        providerSessionId: "thread-1",
        discoveredAt: "test",
      })?.env?.CODEX_HOME,
    ).toBe(expectedHome);
    expect(
      adapter.buildOneShotCommand?.("gpt-5.5", undefined, "Summarize", projectLocation)?.env
        ?.CODEX_HOME,
    ).toBe(expectedHome);
  });

  it("logs out of the profile's CODEX_HOME, not the global one", async () => {
    const adapter = workProfile();
    const command = await adapter.buildAcpLogoutCommand?.({ envKind: "posix" });
    expect(command?.env?.CODEX_HOME).toBe(expectedHome);
    // On Windows the shared launch builder wraps the call in an encoded
    // PowerShell command, so decode before looking for the subcommand.
    const args = command?.args ?? [];
    const rendered = args.includes("-EncodedCommand")
      ? Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le")
      : [command?.command ?? "", ...args].join(" ");
    expect(rendered).toMatch(/logout/);
  });

  it("leaves the base Codex adapter without a CODEX_HOME override", () => {
    const adapter = createCodexAdapter();
    expect(adapter.kind).toBe("codex");
    // `buildResumeArgv` shapes the same argv as launch without the pre-spawn
    // snapshot of the real `~/.codex/sessions` tree.
    expect(
      adapter.buildResumeArgv?.(projectLocation, { model: "gpt-5.5" }, "hello", {
        providerSessionId: "thread-1",
        discoveredAt: "test",
      })?.env?.CODEX_HOME,
    ).toBeUndefined();
    expect(
      adapter.buildOneShotCommand?.("gpt-5.5", undefined, "Summarize", projectLocation)?.env
        ?.CODEX_HOME,
    ).toBeUndefined();
  });

  it("stages the hook plugin under a per-profile CODEX_HOME overlay", async () => {
    const adapter = workProfile();
    const extras = await adapter.pluginLaunchExtras?.({ envKind: "posix", baseDir: "/tmp/pc" });
    expect(extras?.env?.CODEX_HOME).toBe(
      path.join("/tmp/pc", "agent-plugins", "codex", "profiles", "work", "home"),
    );
  });

  it("does not offer hook plugins for WSL profiles", async () => {
    const adapter = workProfile();
    await expect(
      adapter.isPluginSupported?.({ envKind: "wsl", wslDistro: "Ubuntu" }),
    ).resolves.toBe(false);
  });
});

describe("codexTerminalAuthMethod", () => {
  it("carries the profile env so the login overlay targets the profile home", () => {
    expect(codexTerminalAuthMethod({ CODEX_HOME: "/home/demo/.codex-work" })).toMatchObject({
      type: "terminal",
      args: ["login"],
      env: { CODEX_HOME: "/home/demo/.codex-work" },
    });
    expect(codexTerminalAuthMethod(undefined)).not.toHaveProperty("env");
  });
});

describe("Codex app-server env plumbing", () => {
  it("forwards a CODEX_HOME override into the app-server spawn env", () => {
    const command = buildCodexAppServerCommand(projectLocation, {
      env: { CODEX_HOME: "/home/demo/.codex-work" },
    });
    expect(command.env?.CODEX_HOME).toBe("/home/demo/.codex-work");
  });

  it("emits env overrides through /usr/bin/env for WSL app-servers", () => {
    const wsl: ProjectLocation = {
      kind: "wsl",
      distro: "Ubuntu",
      linuxPath: "/home/demo/repo",
      uncPath: "\\wsl.localhostUbuntuhomedemo\repo",
    };
    const command = buildCodexAppServerCommand(wsl, {
      env: { CODEX_HOME: "/home/demo/.codex-work" },
    });
    expect(command.args).toContain("CODEX_HOME=/home/demo/.codex-work");
  });

  it("keys the shared app-server pool by env so profiles never share a server", () => {
    const base = codexAppServerPoolKey(projectLocation, []);
    const work = codexAppServerPoolKey(projectLocation, [], undefined, undefined, {
      CODEX_HOME: "/home/demo/.codex-work",
    });
    const personal = codexAppServerPoolKey(projectLocation, [], undefined, undefined, {
      CODEX_HOME: "/home/demo/.codex-personal",
    });
    expect(work).not.toBe(base);
    expect(work).not.toBe(personal);
    expect(
      codexAppServerPoolKey(projectLocation, [], undefined, undefined, {
        CODEX_HOME: "/home/demo/.codex-work",
      }),
    ).toBe(work);
  });
});

describe("Codex session discovery with a profile home", () => {
  it("scans only the profile's homes instead of ~/.codex", () => {
    const homes = [path.join(homedir(), ".codex-work-does-not-exist")];
    const watch = resolveCodexSessionWatchPaths(projectLocation, homes);
    // Nothing exists yet, so nothing is watched — but ~/.codex must not leak in.
    expect(watch.every((p) => p.startsWith(homes[0]!))).toBe(true);
    expect(readCodexRolloutsForLocation(projectLocation, homes)).toEqual([]);
    expect(readCodexSessionIndexForLocation(projectLocation, homes)).toEqual([]);
  });
});
