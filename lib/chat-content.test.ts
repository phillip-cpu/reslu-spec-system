import assert from "node:assert/strict";
import test from "node:test";
import { chatLinkTarget, isAgentInterruption, parseChatContent } from "./chat-content.ts";

test("headings, paragraphs and numbered steps remain separate without blank lines", () => {
  assert.deepEqual(parseChatContent("## Result\nVerified text\n3. First step\n4. Next step"), [
    { kind: "heading", text: "Result" }, { kind: "paragraph", text: "Verified text" },
    { kind: "list", ordered: true, start: 3, items: ["First step", "Next step"] },
  ]);
});

test("financial tables keep columns, escaped pipes and incomplete cells", () => {
  assert.deepEqual(parseChatContent("Summary\n| Cost | Evidence |\n| ---: | :--- |\n| $12 | A \\| B |\n| $4 |"), [
    { kind: "paragraph", text: "Summary" },
    { kind: "table", headers: ["Cost", "Evidence"], rows: [["$12", "A | B"], ["$4"]] },
  ]);
});

test("code and raw HTML remain literal text, including unfinished code fences", () => {
  assert.deepEqual(parseChatContent("```html\n<img onerror=alert(1)>\n## not a heading"), [
    { kind: "code", language: "html", text: "<img onerror=alert(1)>\n## not a heading" },
  ]);
  assert.deepEqual(parseChatContent("<script>alert(1)</script>"), [{ kind: "paragraph", text: "<script>alert(1)</script>" }]);
});

test("links allow ordinary web and local navigation but not executable schemes or protocol-relative URLs", () => {
  for (const target of ["javascript:alert(1)", "data:text/html,test", "//evil.example", "/\\evil.example", "file:///etc/passwd"]) assert.equal(chatLinkTarget(target), null);
  assert.equal(chatLinkTarget("/projects/test"), "/projects/test");
  assert.equal(chatLinkTarget("https://example.com/evidence"), "https://example.com/evidence");
});

test("interrupted agent turns are distinct from group updates and quoted human messages", () => {
  assert.equal(isAgentInterruption({ kind: "system", body: "I could not finish that turn. Please try again.", metadata: {} }), true);
  assert.equal(isAgentInterruption({ kind: "system", body: "Agent timed out", metadata: {} }), true);
  assert.equal(isAgentInterruption({ kind: "text", body: "I could not finish that turn", metadata: {} }), false);
  assert.equal(isAgentInterruption({ kind: "system", body: "Phillip added Aria", metadata: {} }), false);
});
