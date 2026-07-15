// ============================================================
// RESLU Spec System — Phase 3: Data Quality & Programme Guardrails.
// Pure, read-only diagnostics: plain data in, plain report out. No
// Supabase/Next imports and no mutations. The API and Aria context can
// therefore share one definition of every warning.
// ============================================================

import type {
  DataQualityArea,
  DataQualityEntityRef,
  DataQualityItemInput,
  DataQualitySeverity,
  ProjectDataQualityInput,
  ProjectDataQualityIssue,
  ProjectDataQualityResponse,
  ProjectPricingCoverage,
} from "@/types/data-quality";

const DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_TRADE_WINDOW_DAYS = 14;
const FUTURE_IN_PROGRESS_GRACE_DAYS = 7;
const SAMPLE_LIMIT = 3;

interface IssueSeed {
  code: string;
  severity: DataQualitySeverity;
  area: DataQualityArea;
  title: string;
  detail: string;
  entities: DataQualityEntityRef[];
}

function dateOnlyMs(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysBetween(from: string, to: string): number {
  return Math.round((dateOnlyMs(to) - dateOnlyMs(from)) / DAY_MS);
}

function itemRef(item: DataQualityItemInput): DataQualityEntityRef {
  return { id: item.id, label: `${item.item_code} · ${item.name}`, kind: "item" };
}

function isPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function effectivePrice(item: DataQualityItemInput): { value: number | null; quoted: boolean } {
  if (isPositive(item.price_trade)) return { value: item.price_trade, quoted: true };
  if (isPositive(item.price_rrp)) return { value: item.price_rrp, quoted: false };
  return { value: null, quoted: false };
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function pricingCoverage(items: DataQualityItemInput[]): ProjectPricingCoverage {
  let pricedItems = 0;
  let quotedItems = 0;
  let placeholderItems = 0;
  let knownValue = 0;
  let quotedValue = 0;

  for (const item of items) {
    const price = effectivePrice(item);
    if (price.value === null) continue;
    pricedItems += 1;
    const value = Math.max(0, item.quantity) * price.value;
    knownValue += value;
    if (price.quoted) {
      quotedItems += 1;
      quotedValue += value;
    } else {
      placeholderItems += 1;
    }
  }

  return {
    total_items: items.length,
    priced_items: pricedItems,
    priced_item_pct: percent(pricedItems, items.length),
    quoted_items: quotedItems,
    placeholder_items: placeholderItems,
    unpriced_items: items.length - pricedItems,
    known_value_ex_gst: roundMoney(knownValue),
    quoted_value_ex_gst: roundMoney(quotedValue),
    // Deliberately labelled as the share of KNOWN value, not total
    // project coverage: unpriced items have no defensible denominator.
    quoted_value_pct: percent(quotedValue, knownValue),
  };
}

function issueHref(projectId: string, entities: DataQualityEntityRef[]): string {
  const first = entities[0];
  if (!first) return `/projects/${projectId}`;
  if (first.kind === "item") {
    return `/projects/${projectId}?tab=ffe&focus=ordering_due-${first.id}`;
  }
  if (first.kind === "task") {
    return `/projects/${projectId}/board?focus=board_task-${first.id}`;
  }
  return `/projects/${projectId}/timeline`;
}

function issueFrom(seed: IssueSeed, projectId: string): ProjectDataQualityIssue | null {
  if (seed.entities.length === 0) return null;
  return {
    code: seed.code,
    severity: seed.severity,
    area: seed.area,
    title: seed.title,
    detail: seed.detail,
    count: seed.entities.length,
    samples: seed.entities.slice(0, SAMPLE_LIMIT),
    href: issueHref(projectId, seed.entities),
  };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Produce one compact, actionable report for a project. Issues are
 * aggregated by rule so a 100-item register remains scannable rather
 * than rendering 100 separate warnings.
 */
export function deriveProjectDataQuality(input: ProjectDataQualityInput): ProjectDataQualityResponse {
  const { project_id: projectId, items, tasks, visits, order_by: orderBy, today } = input;
  const seeds: IssueSeed[] = [];
  const roomItemIds = new Set(input.room_item_ids);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const columnNameById = new Map(input.columns.map((column) => [column.id, column.name.trim().toLowerCase()]));

  if (items.length === 0) {
    seeds.push({
      code: "register_empty",
      severity: "warning",
      area: "register",
      title: "Spec register is empty",
      detail: "Confirm whether selections are still to be entered or are being tracked somewhere else.",
      entities: [{ id: projectId, label: "Project register", kind: "project" }],
    });
  }

  const zeroQuantity = items.filter((item) => !Number.isFinite(item.quantity) || item.quantity <= 0);
  seeds.push({
    code: "quantity_zero",
    severity: "critical",
    area: "register",
    title: "Items have zero quantity",
    detail: `${plural(zeroQuantity.length, "item")} cannot contribute to purchasing or pricing totals.`,
    entities: zeroQuantity.map(itemRef),
  });

  const missingRoom = items.filter((item) => !roomItemIds.has(item.id));
  seeds.push({
    code: "room_missing",
    severity: "warning",
    area: "register",
    title: "Items are not assigned to a room",
    detail: `${plural(missingRoom.length, "item")} will be harder to review, export and reconcile against plans.`,
    entities: missingRoom.map(itemRef),
  });

  const missingSupplier = items.filter(
    (item) => !item.supplier?.trim() && !item.supplier_contact_id
  );
  seeds.push({
    code: "supplier_missing",
    severity: "warning",
    area: "register",
    title: "Items have no supplier",
    detail: `${plural(missingSupplier.length, "item")} cannot be reliably quoted or ordered.`,
    entities: missingSupplier.map(itemRef),
  });

  const invalidCode = items.filter((item) => {
    const prefix = item.item_code.split("-")[0]?.trim().toUpperCase();
    return !prefix || prefix !== item.category.trim().toUpperCase();
  });
  seeds.push({
    code: "item_code_mismatch",
    severity: "warning",
    area: "register",
    title: "Item codes do not match their categories",
    detail: `${plural(invalidCode.length, "item")} may not reconcile cleanly with plans or exports.`,
    entities: invalidCode.map(itemRef),
  });

  const codeGroups = new Map<string, DataQualityItemInput[]>();
  for (const item of items) {
    const key = item.item_code.trim().toUpperCase();
    const group = codeGroups.get(key) ?? [];
    group.push(item);
    codeGroups.set(key, group);
  }
  const duplicateCodes = [...codeGroups.values()].filter((group) => group.length > 1).flat();
  seeds.push({
    code: "item_code_duplicate",
    severity: "critical",
    area: "register",
    title: "Duplicate active item codes",
    detail: `${plural(duplicateCodes.length, "item")} share a code and need reconciliation.`,
    entities: duplicateCodes.map(itemRef),
  });

  const unpriced = items.filter((item) => effectivePrice(item).value === null);
  seeds.push({
    code: "price_missing",
    severity: "warning",
    area: "pricing",
    title: "Items have no usable price",
    detail: `${plural(unpriced.length, "item")} are excluded from the known-value total.`,
    entities: unpriced.map(itemRef),
  });

  const quotedWithoutPrice = items.filter(
    (item) => ["Quoted", "Ordered", "On Site", "Installed"].includes(item.status) && effectivePrice(item).value === null
  );
  seeds.push({
    code: "quoted_without_price",
    severity: "critical",
    area: "pricing",
    title: "Advanced items still have no price",
    detail: `${plural(quotedWithoutPrice.length, "item")} are marked Quoted or later but still contribute $0 to pricing.`,
    entities: quotedWithoutPrice.map(itemRef),
  });

  const missingLeadTime = items.filter(
    (item) => !item.ordered_at && !["Ordered", "On Site", "Installed"].includes(item.status) && !isPositive(item.lead_time_weeks)
  );
  seeds.push({
    code: "lead_time_missing",
    severity: "warning",
    area: "procurement",
    title: "Items are missing lead times",
    detail: `${plural(missingLeadTime.length, "item")} cannot produce a dependable order-by date.`,
    entities: missingLeadTime.map(itemRef),
  });

  const orderingOverdue = orderBy
    .filter((row) => row.status === "overdue")
    .map((row) => itemById.get(row.item_id))
    .filter((item): item is DataQualityItemInput => Boolean(item));
  seeds.push({
    code: "ordering_overdue",
    severity: "critical",
    area: "procurement",
    title: "Orders are overdue",
    detail: `${plural(orderingOverdue.length, "item")} have passed their derived order-by date.`,
    entities: orderingOverdue.map(itemRef),
  });

  const orderingDueSoon = orderBy
    .filter((row) => row.status === "due_soon")
    .map((row) => itemById.get(row.item_id))
    .filter((item): item is DataQualityItemInput => Boolean(item));
  seeds.push({
    code: "ordering_due_soon",
    severity: "warning",
    area: "procurement",
    title: "Orders are due within seven days",
    detail: `${plural(orderingDueSoon.length, "item")} need purchasing attention this week.`,
    entities: orderingDueSoon.map(itemRef),
  });

  const statusDateConflict = items.filter((item) => {
    const advanced = ["Ordered", "On Site", "Installed"].includes(item.status);
    const early = ["Specced", "Quoted"].includes(item.status);
    return (advanced && !item.ordered_at) || (early && Boolean(item.ordered_at)) || (item.delivered_at && !["On Site", "Installed"].includes(item.status));
  });
  seeds.push({
    code: "item_status_date_conflict",
    severity: "warning",
    area: "procurement",
    title: "Item status and procurement dates disagree",
    detail: `${plural(statusDateConflict.length, "item")} have a lifecycle status that conflicts with their recorded order or delivery dates.`,
    entities: statusDateConflict.map(itemRef),
  });

  const visitRefs = (rows: typeof visits): DataQualityEntityRef[] =>
    rows.map((visit) => ({ id: visit.id, label: `Trade visit · ${visit.start_date}`, kind: "visit" }));
  const unresolvedVisits = visits.filter((visit) => !["confirmed", "declined"].includes(visit.status));
  const overdueVisits = unresolvedVisits.filter((visit) => visit.start_date < today);
  const upcomingVisits = unresolvedVisits.filter((visit) => {
    const days = daysBetween(today, visit.start_date);
    return days >= 0 && days <= UPCOMING_TRADE_WINDOW_DAYS;
  });
  seeds.push({
    code: "trade_confirmation_overdue",
    severity: "critical",
    area: "programme",
    title: "Trade visits are past due and unconfirmed",
    detail: `${plural(overdueVisits.length, "visit")} ${overdueVisits.length === 1 ? "has" : "have"} passed without a confirmed booking state.`,
    entities: visitRefs(overdueVisits),
  });
  seeds.push({
    code: "trade_confirmation_due",
    severity: "warning",
    area: "programme",
    title: "Upcoming trade visits are not confirmed",
    detail: `${plural(upcomingVisits.length, "visit")} ${upcomingVisits.length === 1 ? "starts" : "start"} within ${UPCOMING_TRADE_WINDOW_DAYS} days.`,
    entities: visitRefs(upcomingVisits),
  });

  const taskRefs = (rows: typeof tasks): DataQualityEntityRef[] =>
    rows.map((task) => ({ id: task.id, label: task.title, kind: "task" }));
  const taskDateConflicts = tasks.filter(
    (task) => task.booking_date && task.booking_end_date && task.booking_end_date < task.booking_date
  );
  seeds.push({
    code: "task_date_conflict",
    severity: "critical",
    area: "programme",
    title: "Task date ranges are invalid",
    detail: `${plural(taskDateConflicts.length, "task")} end before they start.`,
    entities: taskRefs(taskDateConflicts),
  });

  const futureInProgress = tasks.filter((task) => {
    const columnName = columnNameById.get(task.column_id);
    return columnName === "in progress" && Boolean(task.booking_date) && daysBetween(today, task.booking_date!) > FUTURE_IN_PROGRESS_GRACE_DAYS;
  });
  seeds.push({
    code: "future_task_in_progress",
    severity: "warning",
    area: "programme",
    title: "Future work is marked In Progress",
    detail: `${plural(futureInProgress.length, "task")} ${futureInProgress.length === 1 ? "starts" : "start"} more than ${FUTURE_IN_PROGRESS_GRACE_DAYS} days from now but ${futureInProgress.length === 1 ? "is" : "are"} already in progress.`,
    entities: taskRefs(futureInProgress),
  });

  const completedFutureTasks = tasks.filter((task) => {
    const columnName = columnNameById.get(task.column_id);
    return ["done", "complete", "completed"].includes(columnName ?? "") && Boolean(task.booking_date) && task.booking_date! > today;
  });
  seeds.push({
    code: "future_task_complete",
    severity: "critical",
    area: "programme",
    title: "Future work is marked complete",
    detail: `${plural(completedFutureTasks.length, "task")} ${completedFutureTasks.length === 1 ? "has" : "have"} a future works date but ${completedFutureTasks.length === 1 ? "sits" : "sit"} in a completed column.`,
    entities: taskRefs(completedFutureTasks),
  });

  const severityRank: Record<DataQualitySeverity, number> = { critical: 0, warning: 1, info: 2 };
  const issues = seeds
    .map((seed) => issueFrom(seed, projectId))
    .filter((issue): issue is ProjectDataQualityIssue => Boolean(issue))
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.count - a.count || a.title.localeCompare(b.title));

  return {
    project_id: projectId,
    generated_at: new Date().toISOString(),
    summary: {
      critical: issues.filter((issue) => issue.severity === "critical").length,
      warning: issues.filter((issue) => issue.severity === "warning").length,
      info: issues.filter((issue) => issue.severity === "info").length,
      // Count every affected entity, not only the three samples retained
      // on each issue for compact display.
      affected_records: new Set(
        seeds.flatMap((seed) => seed.entities.map((entity) => `${entity.kind}:${entity.id}`))
      ).size,
    },
    pricing: pricingCoverage(items),
    issues,
  };
}
