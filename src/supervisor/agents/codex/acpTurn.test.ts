import { describe, expect, it } from "vitest";
import { buildCodexCollaborationMode } from "./acpTurn";

describe("Codex native collaboration instructions", () => {
  it.each(["agent", "plan"] as const)("keeps the built-in %s instructions", (mode) => {
    expect(buildCodexCollaborationMode({ model: "model", effort: "high", mode })).toEqual({
      mode: mode === "plan" ? "plan" : "default",
      settings: { model: "model", reasoning_effort: "high", developer_instructions: null },
    });
  });
});
