import { expect, it } from "vitest";
import {
  getGitStatusPayloadSchema,
  gitProjectSnapshotPayloadSchema,
  getGitBranchesPayloadSchema,
} from "./git";
import { ghListPrsPayloadSchema } from "./github";

it("preserves opt-in polling hints while old callers retain interactive defaults", () => {
  const projectLocation = { kind: "posix", path: "/repo" };
  for (const schema of [
    getGitStatusPayloadSchema,
    gitProjectSnapshotPayloadSchema,
    getGitBranchesPayloadSchema,
    ghListPrsPayloadSchema,
  ]) {
    expect(schema.parse({ projectLocation, background: true })).toMatchObject({ background: true });
    expect(schema.parse({ projectLocation })).not.toHaveProperty("background");
  }
});
