import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationTextParts,
  insertConversationLink,
  normalizeConversationLink,
} from "./conversation-links.ts";

test("normalizes ordinary web addresses and rejects unsafe schemes", () => {
  assert.equal(normalizeConversationLink("www.reslu.com.au"), "https://www.reslu.com.au/");
  assert.equal(normalizeConversationLink("https://example.com/page"), "https://example.com/page");
  assert.equal(normalizeConversationLink("javascript:alert(1)"), null);
  assert.equal(normalizeConversationLink("data:text/html,test"), null);
});

test("renders labelled and pasted URLs as safe link parts", () => {
  assert.deepEqual(conversationTextParts("Open [the plans](https://example.com/plans) today."), [
    { type: "text", text: "Open " },
    { type: "link", text: "the plans", href: "https://example.com/plans" },
    { type: "text", text: " today." },
  ]);
  assert.deepEqual(conversationTextParts("See www.example.com, then reply."), [
    { type: "text", text: "See " },
    { type: "link", text: "www.example.com", href: "https://www.example.com/" },
    { type: "text", text: "," },
    { type: "text", text: " then reply." },
  ]);
  assert.deepEqual(conversationTextParts("javascript:alert(1)"), [
    { type: "text", text: "javascript:alert(1)" },
  ]);
});

test("inserts a labelled link over the selected composer text", () => {
  assert.deepEqual(insertConversationLink("Review these plans", 7, 12, "these", "example.com"), {
    text: "Review [these](https://example.com/) plans",
    cursor: 36,
  });
  assert.equal(insertConversationLink("Hello", 5, 5, "bad", "javascript:alert(1)"), null);
});
