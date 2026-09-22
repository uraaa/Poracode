import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessageSearchHit } from "@/shared/contracts";
import { useMessageSearch } from "./useMessageSearch";

const searchThreadMessages =
  vi.fn<(payload: { query: string }) => Promise<ThreadMessageSearchHit[]>>();
vi.mock("@/renderer/bridge", () => ({ readBridge: () => ({ searchThreadMessages }) }));

function hit(itemId: string): ThreadMessageSearchHit {
  return {
    threadId: "t1",
    threadTitle: "T",
    projectId: "p1",
    itemId,
    position: 0,
    role: "user",
    snippet: itemId,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("useMessageSearch", () => {
  beforeEach(() => {
    searchThreadMessages.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays idle for a query below the minimum length", async () => {
    const { result } = renderHook(() => useMessageSearch("и"));
    expect(result.current).toEqual({ hits: [], status: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(searchThreadMessages).not.toHaveBeenCalled();
  });

  it("reports the hits of the current query", async () => {
    searchThreadMessages.mockResolvedValue([hit("i1")]);
    const { result } = renderHook(() => useMessageSearch("импорт"));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.hits).toEqual([hit("i1")]);
  });

  it("ignores a response that answers a query the user has moved on from", async () => {
    const answers = new Map<string, ThreadMessageSearchHit[]>([
      ["импорт", [hit("stale")]],
      ["импорт сессий", [hit("fresh")]],
    ]);
    searchThreadMessages.mockImplementation(
      ({ query }) =>
        new Promise((resolve) => {
          // The first query answers late, long after the second one resolved.
          setTimeout(() => resolve(answers.get(query) ?? []), query === "импорт" ? 500 : 0);
        }),
    );

    const { result, rerender } = renderHook(({ query }) => useMessageSearch(query), {
      initialProps: { query: "импорт" },
    });
    // Past the debounce, so the first request is really in flight when the
    // query changes.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(searchThreadMessages).toHaveBeenCalledWith({ query: "импорт" });
    rerender({ query: "импорт сессий" });

    await waitFor(() => expect(result.current.hits).toEqual([hit("fresh")]));

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(result.current.hits).toEqual([hit("fresh")]);
  });

  it("reports a failed search without losing the overlay", async () => {
    searchThreadMessages.mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useMessageSearch("импорт"));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.hits).toEqual([]);
  });
});
