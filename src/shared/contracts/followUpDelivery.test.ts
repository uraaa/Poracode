import { describe, expect, it } from "vitest";
import { resolveFollowUpDelivery } from "./followUpDelivery";

describe("resolveFollowUpDelivery", () => {
  it("keeps the requested delivery when the provider supports it on a live steerable turn", () => {
    expect(
      resolveFollowUpDelivery({
        requested: "mid-turn",
        supported: ["mid-turn", "end-of-turn", "interrupt"],
        turn: { live: true, steerable: true },
      }),
    ).toEqual({ delivery: "mid-turn" });
  });

  it("degrades mid-turn to end-of-turn when the provider cannot do it", () => {
    expect(
      resolveFollowUpDelivery({
        requested: "mid-turn",
        supported: ["end-of-turn", "interrupt"],
        turn: { live: true, steerable: true },
      }),
    ).toEqual({ delivery: "end-of-turn", degradedFrom: "mid-turn", reason: "provider-cannot" });
  });

  it("degrades mid-turn when the live turn refuses steering", () => {
    expect(
      resolveFollowUpDelivery({
        requested: "mid-turn",
        supported: ["mid-turn", "end-of-turn", "interrupt"],
        turn: { live: true, steerable: false },
      }),
    ).toEqual({ delivery: "end-of-turn", degradedFrom: "mid-turn", reason: "turn-not-steerable" });
  });

  it("degrades mid-turn to a plain turn when no turn is live", () => {
    expect(
      resolveFollowUpDelivery({
        requested: "mid-turn",
        supported: ["mid-turn", "end-of-turn", "interrupt"],
        turn: { live: false, steerable: false },
      }),
    ).toEqual({ delivery: "end-of-turn", degradedFrom: "mid-turn", reason: "no-live-turn" });
  });

  it("never degrades a request that is not mid-turn", () => {
    expect(
      resolveFollowUpDelivery({
        requested: "end-of-turn",
        supported: ["end-of-turn", "interrupt"],
        turn: { live: false, steerable: false },
      }),
    ).toEqual({ delivery: "end-of-turn" });
  });
});
