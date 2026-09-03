import type { DailyBriefSource } from "./daily-brief.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_UP_COUNT = 3;

const SOURCE_SCORE: Record<DailyBriefSource, number> = {
  booking: 90,
  ordering: 85,
  invoice: 82,
  trade: 75,
  proposal: 70,
  email: 65,
  aria: 60,
  manual: 55,
  lead: 50,
  calendar: 88,
  birthday: 45,
};

const ACTION_LABEL: Record<DailyBriefSource, string> = {
  booking: "Book trade",
  ordering: "Review order",
  invoice: "Review invoice",
  trade: "Resolve",
  proposal: "Review proposal",
  email: "Reply",
  aria: "Review",
  manual: "Action",
  lead: "Follow up",
  calendar: "View event",
  birthday: "Celebrate",
};

const SOURCE_SUMMARY_LABEL: Record<DailyBriefSource, string> = {
  booking: "booking",
  ordering: "order",
  invoice: "invoice",
  trade: "trade issue",
  proposal: "proposal",
  email: "email",
  aria: "Aria review",
  manual: "manual item",
  lead: "follow-up",
  calendar: "event",
  birthday: "birthday",
};

export interface MorningBriefItemInput {
  id: string;
  source: DailyBriefSource;
  title: string;
  brief_date: string;
  created_at: string;
}

export interface RankedMorningBriefItem {
  morning_rank: number;
  action_label: string;
  is_first_up: boolean;
  carried_over_days: number;
}

function parseDateOnly(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function adelaideDateOnly(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Adelaide" }).format(now);
}

export function adelaideHour(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Adelaide",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now)
  );
}

export function isMorningBriefDeliveryHour(now: Date = new Date()): boolean {
  return adelaideHour(now) === 7;
}

function carriedOverDays(briefDate: string, today: string): number {
  return Math.max(0, Math.round((parseDateOnly(today) - parseDateOnly(briefDate)) / DAY_MS));
}

function contentBoost(title: string): number {
  const normalized = title.toLowerCase();
  if (/\b(expired|overdue|failed|blocked)\b/.test(normalized)) return 45;
  if (/\b(needs approval|flagged|unconfirmed|proposed a new time)\b/.test(normalized)) return 20;
  return 0;
}

function agendaMinutes(title: string): number {
  const normalized = title.toLowerCase();
  const time = /^(\d{1,2}):(\d{2})(am|pm)\b/.exec(normalized);
  if (time) {
    const rawHour = Number(time[1]);
    const hour = (rawHour % 12) + (time[3] === "pm" ? 12 : 0);
    return hour * 60 + Number(time[2]);
  }
  if (normalized.startsWith("first thing")) return 8 * 60;
  if (normalized.startsWith("midday")) return 12 * 60;
  if (normalized.startsWith("afternoon")) return 15 * 60;
  return 24 * 60;
}

/**
 * Produces one deterministic action order for the push, email and in-app
 * brief. Source urgency is the primary signal, explicit risk language is a
 * boost, and carried-over work rises gradually so it cannot disappear under
 * an endless stream of fresh low-value items.
 */
export function rankMorningBriefItems<T extends MorningBriefItemInput>(
  items: T[],
  now: Date = new Date()
): Array<T & RankedMorningBriefItem> {
  const today = adelaideDateOnly(now);
  const sorted = items
    .map((item) => {
      const age = carriedOverDays(item.brief_date, today);
      return {
        item,
        age,
        score: SOURCE_SCORE[item.source] + contentBoost(item.title) + Math.min(age, 14) * 3,
      };
    })
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.item.source === "calendar" && b.item.source === "calendar") {
        const timeDifference = agendaMinutes(a.item.title) - agendaMinutes(b.item.title);
        if (timeDifference !== 0) return timeDifference;
      }
      if (a.item.brief_date !== b.item.brief_date) return a.item.brief_date.localeCompare(b.item.brief_date);
      if (a.item.created_at !== b.item.created_at) return a.item.created_at.localeCompare(b.item.created_at);
      return a.item.id.localeCompare(b.item.id);
    });
  let actionRank = 0;
  return sorted.map(({ item, age }) => {
    const isAgenda = item.source === "calendar" || item.source === "birthday";
    if (!isAgenda) actionRank += 1;
    return {
      ...item,
      morning_rank: isAgenda ? 0 : actionRank,
      action_label: ACTION_LABEL[item.source],
      is_first_up: !isAgenda && actionRank <= FIRST_UP_COUNT,
      carried_over_days: age,
    };
  });
}

function pluralize(label: string, count: number): string {
  if (count === 1) return `1 ${label}`;
  if (label === "Aria review") return `${count} Aria reviews`;
  if (label === "manual item") return `${count} manual items`;
  if (label === "trade issue") return `${count} trade issues`;
  if (label === "follow-up") return `${count} follow-ups`;
  return `${count} ${label}s`;
}

export interface MorningBriefNotificationContent {
  title: string;
  body: string;
  link: string;
}

/** Privacy-safe, glanceable lock-screen copy. Record/project names stay in RESLU. */
export function buildMorningBriefNotificationContent(
  rankedItems: Array<MorningBriefItemInput & RankedMorningBriefItem>
): MorningBriefNotificationContent {
  const itemCount = rankedItems.length;
  const firstUp = rankedItems.filter((item) => item.is_first_up);
  const agenda = rankedItems.filter((item) => item.source === "calendar" || item.source === "birthday");
  const counts = new Map<DailyBriefSource, number>();
  for (const item of firstUp) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);

  const firstUpSummary = [...counts.entries()]
    .map(([source, count]) => pluralize(SOURCE_SUMMARY_LABEL[source], count))
    .join(" · ");
  const agendaCounts = new Map<DailyBriefSource, number>();
  for (const item of agenda) agendaCounts.set(item.source, (agendaCounts.get(item.source) ?? 0) + 1);
  const agendaSummary = [...agendaCounts.entries()]
    .map(([source, count]) => pluralize(SOURCE_SUMMARY_LABEL[source], count))
    .join(" · ");
  const carried = rankedItems.filter((item) => item.carried_over_days > 0).length;
  const carriedSuffix = carried > 0 ? ` · ${carried} carried over` : "";

  return {
    title: `Morning brief · ${itemCount} ${itemCount === 1 ? "priority" : "priorities"}`,
    body: `${agendaSummary ? `${agendaSummary}. ${firstUpSummary ? `First up: ${firstUpSummary}` : "Your day is mapped"}` : firstUpSummary || "Your action list is ready"}${carriedSuffix}.`,
    link: "/my-work#daily-brief",
  };
}
