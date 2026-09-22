import { z } from "zod";

/**
 * How a follow-up sent while an agent is working reaches the model.
 *
 * - `mid-turn`:    appended to the running turn; the model reads it at the
 *                  next tool boundary, inside the same turn.
 * - `end-of-turn`: held until the running turn finishes, then sent as its own
 *                  turn.
 * - `interrupt`:   the running turn is cancelled and the follow-up opens a
 *                  fresh turn immediately.
 */
export const followUpDeliverySchema = z.enum(["mid-turn", "end-of-turn", "interrupt"]);
export type FollowUpDelivery = z.infer<typeof followUpDeliverySchema>;

/** Why a requested delivery could not be used. */
export const followUpDegradeReasonSchema = z.enum([
  "provider-cannot",
  "turn-not-steerable",
  "no-live-turn",
]);
export type FollowUpDegradeReason = z.infer<typeof followUpDegradeReasonSchema>;

/**
 * What an adapter can do when it declares nothing. Every agent can hold a
 * follow-up until the turn ends and every agent can be interrupted, so an
 * adapter that says nothing still promises nothing extra.
 */
export const DEFAULT_FOLLOW_UP_DELIVERIES: readonly FollowUpDelivery[] = [
  "end-of-turn",
  "interrupt",
];

export interface ResolvedFollowUpDelivery {
  delivery: FollowUpDelivery;
  /** Set when the request could not be honoured and was lowered. */
  degradedFrom?: FollowUpDelivery;
  reason?: FollowUpDegradeReason;
}

/**
 * Decide what will actually happen to a follow-up, given what the user asked
 * for, what the agent declares it can do, and the state of the running turn.
 *
 * Only `mid-turn` can degrade: every agent can hold a follow-up until the turn
 * ends, and every agent can be interrupted. Returning the reason is the point
 * of this function — a silent downgrade leaves the composer promising one
 * thing while the runtime does another.
 */
export function resolveFollowUpDelivery(input: {
  requested: FollowUpDelivery;
  supported: readonly FollowUpDelivery[];
  turn: { live: boolean; steerable: boolean };
}): ResolvedFollowUpDelivery {
  const { requested, supported, turn } = input;
  if (requested !== "mid-turn") return { delivery: requested };
  if (!supported.includes("mid-turn")) {
    return { delivery: "end-of-turn", degradedFrom: "mid-turn", reason: "provider-cannot" };
  }
  if (!turn.live) {
    return { delivery: "end-of-turn", degradedFrom: "mid-turn", reason: "no-live-turn" };
  }
  if (!turn.steerable) {
    return { delivery: "end-of-turn", degradedFrom: "mid-turn", reason: "turn-not-steerable" };
  }
  return { delivery: "mid-turn" };
}
