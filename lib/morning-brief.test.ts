import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMorningBriefNotificationContent,
  isMorningBriefDeliveryHour,
  rankMorningBriefItems,
  type MorningBriefItemInput,
} from "./morning-brief.ts";

const now = new Date("2026-08-31T21:30:00.000Z"); // 7:00am ACST, 1 September

function item(overrides: Partial<MorningBriefItemInput> & Pick<MorningBriefItemInput, "id" | "source">): MorningBriefItemInput {
  return {
    title: `Item ${overrides.id}`,
    brief_date: "2026-09-01",
    created_at: `2026-09-01T00:00:0${overrides.id}.000Z`,
    ...overrides,
  };
}

test("ranks operational actions first and raises carried-over work gradually", () => {
  const ranked = rankMorningBriefItems([
    item({ id: "1", source: "lead" }),
    item({ id: "2", source: "booking" }),
    item({ id: "3", source: "ordering" }),
    item({ id: "4", source: "trade", title: "Insurance expired", brief_date: "2026-08-31" }),
  ], now);

  assert.deepEqual(ranked.map((row) => row.id), ["4", "2", "3", "1"]);
  assert.deepEqual(ranked.map((row) => row.morning_rank), [1, 2, 3, 4]);
  assert.equal(ranked[0].action_label, "Resolve");
  assert.equal(ranked[0].carried_over_days, 1);
  assert.equal(ranked[2].is_first_up, true);
  assert.equal(ranked[3].is_first_up, false);
});

test("notification copy is concise, privacy-safe and summarises the first three actions", () => {
  const ranked = rankMorningBriefItems([
    item({ id: "1", source: "booking", title: "Book Smith electrical rough-in" }),
    item({ id: "2", source: "booking", title: "Book Jones plumbing" }),
    item({ id: "3", source: "ordering", title: "Order Carrara stone" }),
    item({ id: "4", source: "lead", title: "Nurture — Private Client", brief_date: "2026-08-31" }),
  ], now);
  const content = buildMorningBriefNotificationContent(ranked);

  assert.equal(content.title, "Morning brief · 4 priorities");
  assert.equal(content.body, "2 bookings · 1 order · 1 carried over.");
  assert.equal(content.link, "/my-work#daily-brief");
  assert.doesNotMatch(content.body, /Smith|Jones|Carrara|Private Client/);
});

test("delivery-hour gate follows Adelaide daylight saving", () => {
  assert.equal(isMorningBriefDeliveryHour(new Date("2026-06-01T21:30:00.000Z")), true);
  assert.equal(isMorningBriefDeliveryHour(new Date("2026-12-01T20:30:00.000Z")), true);
  assert.equal(isMorningBriefDeliveryHour(new Date("2026-12-01T21:30:00.000Z")), false);
});

test("calendar entries are chronological and do not displace the top three actions", () => {
  const ranked = rankMorningBriefItems([
    item({ id: "1", source: "calendar", title: "2:00pm · Site meeting" }),
    item({ id: "2", source: "calendar", title: "9:30am · Client meeting" }),
    item({ id: "3", source: "booking" }),
    item({ id: "4", source: "ordering" }),
    item({ id: "5", source: "lead" }),
  ], now);
  const agenda = ranked.filter((row) => row.source === "calendar");
  const firstUp = ranked.filter((row) => row.is_first_up);

  assert.deepEqual(agenda.map((row) => row.id), ["2", "1"]);
  assert.deepEqual(firstUp.map((row) => row.id), ["3", "4", "5"]);
  assert.ok(agenda.every((row) => row.morning_rank === 0));
  const content = buildMorningBriefNotificationContent(ranked);
  assert.equal(content.body, "2 events. First up: 1 booking · 1 order · 1 follow-up.");
});
