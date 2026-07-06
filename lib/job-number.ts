import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// RESLU Spec System — Job number generation.
// BUILD-SPEC.md "Three from Phillip — 6 July 2026 evening" item 2:
// "auto-generated 3-digit on create (next = max numeric existing + 1,
// zero-padded ...)". Migration 028_job_numbers.sql adds
// projects.job_number (text, partial-unique index on non-null/
// non-deleted rows).
//
// Used by BOTH project-creation paths — app/api/projects/route.ts
// (POST) and app/api/leads/[id]/create-project/route.ts — so a job
// number is assigned no matter which door a new project comes through.
// ============================================================

/**
 * Computes the next job number: the max of all existing NUMERIC
 * job_numbers (non-numeric/legacy values, if any ever exist, are
 * ignored rather than breaking the sequence) + 1, zero-padded to 3
 * digits. Naturally rolls to 4 digits once the sequence passes 999
 * (`lpad` only pads UP to the target width — a 4-digit number is
 * returned as-is, never truncated).
 *
 * Reads ALL projects (including archived/soft-deleted) so a number
 * once issued is never reissued to a different project, matching the
 * partial unique index's own "active rows only" collision check being
 * a floor, not the whole story — this function is deliberately more
 * conservative than the DB constraint strictly requires, to avoid
 * ever handing out a number that used to belong to something else.
 */
export async function nextJobNumber(
  supabase: SupabaseClient
): Promise<string> {
  const { data, error } = await supabase
    .from("projects")
    .select("job_number")
    .not("job_number", "is", null);

  if (error) {
    throw new Error(`Could not compute next job number: ${error.message}`);
  }

  let max = 0;
  for (const row of data ?? []) {
    const raw = (row as { job_number: string | null }).job_number;
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) continue; // non-numeric legacy value — ignore, don't break the sequence
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }

  const next = max + 1;
  return String(next).padStart(3, "0");
}

/** `^\d{3,4}$` — matches lib/job-number.ts's own 3-digit default and the natural 4-digit rollover; used both here (documented for reuse) and in ProjectSettingsForm's client-side check. */
export const JOB_NUMBER_PATTERN = /^\d{3,4}$/;
