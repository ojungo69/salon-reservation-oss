import assert from "node:assert/strict";
import { test } from "node:test";
import { weekDates, timelineLayout } from "../public/studio.mjs";

test("date strip crosses leap days and years without local-time conversion", () => {
  assert.deepEqual(weekDates("2028-02-28"), ["2028-02-28", "2028-02-29", "2028-03-01", "2028-03-02", "2028-03-03", "2028-03-04", "2028-03-05"]);
  assert.equal(weekDates("2026-01-01")[0], "2025-12-29");
  assert.equal(weekDates("2026-09-12")[5], "2026-09-12");
});

test("date strip respects canonical input and the configured booking window", () => {
  assert.deepEqual(weekDates("2026-09-12", "2026-09-10", "2026-09-12"), ["2026-09-10", "2026-09-11", "2026-09-12"]);
  for (const invalid of ["2026-02-30", "invalid", "2026-9-1", ""]) assert.deepEqual(weekDates(invalid), []);
  assert.deepEqual(weekDates("2026-09-12", "2026-09-13", "2026-09-10"), []);
});

const booking = (overrides = {}) => ({ reservationId: "r1", resourceId: "a", resourceLabel: "担当 A", startTime: "10:00", serviceMinutes: 60, cleanupMinutes: 5, status: "approved", ...overrides });
const board = (reservations = [booking()], closures = []) => ({ opensAt: "09:00", closesAt: "17:00", reservations, closures });

test("timeline uses occupied time including cleanup without changing source records", () => {
  const input = board(); const before = JSON.stringify(input);
  const result = timelineLayout(input, [{ id: "a", label: "担当 A" }, { id: "b", label: "担当 B" }]);
  assert.equal(result.start, 540); assert.equal(result.end, 1020);
  assert.equal(result.lanes.length, 2);
  assert.equal(result.lanes[0].entries[0].start, 600);
  assert.equal(result.lanes[0].entries[0].end, 665);
  assert.equal(JSON.stringify(input), before);
});

test("timeline preserves historical resources and ignores non-occupying cancelled rows", () => {
  const result = timelineLayout(board([booking(), booking({ reservationId: "r2", resourceId: "old", status: "pending" }), booking({ reservationId: "r3", status: "cancelled" })]), [{ id: "a", label: "担当 A" }]);
  assert.deepEqual(result.lanes.map((lane) => lane.id), ["a", "old"]);
  assert.equal(result.lanes.flatMap((lane) => lane.entries).length, 2);
});

test("global closures appear in every lane and cancelled closures do not occupy time", () => {
  const result = timelineLayout(board([], [{ closureId: "c", resourceId: null, startTime: "12:00", endTime: "13:00", label: "休憩", active: true }, { closureId: "removed", resourceId: null, startTime: "12:00", endTime: "13:00", active: false }]), [{ id: "a", label: "A" }, { id: "b", label: "B" }]);
  assert.equal(result.lanes[0].entries.length, 1);
  assert.equal(result.lanes[1].entries[0].kind, "closure");
});

test("short or overlapping appointments fall back to the accessible agenda instead of clipped targets", () => {
  assert.equal(timelineLayout(board([booking({ serviceMinutes: 15, cleanupMinutes: 0 })]), []), null);
  assert.equal(timelineLayout(board([booking(), booking({ reservationId: "r2", startTime: "10:30" })]), []), null);
  assert.notEqual(timelineLayout(board([booking(), booking({ reservationId: "r2", startTime: "11:05" })]), []), null);
});

test("invalid time or duration falls back without inventing a placement", () => {
  for (const overrides of [{ startTime: "bad" }, { serviceMinutes: Number.NaN }, { serviceMinutes: -5 }, { startTime: "23:30", serviceMinutes: 60 }]) {
    assert.equal(timelineLayout(board([booking(overrides)]), []), null);
  }
});
