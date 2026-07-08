import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { matchMention, type MatchEntityType, type MatchResult } from "@/lib/second-brain/matching";
import { embedTexts } from "@/lib/second-brain/embeddings";

export const runtime = "nodejs";

const BATCH_SIZE = 10;
const AUTO_LINK_THRESHOLD = 0.9;
const REVIEW_THRESHOLD = 0.6;

async function embedOne(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}

type Mention = { text: string; entityType: MatchEntityType };

function collectMentions(extraction: Record<string, unknown> | null): Mention[] {
  if (!extraction) return [];
  const seen = new Map<string, Mention>();
  const add = (text: string | undefined, entityType: MatchEntityType) => {
    if (!text) return;
    const key = `${entityType}:${text.trim().toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { text: text.trim(), entityType });
  };

  for (const m of (extraction.job_mentions as { text: string }[] | undefined) ?? []) add(m.text, "project");
  for (const m of (extraction.item_mentions as { text: string }[] | undefined) ?? []) add(m.text, "item");
  for (const f of (extraction.price_facts as { item_text: string }[] | undefined) ?? []) add(f.item_text, "item");
  for (const f of (extraction.lead_time_facts as { item_text: string }[] | undefined) ?? []) add(f.item_text, "item");

  return [...seen.values()];
}

async function resolveAndStore(
  supabase: SupabaseClient,
  emailId: string,
  senderDomain: string | null,
  mention: Mention
): Promise<void> {
  const result: MatchResult = await matchMention(supabase, {
    text: mention.text,
    entityType: mention.entityType,
    senderDomain,
    embedText: embedOne,
  });

  const status = result.entityId === null ? "no_match" : result.confidence >= AUTO_LINK_THRESHOLD ? "matched" : result.confidence >= REVIEW_THRESHOLD ? "review" : "no_match";
  const entityId = status === "no_match" ? null : result.entityId;

  const { data: matchRow, error } = await supabase
    .from("email_entity_matches")
    .upsert(
      {
        email_id: emailId,
        source_text: mention.text,
        entity_type: mention.entityType,
        entity_id: entityId,
        confidence: result.confidence,
        method: result.method,
        status,
        candidates: result.candidates,
        resolved_at: new Date().toISOString(),
      },
      { onConflict: "email_id,entity_type,source_text" }
    )
    .select("id")
    .single();
  if (error) {
    console.error("match: upsert failed", emailId, mention.text, error.message);
    return;
  }

  if (status === "review" && matchRow) {
    await supabase
      .from("aria_queue")
      .insert({
        kind: "approval_needed",
        payload: { match_id: matchRow.id, email_id: emailId, source_text: mention.text, entity_type: mention.entityType },
        dedupe_key: `approval_needed:${matchRow.id}`,
        source: "second-brain-match",
      })
      .then(({ error: queueError }) => {
        if (queueError && queueError.code !== "23505") {
          console.error("match: aria_queue insert failed", matchRow.id, queueError.message);
        }
      });
  }
}

/**
 * GET /api/second-brain/match — Vercel Cron entry point.
 *
 * RESLU Second Brain, Step 10 (docs/RESLU-second-brain-build-brief.md).
 * Picks up status='extracted' emails, resolves every distinct mention
 * text in their extraction (Step 9) via the matching ladder
 * (lib/second-brain/matching.ts), writes email_entity_matches rows,
 * queues review-band matches as aria_queue approval_needed items, and
 * sets status='matched' once every mention in an email has a row —
 * regardless of which confidence band each individual mention landed
 * in (per-mention nuance lives in email_entity_matches, not the
 * email's own status).
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
    .select("id,from_addr,extraction")
    .eq("status", "extracted")
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!emails || emails.length === 0) {
    return NextResponse.json({ matched: 0, failed: 0 });
  }

  let matched = 0;
  let failed = 0;

  for (const email of emails) {
    try {
      const mentions = collectMentions(email.extraction as Record<string, unknown> | null);
      const senderDomain = email.from_addr?.split("@")[1]?.toLowerCase() ?? null;

      for (const mention of mentions) {
        await resolveAndStore(supabase, email.id, senderDomain, mention);
      }

      const { error: updateError } = await supabase.from("emails").update({ status: "matched" }).eq("id", email.id);
      if (updateError) throw new Error(`email update failed: ${updateError.message}`);

      matched++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown matching error";
      console.error("second-brain/match: failed for email", email.id, message);
      failed++;
    }
  }

  return NextResponse.json({ matched, failed, batch_size: emails.length });
}
