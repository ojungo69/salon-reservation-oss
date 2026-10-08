import assert from "node:assert/strict";
import test from "node:test";

import {
  adapterObjectName,
  dayObjectName,
  locationFromAdapterId,
  locationFromDayId,
  parseLocationId,
} from "../src/location.ts";

const id = (value: string, name?: string) => ({
  ...(name === undefined ? {} : { name }),
  toString: () => value,
  equals: (other: { toString(): string }) => other.toString() === value,
});

test("retains literal legacy addresses and isolates named location/day addresses", () => {
  assert.equal(adapterObjectName("default"), "installation");
  assert.equal(dayObjectName("default", "2026-11-18"), "single-location:2026-11-18");
  assert.equal(adapterObjectName("salon-b"), "location:salon-b");
  assert.equal(dayObjectName("salon-b", "2026-11-18"), "location:salon-b:2026-11-18");
});

test("accepts canonical location IDs and rejects ambiguous or invalid inputs", () => {
  for (const valid of ["default", "a", "salon-b", "a".repeat(32)]) {
    assert.equal(parseLocationId(valid), valid);
  }
  for (const invalid of [undefined, null, 7, "", "Default", " salon-b", "salon-b ", "salon-b-", "a".repeat(33), "a:b", "a/b", "a%2fb", "a\nb", "a\u0000b"]) {
    assert.equal(parseLocationId(invalid), null);
    assert.throws(() => adapterObjectName(invalid as string));
  }
  for (const date of ["2026-02-30", "2026-1-01", "0099-01-01", "2026-11-18:other"]) {
    assert.throws(() => dayObjectName("salon-b", date));
  }
});

test("recovers only the exact nameless legacy actor and refuses default aliases", () => {
  const legacy = id("legacy", "installation");
  assert.equal(locationFromAdapterId(id("legacy"), legacy), "default");
  assert.equal(locationFromAdapterId(legacy, legacy), "default");
  assert.equal(locationFromAdapterId(id("named", "location:salon-b"), legacy), "salon-b");
  for (const wrong of [id("other"), id("other", "installation"), id("other", "location:default"), id("other", "location:salon-b:2026-11-18")]) {
    assert.throws(() => locationFromAdapterId(wrong, legacy));
  }
});

test("day actors must match the command date and canonical named scope", () => {
  const legacy = id("legacy-day", "single-location:2026-11-18");
  assert.equal(locationFromDayId(legacy, "2026-11-18", legacy), "default");
  assert.equal(locationFromDayId(id("legacy-day"), "2026-11-18", legacy), "default");
  assert.equal(locationFromDayId(id("named", "location:salon-b:2026-11-18"), "2026-11-18", legacy), "salon-b");
  for (const wrong of [id("other"), id("other", "single-location:2026-11-18"), id("other", "single-location:2026-11-19"), id("named", "location:salon-b:2026-11-19"), id("named", "location:default:2026-11-18")]) {
    assert.throws(() => locationFromDayId(wrong, "2026-11-18", legacy));
  }
});
