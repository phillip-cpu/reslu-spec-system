import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildBirthdayCandidates, buildCalendarCandidates } from "./daily-brief.ts";

test("calendar and birthday candidates retain unique, actionable deep links", () => {
  assert.deepEqual(buildCalendarCandidates([{
    id: "event-1",
    title: "9:30am · Selections meeting",
    link_href: "/projects/project-1/client?tab=meetings&event=event-1",
    project_id: "project-1",
  }]), [{
    source: "calendar",
    title: "9:30am · Selections meeting",
    link_href: "/projects/project-1/client?tab=meetings&event=event-1",
    project_id: "project-1",
  }]);

  assert.equal(buildBirthdayCandidates([
    { id: "person-1", name: "Alex", href: "/contacts?contact=person-1" },
  ])[0].title, "Birthday — Alex");
});

test("generator includes all native agenda feeds and retires stale occasions", () => {
  const source = readFileSync(new URL("./daily-brief-generate.ts", import.meta.url), "utf8");
  assert.match(source, /from\("client_events"\)/);
  assert.match(source, /site_visit_date/);
  assert.match(source, /from\("trade_visits"\)/);
  assert.match(source, /\["calendar", "birthday"\]/);
  assert.match(source, /birthdayMatchesDate/);
});

test("birthday schema stores no year and widens brief sources safely", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260901072719_morning_brief_agenda_and_birthdays.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /add column if not exists birthday text/);
  assert.match(migration, /birthday ~ '\^\(0\[1-9\]\|1\[0-2\]\)-/);
  assert.match(migration, /'calendar', 'birthday'/);
  assert.doesNotMatch(migration, /birth_year|date_of_birth|age integer/);
});
