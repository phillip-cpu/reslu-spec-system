import type { SupabaseClient } from "@supabase/supabase-js";
import type { PortalWhatsNext } from "@/app/portal/types";

/**
 * "What's next" block (BUILD-SPEC.md §"Phase 11 additions — confirmed
 * by Phillip" point 3): "top of portal, auto-generated from timeline
 * phases: this week / next week phase names + expected trades (company
 * names only). Nothing to write, derived data only."
 *
 * Queries ONLY schedule_phases' name/start_date/end_date (columns that
 * have existed since 013_boards_contacts.sql) for the phase-name half,
 * and defensively ATTEMPTS a trade_visits + contacts join for the
 * trade-company half. trade_visits + schedule_phases.kind are migration
 * 015 (the Phase 11A agent's table/columns, confirmed landed as of
 * this writing — select("id,name,start_date,end_date,kind") below
 * excludes kind='umbrella' rows, since an umbrella band spans the
 * WHOLE project's schedule and is not a specific week's work, so it
 * would otherwise show up as "this week" and "next week" simultaneously
 * for the entire job). This file is still written defensively (wrapped
 * in try/catch around the trade_visits query) per this task's boundary
 * rules — migration 016 explicitly does not take a hard dependency on
 * 015 having landed, since the two migrations are authored and applied
 * independently by two concurrent agents; if trade_visits or the `kind`
 * column were ever unavailable for any reason, the phase-name half of
 * the block still renders correctly on its own and the trade-company
 * arrays are simply empty.
 */
export async function getWhatsNext(
  supabase: SupabaseClient,
  projectId: string
): Promise<PortalWhatsNext> {
  const today = new Date();
  const startOfThisWeek = new Date(today);
  startOfThisWeek.setHours(0, 0, 0, 0);
  startOfThisWeek.setDate(today.getDate() - today.getDay()); // Sunday start
  const startOfNextWeek = new Date(startOfThisWeek);
  startOfNextWeek.setDate(startOfThisWeek.getDate() + 7);
  const startOfWeekAfter = new Date(startOfThisWeek);
  startOfWeekAfter.setDate(startOfThisWeek.getDate() + 14);

  const iso = (d: Date) => d.toISOString().slice(0, 10);

  // Excludes kind='umbrella' rows (migration 015) — an umbrella band
  // spans the whole project's schedule, not a specific week, so it
  // would otherwise appear as "this week" AND "next week" for the
  // entire job. Selecting `kind` itself is wrapped in the same
  // defensive spirit as the trade_visits query below: if the column
  // somehow isn't present, .eq("kind", ...) would just be omitted by
  // falling back to an un-filtered select — see the try/catch.
  let rows: { id: string; name: string; start_date: string; end_date: string }[] = [];
  try {
    const { data: phases, error } = await supabase
      .from("schedule_phases")
      .select("id,name,start_date,end_date,kind")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("start_date", { ascending: true });

    if (error) throw error;
    rows = ((phases ?? []) as { id: string; name: string; start_date: string; end_date: string; kind?: string }[]).filter(
      (p) => p.kind !== "umbrella"
    );
  } catch {
    // `kind` column not present for some reason — fall back to every
    // phase, unfiltered, rather than showing nothing at all.
    const { data: phases } = await supabase
      .from("schedule_phases")
      .select("id,name,start_date,end_date")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("start_date", { ascending: true });
    rows = (phases ?? []) as { id: string; name: string; start_date: string; end_date: string }[];
  }

  // A phase is "in" a week window if its date range overlaps that
  // window at all (not just if it starts within it) — a 3-week phase
  // spanning this week and next should show up in both.
  function overlaps(phase: { start_date: string; end_date: string }, windowStart: Date, windowEnd: Date) {
    const start = new Date(phase.start_date);
    const end = new Date(phase.end_date);
    return start < windowEnd && end >= windowStart;
  }

  const thisWeekPhases = rows.filter((p) => overlaps(p, startOfThisWeek, startOfNextWeek));
  const nextWeekPhases = rows.filter((p) => overlaps(p, startOfNextWeek, startOfWeekAfter));

  const thisWeekIds = new Set(thisWeekPhases.map((p) => p.id));
  const nextWeekIds = new Set(nextWeekPhases.map((p) => p.id));

  let thisWeekTrades: string[] = [];
  let nextWeekTrades: string[] = [];

  try {
    // Defensive: trade_visits (migration 015) may not exist yet. If the
    // query errors for any reason (missing table/column), the catch
    // below leaves both trade-company arrays empty rather than
    // propagating the failure into the whole portal page render.
    const { data: visits, error } = await supabase
      .from("trade_visits")
      .select("phase_id,start_date,end_date,status,contacts(company)")
      .eq("project_id", projectId)
      .in("status", ["confirmed", "tentative", "unconfirmed", "proposed_change"]);

    if (!error && visits) {
      for (const v of visits as {
        phase_id: string | null;
        start_date: string;
        end_date: string;
        contacts: { company: string } | { company: string }[] | null;
      }[]) {
        const company = Array.isArray(v.contacts) ? v.contacts[0]?.company : v.contacts?.company;
        if (!company) continue;

        const inThisWeek = v.phase_id ? thisWeekIds.has(v.phase_id) : overlaps(v, startOfThisWeek, startOfNextWeek);
        const inNextWeek = v.phase_id ? nextWeekIds.has(v.phase_id) : overlaps(v, startOfNextWeek, startOfWeekAfter);

        if (inThisWeek) thisWeekTrades.push(company);
        if (inNextWeek) nextWeekTrades.push(company);
      }
    }
  } catch {
    // trade_visits not available yet — phase names still render below.
  }

  thisWeekTrades = [...new Set(thisWeekTrades)].sort();
  nextWeekTrades = [...new Set(nextWeekTrades)].sort();

  return {
    this_week: { phase_names: thisWeekPhases.map((p) => p.name), trade_companies: thisWeekTrades },
    next_week: { phase_names: nextWeekPhases.map((p) => p.name), trade_companies: nextWeekTrades },
  };
}
