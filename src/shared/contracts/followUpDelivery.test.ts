import { describe, expect, it } from "vitest";
import { resolveFollowUpDelivery } from "./followUpDelivery";

describe("resolveFollowUpDelivery", () => {
  it("keeps the requested delivery when the agent declared it", () => {
    expect(
      resolveFollowUpDelivery({
        requested: "mid-turn",
        declared: ["mid-turn", "end-of-turn", "interrupt"],
      }),
    ).toBe("mid-turn");
  });

  it("refuses to guess when the agent declared nothing", () => {
    // Not probed yet, a host too old to send the field, or an adapter that
    // has not declared: three different states, none of them a promise.
    expect(resolveFollowUpDelivery({ requested: "mid-turn", declared: undefined })).toBe("unknown");
  });

  it("refuses to guess when the agent declares no mid-turn delivery at all", () => {
    expect(resolveFollowUpDelivery({ requested: "mid-turn", declared: [] })).toBe("unknown");
  });

  it("degrades mid-turn to the holding delivery the agent did declare", () => {
    expect(
      resolveFollowUpDelivery({ requested: "mid-turn", declared: ["end-of-turn", "interrupt"] }),
    ).toBe("end-of-turn");
  });

  it("degrades mid-turn to interrupt when holding is not declared", () => {
    // The steer path cancels the running turn for an agent that cannot hold a
    // follow-up; saying "after this turn" there names a turn that gets killed.
    expect(resolveFollowUpDelivery({ requested: "mid-turn", declared: ["interrupt"] })).toBe(
      "interrupt",
    );
  });

  it("degrades a requested hold to interrupt when only interrupt is declared", () => {
    expect(resolveFollowUpDelivery({ requested: "end-of-turn", declared: ["interrupt"] })).toBe(
      "interrupt",
    );
  });

  it("never claims a delivery for an undeclared agent whatever was requested", () => {
    expect(resolveFollowUpDelivery({ requested: "end-of-turn", declared: undefined })).toBe(
      "unknown",
    );
    expect(resolveFollowUpDelivery({ requested: "interrupt", declared: undefined })).toBe(
      "unknown",
    );
  });
});
