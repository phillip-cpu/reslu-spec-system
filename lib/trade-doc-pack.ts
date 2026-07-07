// ============================================================
// RESLU Spec System — "Trade booking document pack" round.
// Pure domain logic for resolving a trade visit's frozen document_pack
// CHOICES against the project's current LIVE documents. Mirrors
// lib/trade-visits.ts's own "pure domain layer, plain data in/out"
// shape, with ONE deliberate exception to that file's "no imports at
// all" purity: DocumentPackChoices itself is imported from
// types/trade-doc-pack.ts (a type-only import, zero runtime
// dependency) rather than redeclared here, so this file can never
// drift out of sync with that type's three-state
// schedule_categories encoding (key-absent vs null vs array — see
// that type's own doc comment) the way a second, hand-copied
// interface risks doing.
//
// RESOLUTION SEMANTICS — the one design decision worth stating clearly
// (also called out in the migration's own comment and the build
// report): document_pack stores CHOICES, frozen at booking time
// ("include plans: yes", "schedule: Plumber's TW+SW categories",
// "include SOW: yes") — it does NOT store which file/revision/URL
// satisfies each choice. Every render (the trade page) and every
// proxy-endpoint request re-resolves the CURRENT latest matching
// document from project_files / sow_documents at that moment. This
// means:
//
//   - A plan uploaded or revised AFTER the visit was booked is
//     automatically what the trade sees next time they open their
//     booking page — no re-booking, no stale link, no need for staff
//     to "update" anything on the visit itself.
//   - If a document a choice pointed at is later deleted (e.g. the
//     only plans revision is removed) with nothing newer to fall back
//     to, that row simply disappears from the DOCUMENTS section next
//     render — never a broken/404 link shown to the trade.
//   - The CHOICE itself (whether plans/schedule/SOW should be offered
//     at all, and which category subset for the schedule) is what's
//     frozen — a staff member who deliberately excluded the schedule
//     from one trade's pack at booking time won't have it silently
//     reappear later just because a schedule PDF now exists; that
//     would require re-booking or a future "edit pack" affordance
//     (out of this round's scope — BUILD-SPEC's item 1 only asks for
//     the choices to be stored, not a later edit UI).
//
// This is the same "frozen snapshot of a DECISION, live view of the
// DATA it points at" split already established by
// estimate_versions.snapshot (a frozen READ artefact) vs. e.g.
// schedule_phases' live-joined visits — except here the "snapshot" is
// much smaller (three booleans/arrays, not a whole estimate), so it's
// a plain jsonb column rather than its own table.
// ============================================================

import type { DocumentPackChoices } from "@/types/trade-doc-pack";
export type { DocumentPackChoices };

/** Minimal project_files row shape this module needs — kept local (not importing "@/types") per this file's dependency-free convention, mirroring lib/trade-visits.ts's own VisitContactSummary redefinition. */
export interface PlansFileRow {
  id: string;
  storage_path: string;
  filename: string;
  revision_label: string | null;
  uploaded_at: string;
}

/** Minimal sow_documents row shape this module needs. */
export interface SowDocumentRow {
  id: string;
  revision_label: string;
  status: "draft" | "issued";
  issued_at: string | null;
  created_at: string;
}

/**
 * Picks the latest PLANS revision from a project's project_files rows
 * — same sort as components/projects/ProjectDocuments.tsx's own
 * "newest-revision-first" rule (revision_label desc, string-compared —
 * "T3" > "T2" > "T1" — then uploaded_at desc, null revision_label
 * sorts after any labelled revision), so the trade page and the
 * proxy endpoint agree with the internal Project Documents tab about
 * which revision is "latest." Callers pass only rows already filtered
 * to kind === 'plans' and deleted_at is null — this function does no
 * filtering of its own, it only picks the winner from what it's given.
 */
export function latestPlansFile(files: PlansFileRow[]): PlansFileRow | null {
  if (files.length === 0) return null;
  const sorted = [...files].sort((a, b) => {
    if (a.revision_label !== b.revision_label) {
      if (a.revision_label === null) return 1;
      if (b.revision_label === null) return -1;
      return b.revision_label.localeCompare(a.revision_label);
    }
    return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
  });
  return sorted[0];
}

/**
 * Picks the latest ISSUED SOW revision — "issued" is the meaningful
 * filter here (BUILD-SPEC.md item 3: "Scope of Works (latest issued
 * SOW pdf)"), not just the latest revision regardless of status: a
 * draft-in-progress SOW is a working document, not something to hand
 * to a trade. Among issued revisions, latest by issued_at desc (the
 * moment it became authoritative), falling back to created_at desc for
 * the theoretical case of two issued revisions sharing an identical
 * issued_at. Callers pass only rows already filtered to deleted_at is
 * null.
 */
export function latestIssuedSow(sows: SowDocumentRow[]): SowDocumentRow | null {
  const issued = sows.filter((s) => s.status === "issued");
  if (issued.length === 0) return null;
  const sorted = [...issued].sort((a, b) => {
    const aTime = new Date(a.issued_at ?? a.created_at).getTime();
    const bTime = new Date(b.issued_at ?? b.created_at).getTime();
    return bTime - aTime;
  });
  return sorted[0];
}

/**
 * Builds the "Your schedule — {label}" display label for the trade
 * page / BookVisitPanel, given the frozen schedule_categories choice
 * and (if resolvable) the preset name that produced it at booking
 * time. `presetName` is null for either "full schedule" (categories
 * null) or a hand-edited/custom category subset that doesn't match any
 * CURRENTLY configured preset's prefixes exactly — BUILD-SPEC's
 * "Custom" label covers both, since from the trade page's perspective
 * there is no meaningful difference between "never was a preset" and
 * "was a preset that's since been renamed/deleted."
 */
export function scheduleLabel(categories: string[] | null, presetName: string | null): string {
  if (categories === null) return "Your schedule — Full schedule";
  return `Your schedule — ${presetName ?? "Custom"}`;
}

/**
 * Resolves a document_pack's schedule_categories back to a preset NAME
 * by exact prefix-set match (order-independent) against the studio's
 * CURRENT export presets — used by both BookVisitPanel (to show the
 * "picked preset name" immediately after auto-pick, before submit) and
 * the trade page (to label a previously-booked pack's schedule row).
 * Returns null when categories is null (full schedule — no preset
 * concept applies) OR when no current preset's prefix set matches
 * exactly (a custom hand-edited selection, or a preset that's since
 * been renamed/deleted/had its prefixes changed) — see scheduleLabel's
 * own doc comment for why both collapse to "Custom" identically.
 */
export function findPresetNameForCategories(
  categories: string[] | null,
  presets: { name: string; prefixes: string[] }[]
): string | null {
  if (categories === null) return null;
  const wanted = [...new Set(categories.map((c) => c.trim().toUpperCase()))].sort();
  const match = presets.find((p) => {
    const presetSet = [...new Set(p.prefixes.map((pfx) => pfx.trim().toUpperCase()))].sort();
    return presetSet.length === wanted.length && presetSet.every((v, i) => v === wanted[i]);
  });
  return match?.name ?? null;
}

/** Human-readable byte size, e.g. "2.4 MB" / "180 KB" — used for the trade page's "file sizes where cheap" requirement (a real Storage object's content-length, never computed for the generated schedule/SOW PDFs, which have no stored size without rendering them). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * True whenever a document_pack has ANY of its three choices ticked —
 * shared by every email send site (booking confirmation, resend, the
 * day-before reminder) so "does this visit's pack have anything worth
 * mentioning" is decided identically everywhere, not re-derived three
 * slightly-different ways.
 *
 * Schedule's own "ticked or not" state is KEY PRESENCE, not a boolean
 * value — see DocumentPackChoices.schedule_categories's own doc
 * comment for the full three-state encoding this deliberately checks
 * via `"schedule_categories" in pack` (NOT `pack.schedule_categories
 * !== null`, which would incorrectly treat "Schedule ticked, full
 * schedule chosen" — a real, active choice, encoded as `null` — as
 * "nothing to mention").
 */
export function hasAnyDocumentPackChoice(pack: DocumentPackChoices | null | undefined): boolean {
  if (!pack) return false;
  return pack.include_plans || pack.include_sow || "schedule_categories" in pack;
}

/**
 * BUILD-SPEC.md item 4's exact one-liner — "Plans, your schedule and
 * the scope of works are on your booking page" — kept warm/brief per
 * that item's own wording, and in ONE place so the three email send
 * sites (book-visit's immediate send, resend-confirmation, the
 * day-before reminder) can never drift on phrasing. Deliberately does
 * NOT vary its wording based on WHICH of the three choices is actually
 * ticked (e.g. "Plans and your schedule are..." for a pack with no
 * SOW) — BUILD-SPEC's own wording is the fixed, general-purpose line
 * regardless of the exact mix, and a trade opening their booking page
 * sees precisely which rows are actually present in the DOCUMENTS
 * section itself; this line is a heads-up in the email body, not a
 * literal inventory.
 */
export function documentPackMentionLine(): string {
  return "Plans, your schedule and the scope of works are on your booking page.";
}
