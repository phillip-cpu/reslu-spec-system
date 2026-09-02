import assert from "node:assert/strict";
import test from "node:test";
import type { SowLineWithTrade } from "../types/sow-trade-tags.ts";
import { groupSowLinesByTrade, suggestTradeTag } from "./sow-trade-tags.ts";

function line(id: string, trade: string | null): SowLineWithTrade {
  return {
    id,
    section_id: "section-1",
    text: `Line ${id}`,
    kind: "inclusion",
    sort: Number(id),
    trade,
    created_at: "2026-08-31T00:00:00.000Z",
    updated_at: "2026-08-31T00:00:00.000Z",
  };
}

test("groups full-scope lines beneath trades in first-appearance order", () => {
  const groups = groupSowLinesByTrade([
    line("1", "Tiler"),
    line("2", "Carpenter"),
    line("3", "Tiler"),
  ]);

  assert.deepEqual(
    groups.map((group) => ({ trade: group.trade, ids: group.lines.map((item) => item.id) })),
    [
      { trade: "Tiler", ids: ["1", "3"] },
      { trade: "Carpenter", ids: ["2"] },
    ]
  );
});

test("keeps blank and untagged lines visible in one separate group", () => {
  const groups = groupSowLinesByTrade([
    line("1", null),
    line("2", ""),
    line("3", "Painter"),
  ]);

  assert.equal(groups[0]?.trade, null);
  assert.deepEqual(groups[0]?.lines.map((item) => item.id), ["1", "2"]);
  assert.equal(groups[1]?.trade, "Painter");
});

test("matches grounded clause labels to the studio's descriptive preset names", () => {
  const presets = ["Joiner", "Carpenter", "Plaster, Flushing & Cornice", "Site & Earthworks"];
  assert.equal(suggestTradeTag("JOINERY — Install J07", presets), "Joiner");
  assert.equal(suggestTradeTag("CARPENTRY — Install DR-02", presets), "Carpenter");
  assert.equal(
    suggestTradeTag("PARTITIONS & PLASTERING — Install Aquacheck", presets),
    "Plaster, Flushing & Cornice"
  );
  assert.equal(suggestTradeTag("EXTERNAL WORKS — Install paving", presets), "Site & Earthworks");
});
