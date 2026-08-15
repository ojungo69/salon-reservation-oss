import assert from "node:assert/strict";
import test from "node:test";

import { hasActiveOwner, parseStaffRoster } from "../src/installation-config.ts";

/**
 * The roster is the one place this installation records who may operate it, and
 * it is stored as a JSON document rather than as rows — so the parser is the
 * whole schema. Everything the storage layer promises about a roster is checked
 * here: an active member always holds a credential digest, an inactive one
 * never does, identifiers do not repeat, and a document this version does not
 * understand is refused rather than guessed at.
 *
 * Every name below is invented. No real staff name, credential, or identifier
 * belongs in this repository.
 */

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const CREATED = "2026-08-16T00:00:00.000Z";

const member = (overrides: Record<string, unknown> = {}) => ({
  id: "6f1c2e40-9a3b-4d17-8c5e-2b7d90a4f8e1",
  displayName: "受付 A",
  role: "owner",
  active: true,
  credentialDigest: DIGEST_A,
  createdAt: CREATED,
  deactivatedAt: null,
  ...overrides,
});

const roster = (...members: unknown[]) => ({ version: 1, members });

const refuses = (value: unknown, why: string) => {
  assert.throws(() => parseStaffRoster(value), /Invalid installation storage/, why);
};

test("accepts a roster with one active owner", () => {
  const parsed = parseStaffRoster(roster(member()));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.members.length, 1);
  assert.equal(parsed.members[0]?.role, "owner");
  assert.equal(hasActiveOwner(parsed), true);
});

test("accepts a deactivated member, which carries no digest", () => {
  const parsed = parseStaffRoster(
    roster(
      member(),
      member({
        id: "0e3a71b8-5c46-4f92-bd10-7a2c6e8f4351",
        displayName: "受付 B",
        role: "staff",
        active: false,
        credentialDigest: "",
        deactivatedAt: "2026-08-16T01:00:00.000Z",
      }),
    ),
  );
  assert.equal(parsed.members.length, 2);
  assert.equal(parsed.members[1]?.credentialDigest, "");
});

test("round-trips to the exact bytes it was given", () => {
  // The storage read compares the re-serialised document against what was
  // stored, so a parser that reorders or normalises anything would make every
  // read look like corruption.
  const stored = JSON.stringify(roster(member()));
  assert.equal(JSON.stringify(parseStaffRoster(JSON.parse(stored))), stored);
});

test("refuses a document this version does not understand", () => {
  refuses({ version: 2, members: [] }, "a later version is not guessed at");
  refuses({ version: 1 }, "members is required");
  refuses({ version: 1, members: [], extra: true }, "unknown keys are refused");
  refuses({ version: 1, members: {} }, "members must be an array");
});

test("refuses a member whose active flag and credential disagree", () => {
  // This is what makes revocation structural: deactivation clears the digest,
  // so an inactive record cannot authenticate even if a later code path forgot
  // to check the flag.
  refuses(
    roster(member({ active: true, credentialDigest: "" })),
    "an active member must hold a digest",
  );
  refuses(
    roster(member({ active: false, credentialDigest: DIGEST_A })),
    "an inactive member must not hold a digest",
  );
  refuses(
    roster(member({ credentialDigest: "not-a-digest" })),
    "a digest must be 64 hex characters",
  );
});

test("refuses repeated identifiers", () => {
  refuses(
    roster(member(), member({ displayName: "受付 B", credentialDigest: DIGEST_B })),
    "two members cannot share an id",
  );
});

test("refuses an identifier that is not the shape this system generates", () => {
  refuses(roster(member({ id: "01J8Z2QK4M7R9V3XW6YB5NCTGD" })), "not a UUID");
  refuses(roster(member({ id: "" })), "empty");
});

test("refuses a role outside the two this slice defines", () => {
  refuses(roster(member({ role: "admin" })), "a third role does not parse");
  refuses(roster(member({ role: "" })), "nor does an empty one");
});

test("refuses a display name that was never normalised or is too long", () => {
  refuses(roster(member({ displayName: " 受付 A" })), "untrimmed");
  refuses(roster(member({ displayName: "" })), "empty");
  refuses(roster(member({ displayName: "受".repeat(81) })), "over eighty code points");
  refuses(roster(member({ displayName: "受付\u0007A" })), "control character");
});

test("reports whether an active owner remains", () => {
  // The installation must never reach a state with nobody able to administer
  // it, so this is the predicate every roster write is checked against.
  const noOwner = parseStaffRoster(
    roster(member({ role: "staff" })),
  );
  assert.equal(hasActiveOwner(noOwner), false);

  const ownerButInactive = parseStaffRoster(
    roster(member({ active: false, credentialDigest: "", deactivatedAt: CREATED })),
  );
  assert.equal(hasActiveOwner(ownerButInactive), false);

  const empty = parseStaffRoster(roster());
  assert.equal(hasActiveOwner(empty), false);
});
