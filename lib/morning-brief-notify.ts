import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMorningBriefNotificationContent, rankMorningBriefItems } from "@/lib/morning-brief";
import { sendPushToUsers, type PushFanoutResult } from "@/lib/push";
import type { DailyBriefSource } from "@/lib/daily-brief";

interface OpenBriefRow {
  id: string;
  source: DailyBriefSource;
  title: string;
  brief_date: string;
  created_at: string;
}

export interface MorningBriefDeliveryResult {
  notifications_created: number;
  recipients_deduped: number;
  recipient_failures: number;
  item_count: number;
  push: PushFanoutResult;
  skipped?: string;
}

function emptyPushResult(): PushFanoutResult {
  return { configured: false, attempted: 0, delivered: 0, stale: 0, failed: 0 };
}

function mergePushResult(target: PushFanoutResult, result: PushFanoutResult) {
  target.configured ||= result.configured;
  target.attempted += result.attempted;
  target.delivered += result.delivered;
  target.stale += result.stale;
  target.failed += result.failed;
}

/**
 * Creates one private notification per admin and pushes that exact row to all
 * of the admin's subscribed devices. A date-scoped kind makes cron retries
 * idempotent; private rows prevent one admin/device from consuming another's
 * morning brief through the legacy latest-unread path.
 */
export async function notifyMorningBrief(
  supabase: SupabaseClient,
  briefDate: string,
  now: Date = new Date()
): Promise<MorningBriefDeliveryResult> {
  const push = emptyPushResult();
  const { data: rows, error: rowsError } = await supabase
    .from("daily_brief_items")
    .select("id,source,title,brief_date,created_at")
    .eq("status", "open");
  if (rowsError) throw new Error(`Morning Brief notification query failed: ${rowsError.message}`);

  const ranked = rankMorningBriefItems((rows ?? []) as OpenBriefRow[], now);
  if (ranked.length === 0) {
    return {
      notifications_created: 0,
      recipients_deduped: 0,
      recipient_failures: 0,
      item_count: 0,
      push,
      skipped: "No open brief items",
    };
  }

  const { data: admins, error: adminsError } = await supabase.from("profiles").select("id").eq("role", "admin");
  if (adminsError) throw new Error(`Morning Brief recipient query failed: ${adminsError.message}`);
  const adminIds = (admins ?? []).map((admin) => admin.id as string);
  if (adminIds.length === 0) {
    return {
      notifications_created: 0,
      recipients_deduped: 0,
      recipient_failures: 0,
      item_count: ranked.length,
      push,
      skipped: "No admin recipients",
    };
  }

  const kind = `morning_brief:${briefDate}`;
  const { data: existingRows, error: existingError } = await supabase
    .from("notifications")
    .select("user_id")
    .eq("kind", kind)
    .in("user_id", adminIds);
  if (existingError) throw new Error(`Morning Brief dedupe query failed: ${existingError.message}`);
  const alreadyCreatedFor = new Set((existingRows ?? []).map((row) => row.user_id as string));
  const content = buildMorningBriefNotificationContent(ranked);

  let notificationsCreated = 0;
  let failed = 0;
  let concurrentDeduped = 0;
  for (const adminId of adminIds) {
    if (alreadyCreatedFor.has(adminId)) continue;

    const { data: notification, error: insertError } = await supabase
      .from("notifications")
      .insert({
        user_id: adminId,
        kind,
        title: content.title,
        body: content.body,
        link_href: content.link,
        // Exact-id push delivery does not use latest-unread. Closing this row
        // prevents a later legacy payload-less health push from resurfacing
        // the morning brief after it has already appeared.
        read_at: now.toISOString(),
      })
      .select("id")
      .single();
    if (insertError?.code === "23505") {
      concurrentDeduped += 1;
      continue;
    }
    if (insertError || !notification) {
      failed += 1;
      continue;
    }

    const result = await sendPushToUsers([adminId], notification.id as string);
    mergePushResult(push, result);
    notificationsCreated += 1;
  }

  return {
    notifications_created: notificationsCreated,
    recipients_deduped: alreadyCreatedFor.size + concurrentDeduped,
    recipient_failures: failed,
    item_count: ranked.length,
    push,
  };
}
