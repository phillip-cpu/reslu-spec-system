import type { SupabaseClient } from "@supabase/supabase-js";

export interface TradeCalendarSyncInput {
  visit_id: string;
  project_id: string;
  contact_id: string | null;
  title: string;
  start_date: string;
  end_date: string;
  arrival_slot?: string | null;
  arrival_time?: string | null;
}

export function tradeCalendarDedupeKey(input: TradeCalendarSyncInput): string {
  return `calendar_sync:trade_visit:${input.visit_id}:${input.start_date}:${input.end_date}`;
}

/**
 * Queue a Mac-mini handoff to the dedicated RESLU Google Calendar.
 * Vercel never holds Google credentials and never writes the calendar
 * directly. The stable UID lets Aria update an existing event safely.
 */
export async function queueTradeCalendarSync(
  supabase: SupabaseClient,
  input: TradeCalendarSyncInput
): Promise<boolean> {
  const { data, error } = await supabase
    .from("aria_queue")
    .upsert(
      {
        kind: "calendar_sync",
        source: "trade-booking",
        dedupe_key: tradeCalendarDedupeKey(input),
        payload: {
          action: "upsert_trade_visit_in_reslu_google_calendar",
          calendar: "RESLU",
          timezone: "Australia/Adelaide",
          stable_uid: `trade-visit-${input.visit_id}@reslu.com.au`,
          ...input,
          instruction:
            "Create or update this visit in the dedicated RESLU Google Calendar using stable_uid. Do not invite or message the trade/client. Resolve the queue item with the Google event id.",
        },
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}
