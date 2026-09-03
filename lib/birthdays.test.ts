import assert from "node:assert/strict";
import test from "node:test";
import { birthdayFromInput, birthdayInputValue, birthdayLabel, birthdayMatchesDate, isValidStoredBirthday } from "./birthdays.ts";

test("birthday editor stores month/day only and supports leap day", () => {
  assert.equal(birthdayFromInput("7/9"), "09-07");
  assert.equal(birthdayFromInput("29/2"), "02-29");
  assert.equal(birthdayFromInput("31/2"), undefined);
  assert.equal(birthdayFromInput(""), null);
  assert.equal(birthdayInputValue("09-07"), "7/9");
  assert.equal(isValidStoredBirthday("02-29"), true);
  assert.equal(isValidStoredBirthday("02-31"), false);
});

test("birthday matching ignores year", () => {
  assert.equal(birthdayMatchesDate("09-01", "2026-09-01"), true);
  assert.equal(birthdayMatchesDate("09-01", "2030-09-01"), true);
  assert.equal(birthdayLabel("09-01"), "1 September");
});
