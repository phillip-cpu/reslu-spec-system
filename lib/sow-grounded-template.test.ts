import assert from "node:assert/strict";
import test from "node:test";
import { groundedRoomSectionTemplate } from "./sow-grounded-template.ts";

test("builds an action-based wet-room starter from plans and assigned FF&E", () => {
  const section = groundedRoomSectionTemplate({
    roomName: "Laundry",
    planFilenames: ["Interior works.pdf", "Joinery.pdf"],
    items: [
      { item_code: "SW-04", name: "Single bowl sink", quantity: 1, category: "SW" },
      { item_code: "ST-01", name: "Kirec", quantity: 1, category: "ST", finish: "Matte" },
      { item_code: "TL-02", name: "Skirting tile", quantity: 4, category: "TL" },
    ],
  });

  assert.equal(section.heading, "Laundry");
  assert.equal(section.lines[0]?.text, "Ref: Interior works.pdf; Joinery.pdf");
  assert.ok(section.lines.some((line) => line.text.startsWith("WATERPROOFING —")));
  assert.ok(section.lines.some((line) => line.text.startsWith("SANITARYWARE & TAPWARE — Install and connect SW-04")));
  assert.ok(section.lines.some((line) => line.text.startsWith("STONE — Template, supply and install ST-01")));
  assert.ok(section.lines.some((line) => line.text.startsWith("WALL TILING — Install TL-02")));
  assert.ok(section.lines.some((line) => line.text.startsWith("SCOPE CHECK —")));
  assert.equal(section.lines.some((line) => line.text.includes("{{")), false);
});

test("keeps unknown FF&E as a note instead of inventing trade ownership", () => {
  const section = groundedRoomSectionTemplate({
    roomName: "Study",
    planFilenames: [],
    items: [{ item_code: "ZZ-01", name: "Special item", quantity: 1, category: "ZZ" }],
  });
  const itemLine = section.lines.find((line) => line.text.includes("ZZ-01"));
  assert.equal(itemLine?.kind, "note");
  assert.match(itemLine?.text ?? "", /^FF&E REFERENCE —/);
});
