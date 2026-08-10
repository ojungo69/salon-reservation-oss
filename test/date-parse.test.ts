import assert from "node:assert/strict";
import test from "node:test";

import { parseDateJstToUtcIso } from "../src/date-parse.ts";

test("converts an ordinary calendar date from JST midnight to UTC", () => {
  assert.equal(parseDateJstToUtcIso("2026-01-15"), "2026-01-14T15:00:00.000Z");
});

test("applies Gregorian leap-year rules", () => {
  assert.equal(parseDateJstToUtcIso("2024-02-29"), "2024-02-28T15:00:00.000Z");
  assert.equal(parseDateJstToUtcIso("2000-02-29"), "2000-02-28T15:00:00.000Z");
  assert.equal(parseDateJstToUtcIso("2023-02-29"), null);
  assert.equal(parseDateJstToUtcIso("1900-02-29"), null);
});

test("rejects impossible dates instead of rolling them forward", () => {
  for (const value of [
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-02-30",
    "2026-04-31",
  ]) {
    assert.equal(parseDateJstToUtcIso(value), null, value);
  }
});

test("accepts only the exact YYYY-MM-DD format", () => {
  for (const value of [
    "",
    "2026-2-03",
    "2026-02-3",
    "2026/02/03",
    " 2026-02-03",
    "2026-02-03 ",
    "2026-02-03Z",
    "2026-02-03T00:00:00",
  ]) {
    assert.equal(parseDateJstToUtcIso(value), null, value);
  }
});

test("preserves the approved four-digit year boundary", () => {
  assert.equal(parseDateJstToUtcIso("0100-01-01"), "0099-12-31T15:00:00.000Z");
  assert.equal(parseDateJstToUtcIso("9999-12-31"), "9999-12-30T15:00:00.000Z");
  assert.equal(parseDateJstToUtcIso("0099-12-31"), null);
  assert.equal(parseDateJstToUtcIso("0000-02-29"), null);
});

test("does not depend on the runtime timezone", () => {
  const originalTimezone = process.env.TZ;

  try {
    for (const timezone of ["UTC", "Asia/Tokyo", "America/New_York"]) {
      process.env.TZ = timezone;
      assert.equal(
        parseDateJstToUtcIso("2026-07-15"),
        "2026-07-14T15:00:00.000Z",
        timezone,
      );
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
