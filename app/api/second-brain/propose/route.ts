import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyQuote } from "@/lib/second-brain/verification-gate";

export const runtime = "nodejs";

const BATCH_SIZE = 10;

type PriceFact = {
  item_text: string;
  value: number;
  source_quote: string;
};
type LeadTimeFact = {
  item_text: string;
  value_weeks: number;
  source_quote: string;
};

async function processFact(
  supabase: SupabaseClient,
  email: { id: string; from_addr: string; clean_text: string | null },
  attachmentTexts: string[],
  fact: PriceFact | LeadTimeFact,
  field: "price_trade" | "lead_time_weeks"
): Promise<"proposed" | "unchanged" | "unmatched" | "duplicate" | "failed_verification"> {
  const value = field === "price_trade" ? (fact as PriceFact).value : (fact as LeadTimeFact).value_weeks;

  const { data: match } = await supabase
    .from("email_entity_matches")
    .select("entity_id,status")
    .eq("email_id", email.id)
    .eq("entity_type", "item")
    .eq("source_text", fact.item_text)
    .maybeSingle();
  if (!match || match.status !== "matched" || !match.entity_id) return "unmatched";

  const { data: item } = await supabase.from("items").select(`id,name,project_id,${field}`).eq("id", match.entity_id).maybeSingle();
  if (!item) return "unmatched";

  const currentValue = (item as unknown as Record<string, number | null>)[field];
  if (currentValue !== null && Math.abs(currentValue - value) < 0.005) return "unchanged";

  const { data: pendingForEntity } = await supabase
    .from("change_proposals")
    .select("id,new_value")
    .eq("entity_type", "item")
    .eq("entity_id", match.entity_id)
    .eq("field", field)
    .eq("status", "pending");
  const existingPending = (pendingForEntity ?? []).some((p) => Math.abs(Number(p.new_value) - value) < 0.005);
  if (existingPending) return "duplicate";

  const verification = verifyQuote({
    quote: fact.source_quote,
    value,
    sourceTexts: [email.clean_text, ...attachmentTexts],
  });

  if (!verification.passed) {
    const { data: proposal } = await supabase
      .from("change_proposals")
      .insert({
        entity_type: "item",
        entity_id: match.entity_id,
        field,
        old_value: currentValue,
        new_value: value,
        source_email_id: email.id,
        source_quote: fact.source_quote,
        confidence: 0,
        status: "failed_verification",
        note: verification.reason,
      })
      .select("id")
      .single();
    if (proposal) {
      await supabase.from("aria_queue").insert({
        kind: "approval_needed",
        payload: { proposal_id: proposal.id, reason: "failed_verification", note: verification.reason },
        dedupe_key: `approval_needed:proposal:${proposal.id}`,
        source: "second-brain-propose",
      });
    }
    return "failed_verification";
  }

  const { data: project } = await supabase.from("projects").select("name").eq("id", item.project_id).maybeSingle();
  const time = new Date().toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Adelaide" });
  const label = field === "price_trade" ? `$${currentValue ?? "?"}→$${value}` : `${currentValue ?? "?"}wk→${value}wk`;
  const summary = `${item.name} ${label} · ${project?.name ?? "Unknown project"} · from ${email.from_addr} ${time}`;

  const { data: proposal, error: insertError } = await supabase
    .from("change_proposals")
    .insert({
      entity_type: "item",
      entity_id: match.entity_id,
      field,
      old_value: currentValue,
      new_value: value,
      source_email_id: email.id,
      source_quote: fact.source_quote,
      confidence: 1,
      status: "pending",
    })
    .select("id")
    .single();
  if (insertError || !proposal) return "unmatched";

  await supabase.from("aria_queue").insert({
    kind: "email_proposal",
    payload: { proposal_id: proposal.id, summary },
    dedupe_key: `email_proposal:${proposal.id}`,
    source: "second-brain-propose",
  });

  return "proposed";
}

/**
 * GET /api/second-brain/propose — Vercel Cron entry point.
 *
 * RESLU Second Brain, Step 11 (docs/RESLU-second-brain-build-brief.md).
 * Picks up status='matched' emails, diffs each price_fact/
 * lead_time_fact (whose item_text has a status='matched' row in
 * Step 10's email_entity_matches) against the matched item's current
 * value, runs the deterministic verification gate
 * (lib/second-brain/verification-gate.ts), and creates a
 * change_proposals row only on a pass — a fail becomes
 * status='failed_verification' + a review queue row instead. Nothing
 * ever writes to items here; that only happens via approve_proposal()
 * (migration 040), called from the approve route.
 *
 * Auth mirrors every other cron in this build: Bearer CRON_SECRET or
 * an authenticated team session.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = createServiceRoleClient();

  const { data: emails, error } = await supabase
    .from("emails")
    .select("id,from_addr,clean_text,extraction")
    .eq("status", "matched")
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!emails || emails.length === 0) {
    return NextResponse.json({ proposed: 0, failed: 0 });
  }

  let proposed = 0;
  let failedVerification = 0;
  let failed = 0;

  for (const email of emails) {
    try {
      const { data: attachments } = await supabase.from("email_attachments").select("extracted_text").eq("email_id", email.id);
      const attachmentTexts = (attachments ?? []).map((a) => a.extracted_text).filter((t): t is string => !!t);

      const extraction = email.extraction as { price_facts?: PriceFact[]; lead_time_facts?: LeadTimeFact[] } | null;

      for (const fact of extraction?.price_facts ?? []) {
        const outcome = await processFact(supabase, email, attachmentTexts, fact, "price_trade");
        if (outcome === "proposed") proposed++;
        if (outcome === "failed_verification") failedVerification++;
      }
      for (const fact of extraction?.lead_time_facts ?? []) {
        const outcome = await processFact(supabase, email, attachmentTexts, fact, "lead_time_weeks");
        if (outcome === "proposed") proposed++;
        if (outcome === "failed_verification") failedVerification++;
      }

      const { error: updateError } = await supabase.from("emails").update({ status: "proposed" }).eq("id", email.id);
      if (updateError) throw new Error(`email update failed: ${updateError.message}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown propose error";
      console.error("second-brain/propose: failed for email", email.id, message);
      failed++;
    }
  }

  return NextResponse.json({ proposed, failed_verification: failedVerification, failed, batch_size: emails.length });
}
