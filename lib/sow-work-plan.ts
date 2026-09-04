import type { SowWorkPlanSuggestion } from "@/types/sow-work-plan";

export interface SowWorkPlanSourceLine {
  id: string;
  text: string;
  kind: "inclusion" | "exclusion" | "note";
  trade: string | null;
}

export interface SowWorkPlanSourceSection {
  id: string;
  heading: string;
  lines: SowWorkPlanSourceLine[];
}

export interface SowWorkPlanPhase {
  group_id: string;
  name: string;
  sort: number;
}

export interface ExistingSowWorkTask {
  id: string;
  title: string;
  phase_group_id: string | null;
  trade_role: string | null;
  sow_work_key: string | null;
  sow_revision_id: string | null;
  linked_sow_line_ids: string[];
}

export interface SowWorkPlanContactAssignment {
  trade_role: string;
  contact_name: string | null;
}

export interface BuildSowWorkPlanInput {
  sowId: string;
  sections: SowWorkPlanSourceSection[];
  phases: SowWorkPlanPhase[];
  existingTasks: ExistingSowWorkTask[];
  assignments?: SowWorkPlanContactAssignment[];
}

export interface BuildSowWorkPlanResult {
  suggestions: SowWorkPlanSuggestion[];
  scopeInclusionCount: number;
  includedLineCount: number;
  untaggedInclusionCount: number;
}

type PhaseRule = { when: RegExp; phases: RegExp[] };

// Specific clause language wins before broad trade defaults. The patterns
// intentionally target the editable Timeline vocabulary rather than fixed
// phase ids, so new-build and renovation templates both resolve correctly.
const LINE_PHASE_RULES: PhaseRule[] = [
  { when: /\b(?:site establishment|site protection|temporary services?|site fencing|amenities)\b/i, phases: [/site establishment|site setup/i] },
  { when: /\b(?:demolish|demolition|strip[- ]?out|remove and dispose)\b/i, phases: [/demolition|strip out|opening works/i] },
  { when: /\b(?:earthworks?|excavat|footings?|slabs?|foundations?)\b/i, phases: [/earthworks|footings|base/i, /structural|framing/i] },
  { when: /\b(?:structural|wall framing|roof framing|stud wall|timber stud|steel stud|steel installation)\b/i, phases: [/structural|framing/i] },
  { when: /\b(?:roofing|sarking|cladding|brickwork|external windows?|external doors?)\b/i, phases: [/external envelope/i, /external works/i] },
  { when: /\b(?:rough[- ]?in|prewire|in-wall|service relocation|run cabling|run pipe)\b/i, phases: [/service(?:s)? rough in|rough[- ]?in/i] },
  { when: /\b(?:insulation|plasterboard|set and sand|screed|waterproof)\b/i, phases: [/internal linings|waterproof/i] },
  { when: /\b(?:wall tiling|floor tiling|floor finishes?|flooring installation|architectural coatings?)\b/i, phases: [/internal finishes|tiling/i] },
  { when: /\b(?:joinery|cabinetry|benchtop|stone)\b/i, phases: [/joinery|fixed elements/i, /fit[- ]?off/i] },
  { when: /\b(?:fit[- ]?off|install and connect|sanitaryware|tapware|appliances?|shower screen|door hardware)\b/i, phases: [/fit[- ]?off/i] },
  { when: /\b(?:paint|painting|final detail|caulking|sealing)\b/i, phases: [/painting|final detail/i, /fit[- ]?off/i] },
  { when: /\b(?:landscap|paving|pool fence|external works?)\b/i, phases: [/external works/i] },
  { when: /\b(?:practical completion|defects?|client inspection)\b/i, phases: [/practical completion/i] },
  { when: /\b(?:handover|close out|closeout|project archive)\b/i, phases: [/handover|close out/i] },
];

const TRADE_PHASE_DEFAULTS: Record<string, RegExp[]> = {
  demolition: [/demolition|strip out|opening works/i],
  electrician: [/service(?:s)? rough in|rough[- ]?in/i, /fit[- ]?off/i],
  plumber: [/service(?:s)? rough in|rough[- ]?in/i, /fit[- ]?off/i],
  tiler: [/internal finishes|tiling/i, /internal linings|waterproof/i],
  joiner: [/joinery|fixed elements/i, /fit[- ]?off/i],
  carpenter: [/structural|framing/i, /fit[- ]?off/i],
  painter: [/painting|final detail/i, /fit[- ]?off/i],
  plasterer: [/internal linings/i, /waterproof|tiling/i, /fit[- ]?off/i],
  glazier: [/fit[- ]?off/i, /external envelope/i],
  stonemason: [/joinery|fixed elements/i, /fit[- ]?off/i],
  "caulking & sealing": [/painting|final detail/i, /fit[- ]?off/i],
  "site & earthworks": [/earthworks|footings|base/i, /external works/i, /site establishment/i],
  "concrete & foundations": [/earthworks|footings|base/i, /structural|framing/i],
  structural: [/structural|framing/i, /earthworks|footings|slab|base/i, /fit[- ]?off/i],
};

const TRADE_TASK_KEYWORDS: Record<string, RegExp> = {
  demolition: /demol|strip[- ]?out/i,
  electrician: /electric|lighting|data|security/i,
  plumber: /plumb|sanitary|tapware|drainage/i,
  tiler: /til(?:e|ing)|waterproof/i,
  joiner: /joiner|joinery|cabinet/i,
  carpenter: /carpent|framing|skirting|architrave/i,
  painter: /paint|decorat/i,
  plasterer: /plaster|lining|flushing|cornice/i,
  glazier: /glaz|glass|shower screen/i,
  stonemason: /stone|benchtop/i,
  "caulking & sealing": /caulk|seal/i,
  "site & earthworks": /site|earthwork|excavat/i,
  "concrete & foundations": /concrete|footing|slab|foundation/i,
  structural: /structural|framing|steel|portal/i,
};

function normalise(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function canonicalTradeKey(value: string): string {
  const trade = normalise(value);
  if (/electric/.test(trade)) return "electrician";
  if (/plumb/.test(trade)) return "plumber";
  if (/til(?:e|ing)/.test(trade)) return "tiler";
  if (/join|cabinet/.test(trade)) return "joiner";
  if (/carpent/.test(trade)) return "carpenter";
  if (/paint|decorat/.test(trade)) return "painter";
  if (/plaster|flush|cornice|lining/.test(trade)) return "plasterer";
  if (/glaz|glass/.test(trade)) return "glazier";
  if (/stone|benchtop/.test(trade)) return "stonemason";
  if (/caulk|seal/.test(trade)) return "caulking & sealing";
  if (/site|earthwork|excavat/.test(trade)) return "site & earthworks";
  if (/concrete|foundation|footing|slab/.test(trade)) return "concrete & foundations";
  if (/structural|steel/.test(trade)) return "structural";
  if (/demol|strip[- ]?out/.test(trade)) return "demolition";
  return trade;
}

function clauseLabel(value: string): string | null {
  const match = /^([A-Z][A-Z0-9 &'/]{1,48}?)\s*(?:—|–|-{1,2}|:)\s+/.exec(value.trim());
  return match?.[1]?.trim() ?? null;
}

function keyPart(value: string): string {
  return normalise(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function suggestionFingerprint(parts: string[]): string {
  // Small deterministic FNV-1a fingerprint. This is change detection rather
  // than cryptographic authentication: POST recomputes it from authoritative
  // database rows and rejects a same-key preview whose scope changed.
  let hash = 0x811c9dc5;
  for (const character of [...parts].sort().join("\u001f")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function matchingPhase(phases: SowWorkPlanPhase[], patterns: RegExp[]): SowWorkPlanPhase | null {
  const ordered = [...phases].sort((a, b) => a.sort - b.sort);
  for (const pattern of patterns) {
    const match = ordered.find((phase) => pattern.test(phase.name));
    if (match) return match;
  }
  return null;
}

export function suggestSowWorkPhase(
  lineText: string,
  tradeRole: string,
  phases: SowWorkPlanPhase[]
): SowWorkPlanPhase | null {
  const tradeKey = canonicalTradeKey(tradeRole);
  const tradeDefaults = TRADE_PHASE_DEFAULTS[tradeKey] ?? [];

  // These specialist role tags are a stronger scheduling signal than an
  // incidental material word in free text (for example a Painter clause that
  // mentions plasterboard preparation, or a Tiler clause that mentions nearby
  // joinery). They retain their trade-stage default unless the project simply
  // has no matching phase.
  if ([
    "demolition",
    "tiler",
    "joiner",
    "painter",
    "plasterer",
    "glazier",
    "stonemason",
    "caulking & sealing",
    "site & earthworks",
    "concrete & foundations",
    "structural",
  ].includes(tradeKey)) {
    const specialistPhase = matchingPhase(phases, tradeDefaults);
    if (specialistPhase) return specialistPhase;
  }

  // A structured all-caps clause label is deliberate metadata; resolve it
  // before scanning the free-text body, where incidental words are common.
  const label = clauseLabel(lineText);
  if (label) {
    for (const rule of LINE_PHASE_RULES) {
      if (!rule.when.test(label)) continue;
      const phase = matchingPhase(phases, rule.phases);
      if (phase) return phase;
    }
  }
  for (const rule of LINE_PHASE_RULES) {
    if (!rule.when.test(lineText)) continue;
    const phase = matchingPhase(phases, rule.phases);
    if (phase) return phase;
  }
  return matchingPhase(phases, tradeDefaults);
}

function compactPhaseName(name: string): string {
  return name.replace(/^stage\s+\d+\s*[–—-]\s*/i, "").trim();
}

function taskMatchesTrade(task: ExistingSowWorkTask, tradeRole: string): boolean {
  if (task.trade_role && normalise(task.trade_role) === normalise(tradeRole)) return true;
  const keyword = TRADE_TASK_KEYWORDS[canonicalTradeKey(tradeRole)];
  return keyword ? keyword.test(task.title) : false;
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function findExistingTask(
  key: string,
  phaseGroupId: string | null,
  tradeRole: string,
  tasks: ExistingSowWorkTask[]
): ExistingSowWorkTask | null {
  const keyed = tasks.find((task) => task.sow_work_key === key);
  if (keyed) return keyed;

  const candidates = tasks.filter(
    (task) => task.phase_group_id === phaseGroupId && taskMatchesTrade(task, tradeRole)
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Builds a deliberately review-first work plan. Room clauses are rolled up by
 * trade and phase so a detailed SOW does not create hundreds of board cards.
 * Existing task content is never changed here; the returned state tells the UI
 * whether applying the suggestion will create, link, refresh or do nothing.
 */
export function buildSowWorkPlan(input: BuildSowWorkPlanInput): BuildSowWorkPlanResult {
  const groups = new Map<
    string,
    {
      tradeRole: string;
      phase: SowWorkPlanPhase | null;
      lineIds: string[];
      linePreviews: string[];
      sectionHeadings: Set<string>;
      fingerprintParts: string[];
    }
  >();
  let scopeInclusionCount = 0;
  let untaggedInclusionCount = 0;

  for (const section of input.sections) {
    for (const line of section.lines) {
      if (line.kind !== "inclusion" || !line.text.trim()) continue;
      scopeInclusionCount += 1;
      const tradeRole = line.trade?.trim() || null;
      if (!tradeRole) {
        untaggedInclusionCount += 1;
        continue;
      }
      const phase = suggestSowWorkPhase(line.text, tradeRole, input.phases);
      const key = `sow:${phase?.group_id ?? "unplanned"}:${keyPart(tradeRole)}`;
      const group = groups.get(key) ?? {
        tradeRole,
        phase,
        lineIds: [],
        linePreviews: [],
        sectionHeadings: new Set<string>(),
        fingerprintParts: [],
      };
      group.lineIds.push(line.id);
      if (group.linePreviews.length < 3) group.linePreviews.push(line.text.trim());
      group.sectionHeadings.add(section.heading.trim());
      group.fingerprintParts.push(
        [section.id, section.heading, line.id, line.kind, tradeRole, line.text].join("\u001e")
      );
      groups.set(key, group);
    }
  }

  const assignmentByRole = new Map(
    (input.assignments ?? []).map((assignment) => [normalise(assignment.trade_role), assignment])
  );

  const suggestions = [...groups.entries()].map(([key, group]): SowWorkPlanSuggestion => {
    const existing = findExistingTask(
      key,
      group.phase?.group_id ?? null,
      group.tradeRole,
      input.existingTasks
    );
    const lineIds = [...new Set(group.lineIds)].sort();
    let state: SowWorkPlanSuggestion["state"] = "create";
    if (existing) {
      if (
        existing.sow_work_key === key &&
        existing.sow_revision_id === input.sowId &&
        sameIds(existing.linked_sow_line_ids, lineIds)
      ) {
        state = "current";
      } else if (existing.sow_work_key === key) {
        state = "refresh";
      } else {
        state = "link";
      }
    }
    const phaseLabel = group.phase ? compactPhaseName(group.phase.name) : "Needs phase";
    const assignment = assignmentByRole.get(normalise(group.tradeRole));
    return {
      key,
      fingerprint: suggestionFingerprint([key, ...group.fingerprintParts]),
      title: `${group.tradeRole} — ${phaseLabel}`,
      trade_role: group.tradeRole,
      phase_group_id: group.phase?.group_id ?? null,
      phase_name: group.phase?.name ?? null,
      line_ids: lineIds,
      line_previews: group.linePreviews,
      section_headings: [...group.sectionHeadings].filter(Boolean).sort((a, b) => a.localeCompare(b)),
      existing_task_id: existing?.id ?? null,
      existing_task_title: existing?.title ?? null,
      assigned_contact_name: assignment?.contact_name ?? null,
      state,
    };
  });

  suggestions.sort((a, b) => {
    const phaseA = input.phases.find((phase) => phase.group_id === a.phase_group_id)?.sort ?? Number.MAX_SAFE_INTEGER;
    const phaseB = input.phases.find((phase) => phase.group_id === b.phase_group_id)?.sort ?? Number.MAX_SAFE_INTEGER;
    return phaseA - phaseB || a.trade_role.localeCompare(b.trade_role);
  });

  return {
    suggestions,
    scopeInclusionCount,
    includedLineCount: suggestions.reduce((sum, suggestion) => sum + suggestion.line_ids.length, 0),
    untaggedInclusionCount,
  };
}
