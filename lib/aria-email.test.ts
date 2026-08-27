import assert from "node:assert/strict";
import test from "node:test";
import { validateAriaEmailInput } from "./aria-email.ts";

test("normalises one exact approved email", () => {
  assert.deepEqual(validateAriaEmailInput({
    to: " WILYoungPainting@outlook.com ",
    subject: " Childers Street painting availability ",
    body: "Hi Wil,\n\nAre you available?",
  }), {
    to: "wilyoungpainting@outlook.com",
    cc: [],
    subject: "Childers Street painting availability",
    body: "Hi Wil,\n\nAre you available?",
  });
});

test("rejects missing or malformed delivery fields", () => {
  assert.throws(() => validateAriaEmailInput({ to: "not-an-email", subject: "x", body: "y" }), /valid final recipient/);
  assert.throws(() => validateAriaEmailInput({ to: "wil@example.com", subject: "", body: "y" }), /Subject/);
});
