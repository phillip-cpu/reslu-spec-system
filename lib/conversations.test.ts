import assert from "node:assert/strict";
import test from "node:test";
import { conversationDisplayTitle, initials } from "./conversations.ts";

const phillip = { id: "p", type: "human" as const, display_name: "Phillip Introna", avatar_url: null };
const aria = { id: "a", type: "agent" as const, display_name: "Aria", avatar_url: null };
const tenille = { id: "t", type: "human" as const, display_name: "Tennille", avatar_url: null };

test("direct conversations are named for the other participant", () => {
  assert.equal(conversationDisplayTitle(null, [phillip, aria], "p"), "Aria");
});
test("mixed groups list human and agent participants", () => {
  assert.equal(conversationDisplayTitle(null, [phillip, tenille, aria], "p"), "Tennille, Aria");
});

test("explicit group titles win", () => {
  assert.equal(conversationDisplayTitle("Friday studio", [phillip, aria], "p"), "Friday studio");
});

test("initials handle staff and agent names", () => {
  assert.equal(initials("Phillip Introna"), "PI");
  assert.equal(initials("Aria"), "AR");
});
