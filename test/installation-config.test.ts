import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultInstallationState,
  createInstallationReceipt,
  digestPublicSettings,
  evaluateInstallationReadiness,
  executeInstallationCommand,
  parseInstallationSettings,
  projectPublicConfig,
} from "../src/installation-config.ts";

const NOW = "2026-08-11T00:00:00.000Z";
const TEST_SITE_KEY = "1x00000000000000000000AA";

const readyRuntime = () => ({
  ownerSecretPresent: true,
  ownerAuthenticated: true,
  turnstileSecretPresent: true,
  hostname: "booking.salon.example",
});

const validSettings = () => ({
  locationName: "青空予約室",
  timeZone: "Asia/Tokyo",
  services: [
    {
      id: "service-basic",
      label: "基本サービス",
      category: "予約",
      durationMinutes: 60,
      cleanupMinutes: 15,
      priceYen: 5_000,
      eligibleResourceIds: ["resource-a"],
      active: true,
    },
  ],
  resources: [{ id: "resource-a", label: "担当 A", active: true }],
  opensAt: "09:00",
  closesAt: "17:00",
  startIntervalMinutes: 30,
  openWeekdays: [1, 2, 3, 4, 5, 6],
  horizonDays: 60,
  retentionDays: 30,
  pendingExpiryMinutes: 720,
  consentVersion: "consent-v1",
  operatorDisplayName: "青空予約室 運営者",
  operatorContact: "お問い合わせフォームをご利用ください",
  privacyNotice: "予約の受付に必要な情報だけを利用します。",
  termsNotice: "表示内容を確認してから予約を送信してください。",
  cancellationPolicy: "予約の管理画面からキャンセルできます。",
  sourceUrl: "https://github.com/public-fixture/salon-reservation",
  turnstileSiteKey: "public-site-key-fixture-7d2f4c90",
  allowedHostname: "booking.salon.example",
  themeId: "ink",
});

type Settings = ReturnType<typeof validSettings>;
type InstallationState = ReturnType<typeof createDefaultInstallationState>;

const maximumSettings = (): Settings => {
  const settings = validSettings();
  settings.locationName = "😀".repeat(80);
  settings.resources = Array.from({ length: 8 }, (_, index) => ({
    id: `resource-${index}`,
    label: "😀".repeat(80),
    active: true,
  }));
  settings.services = Array.from({ length: 16 }, (_, index) => ({
    id: `service-${index}`,
    label: "😀".repeat(80),
    category: "😀".repeat(60),
    durationMinutes: 480,
    cleanupMinutes: 120,
    priceYen: 10_000_000,
    eligibleResourceIds: settings.resources.map(({ id }) => id),
    active: true,
  }));
  Object.assign(settings, {
    opensAt: "00:00",
    closesAt: "23:59",
    startIntervalMinutes: 240,
    openWeekdays: [0, 1, 2, 3, 4, 5, 6],
    horizonDays: 90,
    retentionDays: 365,
    pendingExpiryMinutes: 10_080,
    consentVersion: "c".repeat(64),
    operatorDisplayName: "😀".repeat(120),
    operatorContact: "😀".repeat(200),
    privacyNotice: "😀".repeat(500),
    termsNotice: "😀".repeat(500),
    cancellationPolicy: "😀".repeat(500),
    turnstileSiteKey: "k".repeat(128),
    allowedHostname: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
    themeId: "clay",
  });
  return settings;
};

const commandId = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const updateCommand = (
  index: number,
  expectedSettingsVersion: number,
  settings: unknown,
) => ({
  type: "settings.update" as const,
  commandId: commandId(index),
  expectedSettingsVersion,
  settings,
});

const applyUpdate = async (
  state: InstallationState,
  index: number,
  settings: unknown,
) => {
  const result = await executeInstallationCommand(
    state,
    updateCommand(index, state.activeSettingsVersion, settings),
    { ...readyRuntime(), now: NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result;
};

test("fictional defaults stay demo-only while projecting all public legal notices", async () => {
  const state = createDefaultInstallationState(NOW);
  const active = state.settingsVersions.find(
    ({ version }) => version === state.activeSettingsVersion,
  );
  assert.ok(active);

  const publicConfig = projectPublicConfig(state);
  assert.equal(state.mode, "demo");
  assert.equal(state.activeSettingsVersion, 1);
  assert.equal(new URL(active.settings.sourceUrl).hostname.endsWith(".invalid"), true);
  assert.equal(publicConfig.privacyNotice, active.settings.privacyNotice);
  assert.equal(publicConfig.termsNotice, active.settings.termsNotice);
  assert.equal(publicConfig.cancellationPolicy, active.settings.cancellationPolicy);
  assert.equal(Object.hasOwn(publicConfig, "retentionDays"), false);
  assert.equal(publicConfig.turnstileSiteKey, active.settings.turnstileSiteKey);
  assert.equal(Object.hasOwn(publicConfig, "allowedHostname"), false);

  const live = await executeInstallationCommand(
    state,
    {
      type: "settings.live",
      commandId: commandId(1),
      expectedSettingsVersion: 1,
      live: true,
    },
    { ...readyRuntime(), now: NOW },
  );
  assert.equal(live.ok, false);
  if (live.ok) return;
  assert.equal(live.state.mode, "demo");
  assert.ok(live.error.blockers.includes("identity"));
});

test("accepts exact settings boundaries and rejects adjacent invalid values", () => {
  const minimum = validSettings();
  Object.assign(minimum, {
    locationName: "場",
    services: [
      {
        id: "s",
        label: "施",
        category: null,
        durationMinutes: 15,
        cleanupMinutes: 0,
        priceYen: 0,
        eligibleResourceIds: ["r"],
        active: true,
      },
    ],
    resources: [{ id: "r", label: "担", active: true }],
    opensAt: "00:00",
    closesAt: "00:15",
    startIntervalMinutes: 15,
    openWeekdays: [0],
    horizonDays: 1,
    retentionDays: 1,
    pendingExpiryMinutes: 15,
    consentVersion: "v",
    operatorDisplayName: "運",
    operatorContact: "連絡先",
    privacyNotice: "文",
    termsNotice: "文",
    cancellationPolicy: "文",
  });

  const maximum = maximumSettings();

  assert.doesNotThrow(() => parseInstallationSettings(minimum));
  assert.doesNotThrow(() => parseInstallationSettings(maximum));

  const invalidCases: Array<[string, (settings: Settings) => void]> = [
    ["locationName", (value) => { value.locationName = "😀".repeat(81); }],
    ["timeZone", (value) => { value.timeZone = "UTC"; }],
    ["services", (value) => { value.services = []; }],
    ["resources", (value) => { value.resources = []; }],
    ["durationMinutes", (value) => { value.services[0]!.durationMinutes = 14; }],
    ["cleanupMinutes", (value) => { value.services[0]!.cleanupMinutes = 121; }],
    ["priceYen", (value) => { value.services[0]!.priceYen = 10_000_001; }],
    ["eligibleResourceIds", (value) => { value.services[0]!.eligibleResourceIds = ["missing"]; }],
    ["duplicate service id", (value) => { value.services.push({ ...value.services[0]! }); }],
    ["duplicate resource id", (value) => { value.resources.push({ ...value.resources[0]! }); }],
    ["hours", (value) => { value.closesAt = value.opensAt; }],
    ["startIntervalMinutes", (value) => { value.startIntervalMinutes = 241; }],
    ["openWeekdays", (value) => { value.openWeekdays = [1, 1]; }],
    ["horizonDays", (value) => { value.horizonDays = 91; }],
    ["retentionDays", (value) => { value.retentionDays = 366; }],
    ["consentVersion", (value) => { value.consentVersion = "c".repeat(65); }],
    ["operatorDisplayName", (value) => { value.operatorDisplayName = "😀".repeat(121); }],
    ["operatorContact", (value) => { value.operatorContact = "😀".repeat(201); }],
    ["privacyNotice", (value) => { value.privacyNotice = "😀".repeat(501); }],
    ["termsNotice", (value) => { value.termsNotice = ""; }],
    ["cancellationPolicy", (value) => { value.cancellationPolicy = ""; }],
    ["sourceUrl", (value) => { value.sourceUrl = "http://example.invalid/source"; }],
    ["sourceUrl credentials", (value) => { value.sourceUrl = "https://user:pass@example.invalid/source"; }],
    ["turnstileSiteKey", (value) => { value.turnstileSiteKey = "k".repeat(129); }],
    ["allowedHostname", (value) => { value.allowedHostname = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`; }],
    ["themeId", (value) => { value.themeId = "unknown"; }],
    ["96 offerings", (value) => {
      value.resources = Array.from({ length: 8 }, (_, index) => ({
        id: `resource-${index}`,
        label: `担当 ${index}`,
        active: true,
      }));
      value.services[0]!.eligibleResourceIds = value.resources.map(({ id }) => id);
      value.services[0]!.durationMinutes = 15;
      value.services[0]!.cleanupMinutes = 0;
      value.opensAt = "00:00";
      value.closesAt = "03:15";
      value.startIntervalMinutes = 15;
    }],
  ];

  for (const [label, mutate] of invalidCases) {
    const value = validSettings();
    mutate(value);
    assert.throws(() => parseInstallationSettings(value), undefined, label);
  }

  assert.throws(
    () => parseInstallationSettings({ ...validSettings(), unexpected: true }),
    undefined,
    "unknown top-level field",
  );
});

test("normalizes an empty service category and rejects control characters from public snapshots", () => {
  const emptyCategory = validSettings();
  emptyCategory.services[0]!.category = "";
  assert.equal(parseInstallationSettings(emptyCategory).services[0]!.category, null);

  const punctuation = validSettings();
  punctuation.services[0]!.label = "カット & ケア (A/B) #1";
  punctuation.services[0]!.category = "予約: 基本 / A-B";
  punctuation.resources[0]!.label = "担当 A/B #1";
  assert.deepEqual(parseInstallationSettings(punctuation).services[0], {
    ...punctuation.services[0],
  });
  assert.equal(
    parseInstallationSettings(punctuation).resources[0]!.label,
    punctuation.resources[0]!.label,
  );

  const controlCharacterCases: Array<[string, (settings: Settings) => void]> = [
    ["service label newline", (settings) => { settings.services[0]!.label = "基本\nサービス"; }],
    ["service category NUL", (settings) => { settings.services[0]!.category = "予約\0基本"; }],
    ["resource label newline", (settings) => { settings.resources[0]!.label = "担当\nA"; }],
  ];
  for (const [label, mutate] of controlCharacterCases) {
    const settings = validSettings();
    mutate(settings);
    assert.throws(() => parseInstallationSettings(settings), undefined, label);
  }
});

test("produces one canonical SHA-256 digest independent of object key order", async () => {
  const settings = validSettings();
  const reordered = Object.fromEntries(Object.entries(settings).reverse());
  const digest = await digestPublicSettings(settings);

  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(await digestPublicSettings(reordered), digest);

  const changed = structuredClone(settings);
  changed.privacyNotice = `${changed.privacyNotice} 更新`;
  assert.notEqual(await digestPublicSettings(changed), digest);
});

test("reports owner, protection, identity, and capacity as four independent readiness gates", () => {
  const settings = validSettings();
  assert.deepEqual(evaluateInstallationReadiness(settings, readyRuntime()), {
    ready: true,
    owner: true,
    protection: true,
    identity: true,
    capacity: true,
    blockers: [],
  });

  const identityPlaceholder = structuredClone(settings);
  identityPlaceholder.privacyNotice = "設定してください";
  const testProtection = structuredClone(settings);
  testProtection.turnstileSiteKey = TEST_SITE_KEY;
  const invalidCapacity = structuredClone(settings);
  invalidCapacity.services[0]!.eligibleResourceIds = ["missing"];

  const cases = [
    ["owner", settings, { ...readyRuntime(), ownerAuthenticated: false }],
    ["protection", testProtection, readyRuntime()],
    ["identity", identityPlaceholder, readyRuntime()],
    ["capacity", invalidCapacity, readyRuntime()],
  ] as const;

  for (const [failedGate, candidate, runtime] of cases) {
    const readiness = evaluateInstallationReadiness(candidate, runtime);
    assert.equal(readiness.ready, false, failedGate);
    assert.deepEqual(readiness.blockers, [failedGate], failedGate);
  }
});

test("rejects a new settings command with a stale expected version without changing state", async () => {
  const state = createDefaultInstallationState(NOW);
  const before = structuredClone(state);
  const result = await executeInstallationCommand(
    state,
    updateCommand(1, 2, validSettings()),
    { ...readyRuntime(), now: NOW },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error, {
    code: "CONFIGURATION_CONFLICT",
    expectedSettingsVersion: 2,
    actualSettingsVersion: 1,
  });
  assert.deepEqual(result.state, before);
});

test("requires a new consent version for changed legal copy while preserving receipt replay", async () => {
  const configured = await applyUpdate(createDefaultInstallationState(NOW), 1, validSettings());

  for (const field of ["privacyNotice", "termsNotice", "cancellationPolicy"] as const) {
    const changed = validSettings();
    changed[field] = `${changed[field]} 改定`;
    const rejected = await executeInstallationCommand(
      configured.state,
      updateCommand(field === "privacyNotice" ? 2 : field === "termsNotice" ? 3 : 4, 2, changed),
      { ...readyRuntime(), now: NOW },
    );
    assert.equal(rejected.ok, false, field);
    if (rejected.ok) return;
    assert.deepEqual(rejected.error, { code: "INVALID_COMMAND" }, field);
    assert.deepEqual(rejected.state, configured.state, field);
  }

  const revised = validSettings();
  revised.privacyNotice = `${revised.privacyNotice} 改定`;
  revised.consentVersion = "consent-v2";
  const command = updateCommand(5, 2, revised);
  const accepted = await executeInstallationCommand(configured.state, command, {
    ...readyRuntime(),
    now: NOW,
  });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.outcome.settingsVersion, 3);

  const replay = await executeInstallationCommand(accepted.state, command, {
    ...readyRuntime(),
    now: NOW,
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.outcome.replayed, true);
  assert.equal(replay.outcome.settingsVersion, 3);
  assert.deepEqual(replay.state, accepted.state);
});

test("checks a command receipt before versioning and rejects mismatched command-id reuse", async () => {
  const state = createDefaultInstallationState(NOW);
  const command = updateCommand(1, 1, validSettings());
  const accepted = await executeInstallationCommand(state, command, {
    ...readyRuntime(),
    now: NOW,
  });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.outcome.replayed, false);
  assert.match(accepted.state.receipts[0]!.fingerprint, /^[a-f0-9]{64}$/);

  const reordered = {
    ...command,
    settings: Object.fromEntries(Object.entries(command.settings).reverse()),
  };
  const replay = await executeInstallationCommand(accepted.state, reordered, {
    ...readyRuntime(),
    now: NOW,
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.outcome.replayed, true);
  assert.equal(replay.outcome.settingsVersion, 2);
  assert.deepEqual(replay.state, accepted.state);

  const different = validSettings();
  different.locationName = "別の予約室";
  const mismatch = await executeInstallationCommand(
    accepted.state,
    updateCommand(1, 1, different),
    { ...readyRuntime(), now: NOW },
  );
  assert.equal(mismatch.ok, false);
  if (mismatch.ok) return;
  assert.equal(mismatch.error.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(mismatch.state, accepted.state);
});

test("recomputes replay readiness from the current runtime without changing the accepted live outcome", async () => {
  const configured = await applyUpdate(createDefaultInstallationState(NOW), 1, validSettings());
  const command = {
    type: "settings.live" as const,
    commandId: commandId(2),
    expectedSettingsVersion: configured.state.activeSettingsVersion,
    live: true,
  };
  const accepted = await executeInstallationCommand(configured.state, command, {
    ...readyRuntime(),
    now: NOW,
  });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.outcome.mode, "live");
  assert.equal(accepted.outcome.readiness.ready, true);

  const replay = await executeInstallationCommand(accepted.state, command, {
    ...readyRuntime(),
    turnstileSecretPresent: false,
    now: NOW,
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.outcome.mode, accepted.outcome.mode);
  assert.equal(replay.outcome.settingsVersion, accepted.outcome.settingsVersion);
  assert.deepEqual(replay.outcome.settings, accepted.outcome.settings);
  assert.equal(replay.outcome.replayed, true);
  assert.deepEqual(replay.outcome.readiness, {
    ready: false,
    owner: true,
    protection: false,
    identity: true,
    capacity: true,
    blockers: ["protection"],
  });
  assert.deepEqual(replay.state, accepted.state);
});

test("deterministically compacts settings to 32 versions and 64 receipts", async () => {
  let state = createDefaultInstallationState(NOW);

  for (let index = 1; index <= 70; index += 1) {
    const settings = validSettings();
    settings.locationName = `青空予約室 ${index}`;
    const result = await applyUpdate(state, index, settings);
    state = result.state;
  }

  assert.equal(state.activeSettingsVersion, 71);
  assert.deepEqual(
    state.settingsVersions.map(({ version }) => version),
    Array.from({ length: 32 }, (_, index) => index + 40),
  );
  assert.equal(state.receipts.length, 64);
  assert.equal(state.receipts[0]!.commandId, commandId(7));
  assert.equal(state.receipts.at(-1)!.commandId, commandId(70));
});

test("keeps maximum-size settings history under the single-row storage byte budget", async () => {
  let state = createDefaultInstallationState(NOW);

  for (let index = 1; index < 70; index += 1) {
    state = (await applyUpdate(state, index, maximumSettings())).state;
  }

  const latestSettings = maximumSettings();
  const latestCommand = updateCommand(70, state.activeSettingsVersion, latestSettings);
  const latest = await executeInstallationCommand(state, latestCommand, {
    ...readyRuntime(),
    now: NOW,
  });
  assert.equal(latest.ok, true);
  if (!latest.ok) return;
  state = latest.state;

  const storedBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  assert.ok(
    storedBytes < 1_800_000,
    `serialized installation state is ${storedBytes} bytes`,
  );
  assert.equal(state.activeSettingsVersion, 71);
  assert.ok(state.settingsVersions.length < 32);
  assert.equal(state.receipts.length, 64);
  assert.equal(state.settingsVersions.at(-1)!.version, 71);
  assert.deepEqual(state.settingsVersions.at(-1)!.settings, latestSettings);

  const oldestReplay = await executeInstallationCommand(
    state,
    updateCommand(7, 7, maximumSettings()),
    { ...readyRuntime(), now: NOW },
  );
  assert.equal(oldestReplay.ok, true);
  if (!oldestReplay.ok) return;
  assert.equal(oldestReplay.outcome.replayed, true);
  assert.equal(oldestReplay.outcome.settingsVersion, 8);
  assert.deepEqual(oldestReplay.outcome.settings, latestSettings);
  assert.deepEqual(oldestReplay.state, state);

  const replay = await executeInstallationCommand(state, latestCommand, {
    ...readyRuntime(),
    now: NOW,
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.outcome.replayed, true);
  assert.equal(replay.outcome.settingsVersion, 71);
  assert.deepEqual(replay.outcome.settings, latestSettings);
  assert.deepEqual(replay.state, state);
});

test("creates an exact secret-free installation receipt", async () => {
  const initial = createDefaultInstallationState(NOW);
  const updated = await applyUpdate(initial, 1, validSettings());
  const receipt = await createInstallationReceipt(updated.state, {
    ...readyRuntime(),
    applicationVersion: "0.2.0",
    now: NOW,
  });

  assert.deepEqual(Object.keys(receipt).sort(), [
    "applicationVersion",
    "consentPolicy",
    "createdAt",
    "dayPartitionPolicy",
    "guidance",
    "mode",
    "readiness",
    "resourceKinds",
    "settingsDigest",
    "settingsEffectiveAt",
    "settingsVersion",
  ]);
  assert.equal(receipt.applicationVersion, "0.2.0");
  assert.equal(receipt.settingsVersion, 2);
  assert.equal(receipt.settingsEffectiveAt, NOW);
  assert.equal(receipt.dayPartitionPolicy, "pinned_until_purge");
  assert.equal(receipt.consentPolicy, "current_at_acceptance");
  assert.match(receipt.settingsDigest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.settingsDigest, await digestPublicSettings(validSettings()));
  assert.equal(receipt.readiness.ready, true);
  assert.equal(new Set(receipt.resourceKinds).size, receipt.resourceKinds.length);
  assert.deepEqual(Object.keys(receipt.guidance).sort(), [
    "deletion",
    "export",
    "recovery",
    "rollback",
    "setup",
  ]);
  assert.equal(receipt.guidance.setup, "/setup.html");
  assert.equal(receipt.guidance.export, "/privacy.html#data-export");
  assert.notEqual(receipt.guidance.export, validSettings().sourceUrl);
  for (const link of [
    receipt.guidance.rollback,
    receipt.guidance.recovery,
    receipt.guidance.deletion,
  ]) {
    assert.equal(new URL(link).protocol, "https:");
  }
  assert.doesNotMatch(JSON.stringify(receipt), /customer|ownerToken|secret|turnstileSecret/i);
});

test("settings stored before the pending lifetime existed still round-trip byte for byte", () => {
  const legacy = validSettings();
  delete (legacy as Partial<Settings>).pendingExpiryMinutes;
  const stored = JSON.stringify(legacy);

  // This is what the Durable Object asserts on every read: re-serialising the
  // stored settings has to reproduce the stored string exactly. A parser that
  // filled the missing key in would turn every installation created before the
  // key existed into corrupt storage.
  const parsed = parseInstallationSettings(JSON.parse(stored));
  assert.equal(JSON.stringify(parsed), stored);
  assert.equal(Object.hasOwn(parsed, "pendingExpiryMinutes"), false);

  const configured = parseInstallationSettings({ ...legacy, pendingExpiryMinutes: 15 });
  assert.equal(configured.pendingExpiryMinutes, 15);
  for (const invalid of [14, 10_081, 0, -15, 1.5, "60", null]) {
    assert.throws(() =>
      parseInstallationSettings({ ...legacy, pendingExpiryMinutes: invalid }),
    );
  }
});
