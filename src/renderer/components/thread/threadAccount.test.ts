import { describe, expect, it } from "vitest";
import type { AgentInstanceConfigMap } from "@/shared/contracts";
import { threadAccountDetails, threadAccountName } from "./threadAccount";

const instances: AgentInstanceConfigMap = {
  work: { id: "work", driver: "claude-profile", displayName: "Work" },
  personal: { id: "personal", driver: "codex-profile" },
};

describe("threadAccountName", () => {
  it("names a Claude profile thread by the profile's display name", () => {
    expect(threadAccountName("claude:work", instances, "Claude Work")).toBe("Work");
  });

  it("names a Codex profile thread with no display name by its instance id", () => {
    expect(threadAccountName("codex:personal", instances, "Codex Personal")).toBe("personal");
  });

  it("falls back to the instance id when the profile is not registered", () => {
    expect(threadAccountName("cursor:ghost", instances, "Cursor Ghost")).toBe("ghost");
  });

  it("names a default-login thread by its provider label", () => {
    expect(threadAccountName("claude", instances, "Claude Code")).toBe("Claude Code");
  });

  it("returns nothing when a default-login thread has no provider label yet", () => {
    expect(threadAccountName("claude", instances, undefined)).toBeUndefined();
    expect(threadAccountName("claude", instances, "  ")).toBeUndefined();
  });
});

describe("threadAccountDetails", () => {
  it("keeps the fields the provider reported", () => {
    expect(
      threadAccountDetails({
        authenticatedAs: "user@example.com",
        plan: "Max 20x",
        organization: "Acme",
      }),
    ).toEqual({ authenticatedAs: "user@example.com", plan: "Max 20x", organization: "Acme" });
  });

  it("drops blank fields", () => {
    expect(threadAccountDetails({ authenticatedAs: " ", plan: "Pro" })).toEqual({ plan: "Pro" });
  });

  it("returns nothing when the provider reports no account metadata", () => {
    expect(threadAccountDetails(undefined)).toBeUndefined();
    expect(threadAccountDetails({})).toBeUndefined();
  });
});
