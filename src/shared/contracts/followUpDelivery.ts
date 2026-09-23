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

/**
 * What can be said about a follow-up. `unknown` is not something an adapter
 * performs — it is the absence of a declaration, and the only honest answer
 * when the agent has not been probed yet, the remote host predates the
 * capability, or the adapter simply never declared. It exists so a caller
 * cannot accidentally render a guess as a promise.
 */
export type ResolvedFollowUpDelivery = FollowUpDelivery | "unknown";

/**
 * Gentlest first: a follow-up that is held costs the user nothing, a follow-up
 * that interrupts costs them the running turn.
 */
const FALLBACK_ORDER: readonly FollowUpDelivery[] = ["end-of-turn", "interrupt"];

/**
 * Decide what will actually happen to a follow-up sent into a live turn, given
 * what the user asked for and what the agent declares it can do.
 *
 * There is deliberately no default for `declared`. The two paths behind a
 * follow-up are not interchangeable: an adapter with a native steer that holds
 * the prompt delivers `end-of-turn`, while one without it has its running turn
 * cancelled so the prompt can drain as a fresh turn — an `interrupt`. Guessing
 * between them is how the composer ends up naming a turn that gets killed, so
 * an agent that declares nothing resolves to `unknown` and the caller must say
 * something non-committal.
 */
export function resolveFollowUpDelivery(input: {
  requested: FollowUpDelivery;
  declared: readonly FollowUpDelivery[] | undefined;
}): ResolvedFollowUpDelivery {
  const { requested, declared } = input;
  if (declared === undefined) return "unknown";
  if (declared.includes(requested)) return requested;
  return FALLBACK_ORDER.find((candidate) => declared.includes(candidate)) ?? "unknown";
}
