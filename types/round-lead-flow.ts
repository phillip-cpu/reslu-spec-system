// ============================================================
// RESLU Spec System — Lead flow round (migration 048)
// docs/RESLU-lead-flow-brief.md: the designer-built "paper card"
// client journey (real visit-confirmation.html / visit-reminder.html
// templates + the project-brief.html pre-visit questionnaire) wired
// into the r15 site-visit-emails machinery.
//
// Kept in its own file per this codebase's house convention of one
// types/round-*.ts file per round rather than editing types/index.ts
// (protected — out of this round's edit boundary; see e.g.
// types/visit-emails.ts / types/cpd.ts for the same pattern from prior
// rounds).
// ============================================================

import type { Lead } from "@/types";

/** New `leads` columns, migration 048_lead_brief.sql. */
export interface LeadBriefFields {
  brief_token: string | null;
  brief_answers: BriefAnswers | null;
  brief_submitted_at: string | null;
  visit_ics_sequence: number;
}

/**
 * `Lead` (types/index.ts, protected) widened with this round's new
 * columns — a type-only cast, not a runtime shape change (every new
 * column round-trips through `select("*")` on `leads` like any other
 * column already on that type). Used wherever a component/route
 * already carries a plain `Lead` and needs the new fields too — e.g.
 * LeadDetailPanel's "Project brief" section, the PATCH route's
 * SEQUENCE-increment logic.
 */
export type LeadWithBriefFields = Lead & LeadBriefFields;

/**
 * The 10 fields emails/brief/project-brief.html's <form> posts,
 * verbatim field names (docs/RESLU-lead-flow-brief.md build task 2) —
 * stored as-is in leads.brief_answers. `_previous_submitted_at` is an
 * internal bookkeeping key ONLY present after a re-submission
 * overwrites an earlier one (see POST /api/brief-submit/[token]'s own
 * doc comment) — the form itself never sends it.
 */
export interface BriefAnswers {
  first_name?: string;
  last_name?: string;
  hoping?: string;
  favourite_spaces?: string;
  materials?: string;
  feel?: string;
  must_1?: string;
  must_2?: string;
  must_3?: string;
  bringing?: string;
  _previous_submitted_at?: string;
}

/**
 * Field order + labels for LeadDetailPanel's read-only "Project brief"
 * render — mirrors emails/brief/project-brief.html's own question
 * order exactly.
 */
export const BRIEF_ANSWER_FIELDS: { key: keyof BriefAnswers; label: string }[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "hoping", label: "What are you hoping to build?" },
  { key: "favourite_spaces", label: "A space they love being in" },
  { key: "materials", label: "Materials they are drawn to" },
  { key: "feel", label: "What should the home feel like?" },
  { key: "must_1", label: "Must-have 1" },
  { key: "must_2", label: "Must-have 2" },
  { key: "must_3", label: "Must-have 3" },
  { key: "bringing", label: "Bringing along" },
];

/** POST /api/brief-submit/[token] response. */
export interface BriefSubmitResponse {
  ok: true;
}
