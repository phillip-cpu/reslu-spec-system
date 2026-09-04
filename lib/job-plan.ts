import type {
  BuildJobPlanInput,
  JobPlanActivityInput,
  JobPlanCostLineInput,
  JobPlanGroup,
  JobPlanItemInput,
  JobPlanModel,
  JobPlanQuotePackageInput,
  JobPlanThread,
  JobPlanTradeAssignmentInput,
  JobPlanView,
} from "@/types/job-plan";
import { suggestSowWorkPhase } from "./sow-work-plan.ts";

function normalise(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds only item codes that actually exist in this project. A drawing ref such
 * as A604 or BH01 is therefore never treated as FF&E merely because it looks
 * code-like. Boundaries are alphanumeric so SW-01 does not match SW-010.
 */
export function itemCodesInScopeText(
  text: string,
  items: JobPlanItemInput[]
): JobPlanItemInput[] {
  const upper = text.toLocaleUpperCase();
  return items.filter((item) => {
    const code = item.item_code.trim().toLocaleUpperCase();
    if (!code) return false;
    const pattern = new RegExp(`(^|[^A-Z0-9])${escapeRegExp(code)}(?=$|[^A-Z0-9])`);
    return pattern.test(upper);
  });
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function quotePackagesFor(
  itemIds: Set<string>,
  costLineIds: Set<string>,
  packages: JobPlanQuotePackageInput[]
): JobPlanQuotePackageInput[] {
  return packages.filter(
    (pack) =>
      pack.item_ids.some((id) => itemIds.has(id)) ||
      pack.line_ids.some((id) => costLineIds.has(id))
  );
}

function resolveContractor(
  trade: string | null,
  activities: JobPlanActivityInput[],
  assignments: JobPlanTradeAssignmentInput[]
): Pick<JobPlanThread, "contractor_company" | "contractor_source"> {
  const activityCompanies = [
    ...new Set(activities.map((activity) => activity.contractor_company).filter(Boolean)),
  ] as string[];
  if (activityCompanies.length === 1) {
    return { contractor_company: activityCompanies[0], contractor_source: "activity" };
  }
  if (activityCompanies.length > 1) {
    return { contractor_company: "Multiple contractors", contractor_source: "activity" };
  }
  if (!trade) return { contractor_company: null, contractor_source: null };
  const assignment = assignments.find(
    (candidate) => normalise(candidate.trade_role) === normalise(trade)
  );
  return assignment?.contractor_company
    ? { contractor_company: assignment.contractor_company, contractor_source: "trade_assignment" }
    : { contractor_company: null, contractor_source: null };
}

export function buildJobPlan(input: BuildJobPlanInput): JobPlanModel {
  const inclusionLines = input.scope_lines.filter((line) => line.kind === "inclusion");
  const activityById = new Map(input.activities.map((activity) => [activity.id, activity]));
  const taskIdsByLine = new Map<string, string[]>();
  for (const link of input.activity_scope_links) {
    const list = taskIdsByLine.get(link.sow_line_id) ?? [];
    list.push(link.task_id);
    taskIdsByLine.set(link.sow_line_id, list);
  }
  const requirementsByItem = new Map<string, BuildJobPlanInput["item_requirements"]>();
  for (const requirement of input.item_requirements) {
    const list = requirementsByItem.get(requirement.item_id) ?? [];
    list.push(requirement);
    requirementsByItem.set(requirement.item_id, list);
  }
  const costLinesByItem = new Map<string, JobPlanCostLineInput[]>();
  for (const line of input.cost_lines) {
    if (!line.item_id) continue;
    const list = costLinesByItem.get(line.item_id) ?? [];
    list.push(line);
    costLinesByItem.set(line.item_id, list);
  }

  const phaseSuggestions = input.phases.map((phase) => ({
    group_id: phase.id,
    name: phase.name,
    sort: phase.sort,
  }));
  const connections = inclusionLines.map((scopeLine) => {
    const activities = uniqueById(
      (taskIdsByLine.get(scopeLine.id) ?? [])
        .map((taskId) => activityById.get(taskId))
        .filter((row): row is JobPlanActivityInput => !!row)
    ).sort((a, b) => (a.phase_sort ?? Number.MAX_SAFE_INTEGER) - (b.phase_sort ?? Number.MAX_SAFE_INTEGER));
    const inferredPhase = scopeLine.trade
      ? suggestSowWorkPhase(scopeLine.text, scopeLine.trade, phaseSuggestions)
      : null;
    const key = activities.length > 0
      ? `activity:${activities.map((activity) => activity.id).sort().join(":")}`
      : scopeLine.trade && inferredPhase
        ? `planned:${inferredPhase.group_id}:${normalise(scopeLine.trade)}`
        : `unplanned:${normalise(scopeLine.trade) || normalise(scopeLine.room)}`;
    return {
      key,
      scopeLine,
      items: itemCodesInScopeText(scopeLine.text, input.items),
      activities,
      phaseName: activities[0]?.phase_name ?? inferredPhase?.name ?? null,
      phaseSort: activities[0]?.phase_sort ?? inferredPhase?.sort ?? null,
    };
  });
  const connectionsByPackage = new Map<string, typeof connections>();
  for (const connection of connections) {
    const list = connectionsByPackage.get(connection.key) ?? [];
    list.push(connection);
    connectionsByPackage.set(connection.key, list);
  }

  const threads = [...connectionsByPackage.entries()].map<JobPlanThread>(([key, packageConnections]) => {
    const scopeLines = packageConnections.map((connection) => connection.scopeLine);
    const trades = [...new Set(scopeLines.map((line) => line.trade).filter(Boolean))] as string[];
    const trade = trades.length === 1 ? trades[0] : null;
    const rooms = [...new Set(scopeLines.map((line) => line.room).filter(Boolean))];
    const phaseNames = [...new Set(packageConnections.map((connection) => connection.phaseName).filter(Boolean))] as string[];
    const phaseName = phaseNames.length === 1 ? phaseNames[0] : phaseNames.length > 1 ? "Multiple stages" : null;
    const phaseSorts = packageConnections
      .map((connection) => connection.phaseSort)
      .filter((sort): sort is number => sort !== null);
    const phaseSort = phaseSorts.length > 0 ? Math.min(...phaseSorts) : null;
    const items = uniqueById(packageConnections.flatMap((connection) => connection.items));
    const itemIds = new Set(items.map((item) => item.id));
    const activities = uniqueById(packageConnections.flatMap((connection) => connection.activities))
      .sort((a, b) => (a.phase_sort ?? Number.MAX_SAFE_INTEGER) - (b.phase_sort ?? Number.MAX_SAFE_INTEGER));
    const requirements = items.flatMap((item) => requirementsByItem.get(item.id) ?? []);
    const costLines = uniqueById(items.flatMap((item) => costLinesByItem.get(item.id) ?? []));
    const costLineIds = new Set(costLines.map((line) => line.id));
    const quotes = quotePackagesFor(itemIds, costLineIds, input.quote_packages);
    const contractor = resolveContractor(trade, activities, input.trade_assignments);
    const issues: JobPlanThread["issues"] = [];
    const untaggedCount = scopeLines.filter((line) => !line.trade).length;
    const unplannedCount = packageConnections.filter((connection) => connection.activities.length === 0).length;

    if (untaggedCount > 0) {
      issues.push({ key: "trade", severity: "attention", label: `${untaggedCount} clause${untaggedCount === 1 ? "" : "s"} need a trade`, destination: "scope" });
    }
    if (unplannedCount > 0) {
      issues.push({ key: "activity", severity: "attention", label: `${unplannedCount} clause${unplannedCount === 1 ? "" : "s"} not in the work plan`, destination: "scope" });
    }
    if (
      input.sow_id &&
      activities.some((activity) => activity.sow_revision_id && activity.sow_revision_id !== input.sow_id)
    ) {
      issues.push({ key: "stale-scope", severity: "attention", label: "Activity uses an older scope", destination: "scope" });
    }
    if (trade && !contractor.contractor_company) {
      issues.push({ key: "contractor", severity: "info", label: "Contractor not assigned", destination: "scope" });
    }
    if (
      input.include_financials &&
      items.some((item) => item.cost_scope === "direct" && item.price_trade === null)
    ) {
      issues.push({ key: "price", severity: "attention", label: "Direct item price missing", destination: "ffe" });
    }
    if (
      items.some(
        (item) => item.cost_scope === "direct" && !(requirementsByItem.get(item.id) ?? []).length
      )
    ) {
      issues.push({ key: "required-date", severity: "info", label: "Required activity not set", destination: "ffe" });
    }

    const singleActivityTitle = activities.length === 1 ? activities[0].title : null;
    const title = singleActivityTitle
      ?? (trade && phaseName ? `${trade} · ${phaseName}` : null)
      ?? (trade ? `${trade} work package` : null)
      ?? `${rooms[0] ?? "Scope"} · Trade not assigned`;
    return {
      id: `work-package:${key}`,
      title,
      rooms,
      scope_lines: scopeLines,
      trade,
      phase_name: phaseName,
      phase_sort: phaseSort,
      ...contractor,
      items,
      activities,
      requirements,
      cost_lines: costLines,
      quotes,
      issues,
    };
  }).sort((a, b) => {
    const phaseDiff = (a.phase_sort ?? Number.MAX_SAFE_INTEGER) - (b.phase_sort ?? Number.MAX_SAFE_INTEGER);
    return phaseDiff || a.title.localeCompare(b.title);
  });

  const linkedItemIds = new Set(threads.flatMap((thread) => thread.items.map((item) => item.id)));
  const linkedActivityIds = new Set(threads.flatMap((thread) => thread.activities.map((activity) => activity.id)));
  const linkedCostLineIds = new Set(threads.flatMap((thread) => thread.cost_lines.map((line) => line.id)));
  const referencedItems = input.items.filter((item) => linkedItemIds.has(item.id));

  return {
    sow_id: input.sow_id,
    sow_revision_label: input.sow_revision_label,
    sow_status: input.sow_status,
    threads,
    unlinked_items: input.items.filter((item) => !linkedItemIds.has(item.id)),
    unlinked_activities: input.activities.filter((activity) => !linkedActivityIds.has(activity.id)),
    unlinked_cost_lines: input.cost_lines.filter((line) => !linkedCostLineIds.has(line.id)),
    coverage: {
      scope_inclusions: inclusionLines.length,
      scope_trade_tagged: inclusionLines.filter((line) => !!line.trade).length,
      scope_linked_to_activity: connections.filter((connection) => connection.activities.length > 0).length,
      referenced_items: referencedItems.length,
      direct_items_missing_price: input.include_financials
        ? referencedItems.filter(
            (item) => item.cost_scope === "direct" && item.price_trade === null
          ).length
        : 0,
      items_linked_to_activity: referencedItems.filter(
        (item) => (requirementsByItem.get(item.id) ?? []).length > 0
      ).length,
      linked_cost_lines: linkedCostLineIds.size,
      quote_packages: new Set(threads.flatMap((thread) => thread.quotes.map((quote) => quote.id))).size,
    },
  };
}

function programmeLabel(thread: JobPlanThread): string {
  return thread.phase_name ?? "Not scheduled";
}

/** All five screens are projections of the same threads, never copied records. */
export function groupJobPlanThreads(
  threads: JobPlanThread[],
  view: JobPlanView
): JobPlanGroup[] {
  const groups = new Map<string, JobPlanThread[]>();
  for (const thread of threads) {
    const label =
      view === "scope"
        ? thread.rooms.length === 1
          ? thread.rooms[0]
          : "Across multiple rooms"
        : view === "trade"
          ? thread.trade || "Trade not assigned"
          : view === "cost"
            ? thread.cost_lines[0]?.section_name
              ?? (thread.items.some((item) => item.cost_scope === "direct")
                ? "FF&E product costs"
                : thread.items.length > 0
                  ? "Included in trade package"
                  : "Trade estimate not connected")
            : view === "procurement"
              ? thread.items.length === 0
                ? "No FF&E referenced"
                : thread.items.every((item) => item.cost_scope === "trade_package")
                  ? "Included in trade package"
                  : "Direct procurement"
              : programmeLabel(thread);
    const list = groups.get(label) ?? [];
    list.push(thread);
    groups.set(label, list);
  }
  return [...groups.entries()]
    .map(([label, groupedThreads]) => ({ key: normalise(label), label, threads: groupedThreads }))
    .sort((a, b) => {
      if (view === "programme") {
        const aSort = Math.min(...a.threads.map((thread) => thread.phase_sort ?? Number.MAX_SAFE_INTEGER));
        const bSort = Math.min(...b.threads.map((thread) => thread.phase_sort ?? Number.MAX_SAFE_INTEGER));
        if (aSort !== bSort) return aSort - bSort;
      }
      if (a.label.startsWith("Not ") && !b.label.startsWith("Not ")) return 1;
      if (!a.label.startsWith("Not ") && b.label.startsWith("Not ")) return -1;
      return a.label.localeCompare(b.label);
    });
}
