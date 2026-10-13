import test from "node:test";
import assert from "node:assert/strict";
import { sowTradeDisplayHeading, normalizeSowHeadingOverride } from "./sow-display-headings.ts";
import { groupSowLinesByTrade, filterSectionsForTrade } from "./sow-trade-tags.ts";
import type { SowSectionWithTradedLines } from "../types/sow-trade-tags";
const trade="Timber Floor Laying & Sanding";
test("room-specific display override preserves trade grouping and other sections",()=>{
  const front={id:"front",heading:"Front Door & Hallway",trade_heading_overrides:{[trade]:"Timber Floor Laying"},lines:[{id:"l",trade,text:"Lay timber flooring",kind:"inclusion"}]} as unknown as SowSectionWithTradedLines;
  const other={...front,id:"other",heading:"Other room",trade_heading_overrides:{}};
  assert.equal(sowTradeDisplayHeading(front,trade),"Timber Floor Laying");
  assert.equal(sowTradeDisplayHeading(other,trade),trade);
  assert.equal(groupSowLinesByTrade(front.lines)[0].trade,trade);
  assert.equal(filterSectionsForTrade([front,other],trade).length,2);
  assert.equal(front.lines[0].trade,trade);
});
test("heading reset restores preset; malformed/prototype inputs cannot alter identity",()=>{
  assert.deepEqual(normalizeSowHeadingOverride({trade,heading:null}),{trade,heading:null});
  assert.equal(sowTradeDisplayHeading({},null),"General");
  for(const value of [{trade,heading:""},{trade,heading:"x\ny"},{trade,heading:"x".repeat(161)},{trade:"__proto__",heading:"x"}])assert.throws(()=>normalizeSowHeadingOverride(value));
});
