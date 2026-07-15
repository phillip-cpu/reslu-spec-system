import assert from "node:assert/strict";
import test from "node:test";
import type { Lead, LeadStage } from "../types/index.ts";
import { buildDashboardSummary, totalPipelineValue } from "./leads.ts";

function lead(
  id: string,
  stage: LeadStage,
  constructionValue: number
): Lead {
  return {
    id,
    stage,
    construction_value: constructionValue,
    received_at: "2026-07-01T00:00:00.000Z",
    created_at: "2026-07-01T00:00:00.000Z",
  } as Lead;
}

test("Potential Future Lead never contributes to pipeline value", () => {
  const leads = [
    lead("active", "Proposal Sent", 250_000),
    lead("future", "Potential Future Lead", 900_000),
  ];

  assert.equal(totalPipelineValue(leads), 250_000);

  const summary = buildDashboardSummary(leads, [], new Date("2026-07-15T00:00:00.000Z"));
  const future = summary.stages.find((stage) => stage.stage === "Potential Future Lead");

  assert.equal(summary.total_pipeline_value, 250_000);
  assert.equal(summary.future_nurture_count, 1);
  assert.equal(future?.included_in_pipeline, false);
  assert.equal(future?.value, 0);
});

test("every inactive stage contributes zero to stage and total tallies", () => {
  const leads = [
    lead("unable", "Unable to Contact", 100_000),
    lead("lost", "Lead Lost", 200_000),
    lead("complete", "Complete", 300_000),
    lead("future", "Potential Future Lead", 400_000),
  ];

  const summary = buildDashboardSummary(leads, []);

  assert.equal(summary.total_pipeline_value, 0);
  assert.ok(
    summary.stages
      .filter((stage) => stage.count > 0)
      .every((stage) => !stage.included_in_pipeline && stage.value === 0)
  );
});
