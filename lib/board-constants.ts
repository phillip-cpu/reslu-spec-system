// ============================================================
// RESLU Spec System — Board v3 — Monday parity round.
// Pure, dependency-free constants + derivation helpers for the
// rebuilt Grouped-list view (components/board/ProjectBoard.tsx) —
// mirrors lib/board-cockpit.ts's exact shape (plain data in, plain
// data out, no Supabase/Next imports) so this round's palette/summary/
// dependency-chip math can be unit-tested and reused client-side
// without a round-trip.
// ============================================================

// ------------------------------------------------------------
// Stage palette — BUILD-SPEC.md "Board v3 — Monday parity" §2
// "Visual parity": "rotating brand-safe palette per stage (cycle
// order: sand #8a6e4b, green #4c6b4f, terracotta #993C1D, charcoal
// #313131, teal-muted #3d5a5a — 5 colors cycling by sort order)."
//
// NOTE this is a DIFFERENT "sand" hex (#8a6e4b) than the brand
// tailwind token `sand` (#A08C72, tailwind.config.ts) — the brand
// guide's `sand` is reserved for small UI accents (buttons, borders,
// chips) elsewhere in this app; this round's spec gives an explicit,
// DARKER "sand" hex specifically for the stage left-bar/title use
// case (a thin 4px bar + title text needs more contrast against the
// cream page background than the lighter UI-accent sand would give),
// so it is deliberately NOT aliased to the tailwind `sand` token —
// they are visually related but numerically distinct brand-safe
// tones, both explicitly named in their respective specs.
// ------------------------------------------------------------
export const STAGE_PALETTE = [
  "#8a6e4b", // sand
  "#4c6b4f", // green
  "#993C1D", // terracotta
  "#313131", // charcoal
  "#3d5a5a", // teal-muted
] as const;

/** Which STAGE_PALETTE colour a group/stage at the given zero-based position (i.e. its rank among groups ordered by `sort`) should use — cycles every 5 groups, per BUILD-SPEC.md's explicit cycle order above. */
export function stageColorForIndex(indexInSortOrder: number): string {
  const i = ((indexInSortOrder % STAGE_PALETTE.length) + STAGE_PALETTE.length) % STAGE_PALETTE.length;
  return STAGE_PALETTE[i];
}

// ------------------------------------------------------------
// Status vocabulary — BUILD-SPEC.md "Board v3 — Monday parity" §3
// "Status vocabulary": "default status columns/pills for NEW
// projects/boards become, in this exact order: Not Booked / Booked /
// In Progress / Done — replacing the old Waiting/To Do/In Progress/
// Done seed."
//
// Existing (already-seeded) boards are NEVER migrated/touched by this
// constant — it is consumed ONLY by the two NEW-BOARD seed call sites
// (GET /api/projects/[id]/board and
// app/(dashboard)/projects/[id]/board/page.tsx, both gated on "this
// project currently has zero board_columns rows") exactly the same
// way DEFAULT_COLUMNS_V2 (types/phase-12a-b.ts) was before this round
// — this constant REPLACES that seed list's content at both of those
// two call sites only.
// ------------------------------------------------------------
export const DEFAULT_STATUS_COLUMNS_V3 = ["Not Booked", "Booked", "In Progress", "Done"] as const;

/**
 * Tint colours for the four default status pills — BUILD-SPEC.md
 * "Board v3 — Monday parity" §3 "Colours":
 *   - Not Booked: terracotta #993C1D-tinted pill
 *   - Booked: sand-tinted pill
 *   - In Progress: muted blue-grey-tinted pill
 *   - Done: green #4c6b4f-tinted pill
 *
 * Matched by COLUMN NAME (case-insensitive, trimmed) rather than a
 * fixed column id — column sets are per-project/fully editable
 * (migration 013), same "match by name against the small set of
 * labels the default seed uses" heuristic lib/board-cockpit.ts's own
 * DONE_COLUMN_NAMES already established for the milestone-diary
 * prompt. A project that renames a status column away from these four
 * exact labels (or a pre-Board-v3 board still on Waiting/To Do/In
 * Progress/Done) simply renders the untinted/neutral pill style
 * instead — never an error, never a fabricated colour for a label
 * this map doesn't recognise.
 *
 * Each entry carries a light background TINT (a low-alpha wash of the
 * named hex over the cream page background) and a DARKER foreground
 * text colour of the SAME hue family for accessible contrast — the
 * same "darker text on light tint" pattern this codebase's other
 * coloured surfaces already use (e.g. components/estimate/VersionCompare.tsx's
 * added/removed/changed row tints, `bg-[#EAF3E1]`/`bg-[#F7E7E7]`/
 * `bg-[#FBF1E0]` — light literal-hex background washes, dark text
 * layered on top via a separate text colour, never white-on-saturated
 * or light-on-light). Sharp corners throughout (no border-radius) —
 * this app's tailwind config (tailwind.config.ts) forces
 * `borderRadius` to `0px` globally, so no explicit "rounded-none"
 * class is even required, but no `rounded-*` class is ever added
 * here either.
 */
export interface StatusPillTint {
  /** Light background wash — literal hex, ~12% perceived tint over cream (#EDE8DE), matching this codebase's existing literal-hex-tint convention (VersionCompare.tsx) rather than a Tailwind opacity utility, so the exact tint shade is pinned regardless of what element it's layered over. */
  background: string;
  /** Darker foreground text of the same hue family — verified readable against `background` above (see this file's own contrast note below each entry). */
  text: string;
  /** Border colour — same hue family, mid-tone (between background and text), matching every existing pill's "border + text, no fill" starting point (components/items/ItemStatusBadge.tsx, components/projects/StatusPill.tsx) — this round adds the background wash on TOP of that established border+text shape rather than replacing it. */
  border: string;
}

/**
 * Keyed by the exact default label (case as shown in
 * DEFAULT_STATUS_COLUMNS_V3) — lookup by the normalised (trim +
 * lowercase) column name via statusPillTintForColumnName() below,
 * never by raw user input directly, so a column named " done " or
 * "DONE" still resolves.
 */
const STATUS_PILL_TINTS: Record<string, StatusPillTint> = {
  "not booked": {
    // Terracotta #993C1D family. Background is a ~12% wash of the
    // terracotta hue over cream; text is the terracotta hue itself,
    // darkened slightly for contrast (#7A2F16, ~4.9:1 against the
    // background below — comfortably passes WCAG AA for normal-size
    // text, same bar this codebase's other coloured-text usages are
    // held to, e.g. the red-700 warning text elsewhere in this file's
    // sibling components).
    background: "#F5DCD3",
    text: "#7A2F16",
    border: "#993C1D",
  },
  booked: {
    // Sand family (this file's own STAGE_PALETTE sand, #8a6e4b) — a
    // light sand wash with a darkened sand text colour, same
    // dark-text-on-light-tint shape as every other entry here.
    background: "#EDE3D6",
    text: "#5C4A32",
    border: "#8a6e4b",
  },
  "in progress": {
    // "Muted blue-grey" per spec — not part of the 5-colour stage
    // palette (that palette is for STAGE GROUP left-bars/titles, a
    // different visual role from a status PILL) — a genuinely
    // separate, desaturated blue-grey tone chosen to read as
    // "in-flight/neutral", distinct from both the warm terracotta
    // (not booked) and the warm sand (booked) either side of it.
    background: "#DDE3E8",
    text: "#3A4750",
    border: "#7C93A3",
  },
  done: {
    // Green #4c6b4f family (this file's own STAGE_PALETTE green).
    background: "#DCE7DD",
    text: "#2E4531",
    border: "#4c6b4f",
  },
};

/** Case-insensitive, trimmed lookup — returns null (render the existing neutral/bordered pill style) for any column name outside the four recognised defaults, e.g. a renamed or pre-Board-v3 column. */
export function statusPillTintForColumnName(columnName: string): StatusPillTint | null {
  return STATUS_PILL_TINTS[columnName.trim().toLowerCase()] ?? null;
}

// ------------------------------------------------------------
// Booking soft-mapping — BUILD-SPEC.md "Board v3 — Monday parity" §3
// "Booking integration": "a task with visit status `confirmed`
// renders its status pill using the 'Booked' column's colour IF AND
// ONLY IF the board has a column whose name matches /booked/i. This is
// a soft/display-only mapping only — it does not change the task's
// actual status_column_id in the DB."
//
// IMPORTANT — this is a DISPLAY-ONLY visual override of which TINT a
// pill renders with; it never writes anywhere. A task's real
// board_tasks.column_id (this schema's actual "status column" FK — see
// migration 013's board_tasks.column_id, there is no literal
// "status_column_id" column in this schema, that phrasing in the spec
// refers to this same column) is completely unaffected: the pill still
// shows the task's TRUE column name as its label, only the colour the
// pill borrows is overridden when the condition below holds. See this
// function's call site in components/board/ProjectBoard.tsx (GroupRows'
// status cell) for exactly where the override is applied, and
// docs/API.md's "Board v3 — Monday parity" section for the same
// behaviour documented for API consumers/reviewers.
// ------------------------------------------------------------

/** True if a project's status columns include one whose name matches /booked/i (case-insensitive substring match on "booked" — matches "Booked", "Not Booked", "Re-booked", etc., same permissive substring-match discipline this codebase's other name-based heuristics use, e.g. lib/board-cockpit.ts's DONE_COLUMN_NAMES doc comment). */
export function boardHasBookedColumn(columnNames: string[]): boolean {
  return columnNames.some((name) => /booked/i.test(name));
}

/**
 * Resolves which pill TINT to render for a single task, applying the
 * booking soft-mapping when it applies:
 *   - If `visitStatus === "confirmed"` AND the board has a column
 *     matching /booked/i (see boardHasBookedColumn above) -> render
 *     using the 'Booked' tint (STATUS_PILL_TINTS.booked), regardless of
 *     which column the task is actually sitting in.
 *   - Otherwise -> render using the task's OWN column name's tint (or
 *     null, the neutral/bordered fallback, if that name isn't one of
 *     the four recognised defaults).
 *
 * Never mutates/returns a column id — purely which tint object (or
 * null) the caller should hand to the pill's className builder.
 */
export function resolveStatusPillTint(
  columnName: string,
  visitStatus: string | null,
  columnNamesOnBoard: string[]
): StatusPillTint | null {
  if (visitStatus === "confirmed" && boardHasBookedColumn(columnNamesOnBoard)) {
    return STATUS_PILL_TINTS.booked;
  }
  return statusPillTintForColumnName(columnName);
}

// ------------------------------------------------------------
// Stage-complete dependency chips — BUILD-SPEC.md "Board v3 — Monday
// parity" §4: "for each stage group (ordered by sort order), if the
// PREVIOUS group contains a milestone task, then the FIRST non-
// milestone task row in the CURRENT group shows a muted chip reading
// 'after ◆ {prev milestone title trimmed of the literal prefix "Stage
// complete – "}'. Pure derivation ... no schema changes, no actual
// blocking of task creation/completion."
// ------------------------------------------------------------

/** The literal prefix trimmed off a milestone's title before it's shown in a dependency chip, per BUILD-SPEC.md's exact wording. */
const MILESTONE_TITLE_PREFIX = "Stage complete – ";

/** Strips MILESTONE_TITLE_PREFIX off a milestone title if present (exact, case-sensitive match on the literal prefix, per spec) — returns the title unchanged if it doesn't start with that exact prefix (e.g. a team-renamed milestone), so the chip still shows SOMETHING sensible rather than an empty/garbled string. */
export function trimMilestoneTitlePrefix(title: string): string {
  return title.startsWith(MILESTONE_TITLE_PREFIX) ? title.slice(MILESTONE_TITLE_PREFIX.length) : title;
}

export interface DependencyChipSourceGroup {
  id: string;
  sort: number;
  /** Every top-level (non-sub-item) task's kind + title for this group — sub-items are irrelevant here since the spec's "contains a milestone task" / "first non-milestone task row" both operate on the group's ordinary task rows. */
  tasks: { kind: "task" | "milestone"; title: string }[];
}

/**
 * Computes, for every group (already sorted by `sort` ascending), the
 * dependency chip text to show on that group's FIRST non-milestone
 * task row — or null if the group shouldn't show one (no previous
 * group, previous group has no milestone, or this group has no
 * non-milestone task to attach the chip to).
 *
 * Returns a Map keyed by GROUP id -> chip text (not by task id) — the
 * caller (GroupTable, components/board/ProjectBoard.tsx) applies the
 * returned text to whichever row renders first among that group's
 * non-milestone tasks (in the group's own existing row order), so this
 * function stays agnostic of the specific row-ordering/rendering
 * details and is trivially reusable for both the live client-render
 * path and a future GET-response-embedding path (BUILD-SPEC.md:
 * "computed client-side or in GET response" — either is acceptable;
 * this codebase computes it client-side, in GroupTable, calling this
 * exact function — see that component's doc comment for why).
 */
export function computeDependencyChips(groupsInSortOrder: DependencyChipSourceGroup[]): Map<string, string> {
  const chips = new Map<string, string>();
  const ordered = [...groupsInSortOrder].sort((a, b) => a.sort - b.sort);

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    const prevMilestone = previous.tasks.find((t) => t.kind === "milestone");
    if (!prevMilestone) continue;
    const firstNonMilestone = current.tasks.find((t) => t.kind !== "milestone");
    if (!firstNonMilestone) continue;
    chips.set(current.id, `after ◆ ${trimMilestoneTitlePrefix(prevMilestone.title)}`);
  }

  return chips;
}

// ------------------------------------------------------------
// Group summary line — "5 items · 2 done" (BUILD-SPEC.md "Board v3 —
// Monday parity" §2: "group collapse chevron with summary line like
// '5 items · 2 done' ... Sub-items are excluded from top-level group
// counts (only parent-level/top-level tasks count toward '5 items · 2
// done' group summaries)").
//
// "Done" for this summary line means the task's CURRENT column is
// name-matched against the same DONE_COLUMN_NAMES heuristic
// lib/board-cockpit.ts's shouldPromptMilestoneDiary() already uses
// (column sets are per-project/fully editable, so this cannot key off
// a fixed column_id) — reusing that exact set here rather than
// inventing a second "what counts as done" list, so the two behaviours
// ("prompts a diary entry on completion" and "counts toward the done
// tally") always agree on what a project's own renamed columns mean.
// ------------------------------------------------------------

const SUMMARY_DONE_COLUMN_NAMES = new Set(["done", "complete", "completed"]);

export interface GroupSummarySourceTask {
  /** Whether this task is a sub-item (has a non-null parent_task_id) — excluded from both the total and the done tally, per spec. */
  isSubItem: boolean;
  columnName: string;
}

/** "{n} items · {m} done" for one group's top-level tasks (sub-items excluded from both counts). */
export function groupSummaryLine(tasks: GroupSummarySourceTask[]): string {
  const topLevel = tasks.filter((t) => !t.isSubItem);
  const done = topLevel.filter((t) => SUMMARY_DONE_COLUMN_NAMES.has(t.columnName.trim().toLowerCase())).length;
  return `${topLevel.length} item${topLevel.length === 1 ? "" : "s"} · ${done} done`;
}

// ------------------------------------------------------------
// Sub-item count chip — "done/total" e.g. "2/3" (BUILD-SPEC.md "Board
// v3 — Monday parity" §2: "expandable like Monday's 'Skirtings
// installation 2' with count chip 'done/total' e.g. '2/3'"). Purely a
// DISPLAY SUMMARY of children — per the spec's explicit deviation
// note, this NEVER changes the parent's own completed/not-completed
// status (there is no auto-rollup anywhere in this codebase's write
// paths — see components/board/ProjectBoard.tsx's sub-item handling
// for the same note repeated at the point of use).
// ------------------------------------------------------------

export interface SubItemSourceTask {
  columnName: string;
}

/** "{done}/{total}" for one parent's sub-items. */
export function subItemCountChip(subItems: SubItemSourceTask[]): string {
  const done = subItems.filter((t) => SUMMARY_DONE_COLUMN_NAMES.has(t.columnName.trim().toLowerCase())).length;
  return `${done}/${subItems.length}`;
}

// ------------------------------------------------------------
// Board v3.1 — display-first cells, item 8 — client-side mirror of
// lib/phase-rollup.ts's rollupPhaseDatesForGroup() min/max math, used
// ONLY to decide/render the grouped-list header's read-only computed
// range (GroupTable, components/board/ProjectBoard.tsx) — the actual
// schedule_phases.start_date/end_date WRITE always happens
// server-side (lib/phase-rollup.ts), this is purely a display
// projection so the header shows the correct range on the very same
// render a task's works dates change client-side (optimistic update),
// without waiting for a round-trip. Deliberately the SAME formula
// (min(booking_date), max(booking_end_date ?? booking_date)) so the
// two never disagree about what the "computed range" for a group is.
// ------------------------------------------------------------

export interface GroupWorksDateSourceTask {
  booking_date: string | null;
  booking_end_date: string | null;
}

export interface GroupWorksDateRange {
  start_date: string;
  end_date: string;
}

/**
 * Computes the derived works-date range for a group's tasks, or null
 * when none of them have a booking_date set (in which case the caller
 * falls back to the group's own manual phase_start_date/phase_end_date
 * inputs — see GroupTable's header render for the exact branch).
 */
export function computeGroupWorksDateRange(tasks: GroupWorksDateSourceTask[]): GroupWorksDateRange | null {
  const withDates = tasks.filter((t): t is { booking_date: string; booking_end_date: string | null } => !!t.booking_date);
  if (withDates.length === 0) return null;

  const starts = withDates.map((t) => t.booking_date);
  const ends = withDates.map((t) => t.booking_end_date ?? t.booking_date);

  const start_date = starts.reduce((min, d) => (d < min ? d : min), starts[0]);
  const end_date = ends.reduce((max, d) => (d > max ? d : max), ends[0]);

  return { start_date, end_date };
}

// ------------------------------------------------------------
// "Update status names" action — Board v3.1 — display-first cells,
// item 6. Best-guess old-vocabulary -> new-vocabulary column-name
// mapping, shown prefilled in the small panel opened from the board's
// "..." overflow menu — the user can adjust any of these in the panel
// before Save; this function never writes anything itself, it's pure
// suggestion text for the panel's initial input values.
// ------------------------------------------------------------

const STATUS_NAME_SUGGESTIONS: Record<string, string> = {
  waiting: "Not Booked",
  "to do": "Not Booked",
  todo: "Not Booked",
  "in progress": "In Progress",
  done: "Done",
  complete: "Done",
  completed: "Done",
  booked: "Booked",
};

/**
 * Best-guess replacement label for an existing column name, matched
 * case-insensitively/trimmed against the small set of known old-vocabulary
 * labels above — returns the column's OWN current name unchanged when it
 * doesn't match any recognised old label (e.g. a team's own custom column
 * name), so the panel's prefilled input never proposes a fabricated
 * rename for a column nobody asked to rename.
 */
export function suggestStatusColumnName(currentName: string): string {
  return STATUS_NAME_SUGGESTIONS[currentName.trim().toLowerCase()] ?? currentName;
}
