// Shared fixtures for the LINE adapter suites. Fictional values only.
import { env } from "cloudflare:test";

import type { AdapterDelivery } from "../src/adapter-delivery.ts";
import type { InstallationConfig, ReadinessRuntime } from "../src/installation-config.ts";
import type { DayConfig, ReservationDay } from "../src/reservation-day.ts";

export const LINE_TEST_SECRET = "line-test-channel-secret-0123456789abcdef";

export const identifiers = {
  liffId: "1234567890-abcdefgh",
  loginChannelId: "1234567890",
  messagingChannelId: "9876543210",
};

export const lineDay: DayConfig & {
  settingsVersion: number;
  resources: Array<{ id: string; label: string; active: boolean }>;
  services: Array<{
    id: string;
    label: string;
    category: string | null;
    durationMinutes: number;
    cleanupMinutes: number;
    priceYen: number | null;
    eligibleResourceIds: string[];
    active: boolean;
  }>;
  opensAt: string;
  closesAt: string;
  startIntervalMinutes: number;
  consentVersion: string;
} = {
  date: "2025-01-15",
  settingsVersion: 7,
  resourceIds: ["resource-chair-a"],
  resources: [{ id: "resource-chair-a", label: "架空チェア A", active: true }],
  services: [
    {
      id: "service-cut",
      label: "架空カット",
      category: "ヘア",
      durationMinutes: 45,
      cleanupMinutes: 15,
      priceYen: 4_000,
      eligibleResourceIds: ["resource-chair-a"],
      active: true,
    },
  ],
  opensAt: "09:00",
  closesAt: "13:00",
  startIntervalMinutes: 30,
  startTimes: ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00"],
  slotMinutes: 60,
  consentVersion: "consent-v2",
  purgeAt: Date.parse("2100-01-01T00:00:00.000Z"),
};

export const dayStub = (date = lineDay.date) =>
  env.RESERVATION_DAYS.getByName(
    `single-location:${date}`,
  ) as unknown as DurableObjectStub<ReservationDay>;

export const deliveryStub = () =>
  env.ADAPTER_DELIVERY.getByName(
    "installation",
  ) as unknown as DurableObjectStub<AdapterDelivery>;

export const installationStub = () =>
  env.INSTALLATION_CONFIG.getByName(
    "installation",
  ) as unknown as DurableObjectStub<InstallationConfig>;

export const testRuntime = (
  overrides: Partial<ReadinessRuntime> = {},
): ReadinessRuntime => ({
  ownerSecretPresent: true,
  ownerAuthenticated: true,
  turnstileSecretPresent: true,
  lineSecretPresent: true,
  hostname: "example.test",
  ...overrides,
});

export const enableLineAdapter = async (): Promise<void> => {
  const settings = await installationStub().executeLineCommand(
    {
      operation: "line.settings",
      commandId: crypto.randomUUID(),
      expectedLifecycleVersion: 0,
      identifiers,
    },
    testRuntime(),
  );
  if (!settings.ok) throw new Error("settings command failed");
  const enabled = await installationStub().executeLineCommand(
    {
      operation: "line.enable",
      commandId: crypto.randomUUID(),
      expectedLifecycleVersion: settings.lifecycleVersion,
      identifiers,
    },
    testRuntime(),
  );
  if (!enabled.ok) throw new Error("enable command failed");
};

export const MANAGEMENT_KEY = "K".repeat(43);

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const createPendingReservation = async (): Promise<string> => {
  const created = await dayStub().createPublic(lineDay, {
    commandId: crypto.randomUUID(),
    settingsVersion: lineDay.settingsVersion,
    serviceIds: ["service-cut"],
    resourceId: "resource-chair-a",
    date: lineDay.date,
    startTime: "09:00",
    customerName: "架空 花子",
    contact: "hanako@example.invalid",
    consentVersion: lineDay.consentVersion,
    managementDigest: await sha256Hex(MANAGEMENT_KEY),
  });
  if (!created.ok) throw new Error("fixture reservation failed");
  return created.reservationId;
};

export const signWebhookBody = async (
  secret: string,
  body: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
};
