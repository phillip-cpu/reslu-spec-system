import assert from "node:assert/strict";
import test from "node:test";
import { brainNodeKey, buildVisibleBrainLinks } from "./brain-graph.ts";

test("builds deduplicated links only between visible graph nodes", () => {
  const visible = new Set([
    brainNodeKey("email", "email-1"),
    brainNodeKey("project", "project-1"),
    brainNodeKey("item", "item-1"),
  ]);
  const links = buildVisibleBrainLinks(
    [
      { sourceType: "email", sourceId: "email-1", targetType: "project", targetId: "project-1", relation: "mentions project" },
      { sourceType: "email", sourceId: "email-1", targetType: "project", targetId: "project-1", relation: "mentions project" },
      { sourceType: "email", sourceId: "email-1", targetType: "item", targetId: "missing", relation: "mentions item" },
      { sourceType: "item", sourceId: "item-1", targetType: "project", targetId: "project-1", relation: "belongs to project" },
    ],
    visible
  );

  assert.deepEqual(links, [
    { source: "email:email-1", target: "project:project-1", relation: "mentions project" },
    { source: "item:item-1", target: "project:project-1", relation: "belongs to project" },
  ]);
});
