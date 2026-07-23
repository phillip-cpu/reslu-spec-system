import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { suppressProposalFollowupForLeadStage } from "./proposal-followups.ts";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/068_close_proposals_for_lost_leads.sql",
    import.meta.url
  ),
  "utf8"
);

test("lost leads never surface fee-proposal follow-ups", () => {
  assert.equal(suppressProposalFollowupForLeadStage("Lead Lost"), true);
  assert.equal(suppressProposalFollowupForLeadStage("Proposal Sent"), false);
  assert.equal(suppressProposalFollowupForLeadStage("Potential Future Lead"), false);
  assert.equal(suppressProposalFollowupForLeadStage(null), false);
});

test("lost-lead migration closes outstanding proposals and queued sends", () => {
  assert.match(
    migration,
    /new\.stage = 'Lead Lost'[\s\S]+p\.status in \('draft', 'sent'\)/
  );
  assert.match(
    migration,
    /update email_sends[\s\S]+status = 'skipped'[\s\S]+record_type = 'proposal'/
  );
  assert.match(
    migration,
    /update proposals[\s\S]+set status = 'closed'/
  );
  assert.match(
    migration,
    /l\.stage = 'Lead Lost'[\s\S]+p\.status in \('draft', 'sent'\)/
  );
});
