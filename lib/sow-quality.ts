import type {
  SowQualityFinding,
  SowQualityInput,
  SowQualityReport,
} from "@/types/sow-quality";

const PLACEHOLDER_PATTERN = /\{\{[^}]+\}\}/;
const SCOPE_CHECK_PATTERN = /^SCOPE CHECK\s*(?:—|–|-|:)/i;
const TBC_PATTERN = /\b(?:TBC|TBD|TO BE CONFIRMED|TO BE DETERMINED)\b/i;

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pure pre-issue assessment. It intentionally distinguishes hard
 * blockers (unfinished template content / structurally incomplete
 * scope) from review warnings (data that may legitimately be covered
 * by a broader clause or another drawing set).
 */
export function assessSowQuality(input: SowQualityInput): SowQualityReport {
  const blockers: SowQualityFinding[] = [];
  const warnings: SowQualityFinding[] = [];
  const allLines = input.sections.flatMap((section) =>
    section.lines.map((line) => ({ ...line, section }))
  );

  for (const section of input.sections) {
    const placeholderLines = section.lines.filter((line) => PLACEHOLDER_PATTERN.test(line.text));
    if (placeholderLines.length > 0) {
      blockers.push({
        code: "placeholder_lines",
        severity: "blocker",
        title: `${section.heading}: unfinished template wording`,
        detail: `${plural(placeholderLines.length, "line")} still contain {{placeholders}}. Replace the wording or remove the line before issue.`,
        section_id: section.id,
        line_ids: placeholderLines.map((line) => line.id),
      });
    }

    const scopeChecks = section.lines.filter((line) => SCOPE_CHECK_PATTERN.test(line.text));
    if (scopeChecks.length > 0) {
      blockers.push({
        code: "unresolved_scope_check",
        severity: "blocker",
        title: `${section.heading}: scope check outstanding`,
        detail: "Confirm the plan-only work described by the scope-check line, add the required trade work, then remove that line.",
        section_id: section.id,
        line_ids: scopeChecks.map((line) => line.id),
      });
    }

    if (section.source_room_id) {
      const allocations = input.allocations.filter(
        (allocation) => allocation.room_id === section.source_room_id
      );
      if (section.lines.length === 0) {
        const suffix = allocations.length > 0
          ? ` even though ${plural(allocations.length, "FF&E item")} ${allocations.length === 1 ? "is" : "are"} assigned to it`
          : "";
        blockers.push({
          code: "empty_room",
          severity: "blocker",
          title: `${section.heading}: room scope is empty`,
          detail: `Add the room's scope or confirm that no work is required${suffix}.`,
          section_id: section.id,
          item_codes: allocations.map((allocation) => allocation.item_code),
        });
      }

      const untaggedInclusions = section.lines.filter(
        (line) => line.kind === "inclusion" && !line.trade?.trim()
      );
      if (untaggedInclusions.length > 0) {
        blockers.push({
          code: "untagged_inclusions",
          severity: "blocker",
          title: `${section.heading}: inclusions need a trade`,
          detail: `${plural(untaggedInclusions.length, "inclusion")} will be absent from every trade extract until assigned.`,
          section_id: section.id,
          line_ids: untaggedInclusions.map((line) => line.id),
        });
      }

      const hasRoomReference = section.lines.some((line) => /^ref(?:erence)?\s*:/i.test(line.text.trim()));
      if (section.lines.length > 0 && !hasRoomReference) {
        warnings.push({
          code: "missing_room_reference",
          severity: "warning",
          title: `${section.heading}: drawing reference not recorded`,
          detail: "Add a Ref: note identifying the applicable plan, detail or elevation.",
          section_id: section.id,
        });
      }
    }

    const unresolvedTbc = section.lines.filter(
      (line) => section.heading.trim().toLowerCase() !== "exclusions" && TBC_PATTERN.test(line.text)
    );
    if (unresolvedTbc.length > 0) {
      warnings.push({
        code: "unresolved_tbc",
        severity: "warning",
        title: `${section.heading}: confirmation still required`,
        detail: `${plural(unresolvedTbc.length, "line")} contain TBC/TBD wording.`,
        section_id: section.id,
        line_ids: unresolvedTbc.map((line) => line.id),
      });
    }

    const byText = new Map<string, typeof section.lines>();
    for (const line of section.lines) {
      const key = `${line.kind}|${line.trade ?? ""}|${normalise(line.text)}`;
      byText.set(key, [...(byText.get(key) ?? []), line]);
    }
    const duplicateGroups = [...byText.values()].filter((lines) => lines.length > 1);
    if (duplicateGroups.length > 0) {
      warnings.push({
        code: "duplicate_lines",
        severity: "warning",
        title: `${section.heading}: possible duplicate lines`,
        detail: `${plural(duplicateGroups.length, "repeated line group")} found.`,
        section_id: section.id,
        line_ids: duplicateGroups.flatMap((lines) => lines.map((line) => line.id)),
      });
    }
  }

  const sectionsByHeading = new Map<string, typeof input.sections>();
  for (const section of input.sections) {
    const key = normalise(section.heading);
    sectionsByHeading.set(key, [...(sectionsByHeading.get(key) ?? []), section]);
  }
  for (const duplicated of [...sectionsByHeading.values()].filter((sections) => sections.length > 1)) {
    blockers.push({
      code: "duplicate_section",
      severity: "blocker",
      title: `${duplicated[0].heading}: duplicate sections`,
      detail: `${plural(duplicated.length, "section")} have this heading. Merge or rename them before issue.`,
      section_id: duplicated[0].id,
    });
  }

  const referencedItemIds = new Set<string>();
  const referencedAllocations = new Set<string>();
  for (const allocation of input.allocations) {
    const code = allocation.item_code.trim();
    if (!code) continue;
    const roomSection = input.sections.find(
      (section) => section.source_room_id === allocation.room_id
    );
    const mentioned = (roomSection?.lines ?? []).some(({ text }) =>
      text.toLocaleLowerCase().includes(code.toLocaleLowerCase())
    );
    if (mentioned) {
      referencedItemIds.add(allocation.item_id);
      referencedAllocations.add(`${allocation.room_id}|${allocation.item_id}`);
    }
  }

  for (const room of input.rooms) {
    const allocations = input.allocations.filter((allocation) => allocation.room_id === room.id);
    const uncovered = allocations.filter(
      (allocation) => !referencedAllocations.has(`${allocation.room_id}|${allocation.item_id}`)
    );
    if (uncovered.length === 0) continue;
    const section = input.sections.find((candidate) => candidate.source_room_id === room.id);
    warnings.push({
      code: "uncovered_ffe_items",
      severity: "warning",
      title: `${room.name}: FF&E coverage to confirm`,
      detail: `${plural(uncovered.length, "assigned item")} ${uncovered.length === 1 ? "is" : "are"} not referenced by code in this room's scope. ${uncovered.length === 1 ? "It may" : "They may"} be supply-only or covered by a broader clause, but should be checked.`,
      section_id: section?.id,
      item_codes: uncovered.map((allocation) => allocation.item_code),
    });
  }

  const analysedFileIds = new Set(input.plan_analyses.map((analysis) => analysis.file_id));
  for (const file of input.plan_files) {
    if (analysedFileIds.has(file.id)) continue;
    warnings.push({
      code: "plan_not_analysed",
      severity: "warning",
      title: `${file.filename}: analysis not available`,
      detail: "This current plan upload has not been included in the automated cross-check.",
      plan_filename: file.filename,
    });
  }

  const seenPlanDiscrepancies = new Set<string>();
  for (const analysis of input.plan_analyses) {
    for (const discrepancy of analysis.discrepancies ?? []) {
      const key = `${discrepancy.kind}|${normalise(discrepancy.message)}`;
      if (seenPlanDiscrepancies.has(key)) continue;
      seenPlanDiscrepancies.add(key);
      warnings.push({
        code: "plan_discrepancy",
        severity: "warning",
        title: `${analysis.filename}: plan/register discrepancy`,
        detail: discrepancy.message,
        item_codes: discrepancy.item_codes,
        plan_filename: analysis.filename,
        discrepancy,
      });
    }
  }

  return {
    ready_to_issue: blockers.length === 0,
    checked_at: new Date().toISOString(),
    blockers,
    warnings,
    summary: {
      sections: input.sections.length,
      lines: allLines.length,
      active_rooms: input.rooms.length,
      assigned_ffe_items: new Set(input.allocations.map((allocation) => allocation.item_id)).size,
      referenced_ffe_items: referencedItemIds.size,
      analysed_plan_files: input.plan_analyses.length,
    },
  };
}
