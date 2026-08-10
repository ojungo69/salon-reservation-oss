const DAY_MS = 24 * 60 * 60 * 1_000;
const YEAR_MS = 365 * DAY_MS;
const MAX_STORED_BYTES = 16 * 1_024;
const MAX_OWNED_BOOKINGS = 16;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MANAGEMENT_KEY = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value, keys) =>
  isObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const isInteger = (value) => Number.isSafeInteger(value) && value >= 0;

const isIdentifier = (value) => typeof value === "string" && IDENTIFIER.test(value);

const isDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 100 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
};

const isTime = (value) =>
  typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const isString = (value, min, max) =>
  typeof value === "string" &&
  value.trim() === value &&
  Array.from(value).length >= min &&
  Array.from(value).length <= max;

const isServiceIds = (value, min) =>
  Array.isArray(value) &&
  value.length >= min &&
  value.length <= 4 &&
  value.every(isIdentifier) &&
  new Set(value).size === value.length;

const isFresh = (savedAt, now, maxAge) =>
  isInteger(savedAt) && isInteger(now) && now >= savedAt && now - savedAt < maxAge;

const parse = (encoded) => {
  if (typeof encoded !== "string" || encoded.length > MAX_STORED_BYTES) return null;
  try {
    return JSON.parse(encoded);
  } catch {
    return null;
  }
};

const isJourneyDraft = (value) =>
  hasExactKeys(value, [
    "version",
    "settingsVersion",
    "serviceIds",
    "resourceId",
    "date",
    "startTime",
    "step",
    "savedAt",
  ]) &&
  value.version === 1 &&
  isInteger(value.settingsVersion) &&
  value.settingsVersion > 0 &&
  isServiceIds(value.serviceIds, 0) &&
  (value.resourceId === null || isIdentifier(value.resourceId)) &&
  (value.date === null || isDate(value.date)) &&
  (value.startTime === null || isTime(value.startTime)) &&
  ["selection", "details", "review"].includes(value.step) &&
  isInteger(value.savedAt);

const isOwnedBookingRecord = (value) =>
  hasExactKeys(value, ["reservationId", "date", "managementKey", "savedAt"]) &&
  typeof value.reservationId === "string" &&
  UUID.test(value.reservationId) &&
  isDate(value.date) &&
  typeof value.managementKey === "string" &&
  MANAGEMENT_KEY.test(value.managementKey) &&
  isInteger(value.savedAt);

const isPendingMutationRecordBase = (value) =>
  typeof value.commandId === "string" &&
  UUID.test(value.commandId) &&
  typeof value.managementKey === "string" &&
  MANAGEMENT_KEY.test(value.managementKey) &&
  isInteger(value.retryAt);

const isPendingMutationRequest = (value) =>
  isObject(value) &&
  isInteger(value.settingsVersion) &&
  value.settingsVersion > 0 &&
  isServiceIds(value.serviceIds, 1) &&
  isIdentifier(value.resourceId) &&
  isDate(value.date) &&
  isTime(value.startTime) &&
  isString(value.customerName, 1, 80) &&
  isString(value.contact, 3, 200) &&
  isIdentifier(value.consentVersion);

const isPendingMutationRecord = (value) =>
  ((hasExactKeys(value, ["commandId", "request", "managementKey", "retryAt"]) &&
    isPendingMutationRecordBase(value) &&
    hasExactKeys(value.request, [
      "settingsVersion",
      "serviceIds",
      "resourceId",
      "date",
      "startTime",
      "customerName",
      "contact",
      "consentVersion",
      "consent",
    ]) &&
    isPendingMutationRequest(value.request) &&
    value.request.consent === true) ||
    (hasExactKeys(value, ["operation", "commandId", "request", "managementKey", "retryAt"]) &&
      value.operation === "owner-create" &&
      isPendingMutationRecordBase(value) &&
      hasExactKeys(value.request, [
        "settingsVersion",
        "serviceIds",
        "resourceId",
        "date",
        "startTime",
        "customerName",
        "contact",
        "consentVersion",
      ]) &&
      isPendingMutationRequest(value.request)));

const validSelection = (selection) =>
  isObject(selection) &&
  isServiceIds(selection.serviceIds, 1) &&
  isIdentifier(selection.resourceId) &&
  isDate(selection.date) &&
  isTime(selection.startTime);

const validDetails = (details) =>
  isObject(details) &&
  isString(details.customerName, 1, 80) &&
  isString(details.contact, 3, 200) &&
  details.consent === true;

export const getJourneyStep = (state) => {
  if (!isObject(state) || !validSelection(state.selection)) return "selection";
  if (!["selection", "details", "review"].includes(state.requestedStep)) {
    return "selection";
  }
  if (state.requestedStep === "selection") return "selection";
  if (!validDetails(state.details)) return "details";
  return state.requestedStep === "details" ? "details" : "review";
};

export const restoreJourneyDraft = (draft, current) => {
  if (
    !isJourneyDraft(draft) ||
    !isObject(current) ||
    !isInteger(current.settingsVersion) ||
    current.settingsVersion < 1 ||
    !Array.isArray(current.serviceIds) ||
    !Array.isArray(current.resourceIds) ||
    !Array.isArray(current.slots)
  ) {
    return null;
  }

  const resetSelection = (settingsVersion = draft.settingsVersion) => ({
    ...draft,
    settingsVersion,
    serviceIds: [],
    resourceId: null,
    date: null,
    startTime: null,
    step: "selection",
  });

  if (draft.settingsVersion !== current.settingsVersion) {
    return resetSelection(current.settingsVersion);
  }
  if (!draft.serviceIds.every((id) => current.serviceIds.includes(id))) {
    return resetSelection();
  }
  if (draft.resourceId !== null && !current.resourceIds.includes(draft.resourceId)) {
    return { ...draft, resourceId: null, date: null, startTime: null, step: "selection" };
  }
  if (
    draft.resourceId !== null &&
    draft.date !== null &&
    draft.startTime !== null &&
    !current.slots.some(
      (slot) =>
        isObject(slot) &&
        slot.resourceId === draft.resourceId &&
        slot.date === draft.date &&
        slot.startTime === draft.startTime,
    )
  ) {
    return { ...draft, startTime: null, step: "selection" };
  }
  return draft;
};

export const encodeJourneyDraft = (draft) => {
  if (!isJourneyDraft(draft)) throw new TypeError("Invalid journey draft");
  return JSON.stringify(draft);
};

export const decodeJourneyDraft = (encoded, now) => {
  const draft = parse(encoded);
  return isJourneyDraft(draft) && isFresh(draft.savedAt, now, DAY_MS) ? draft : null;
};

export const saveOwnedBookingRecord = (records, record, remember) => {
  if (remember !== true) return [];
  if (!isOwnedBookingRecord(record)) throw new TypeError("Invalid owned booking record");
  const existing = Array.isArray(records)
    ? records.filter(isOwnedBookingRecord).slice(-MAX_OWNED_BOOKINGS)
    : [];
  return [...existing.filter(({ reservationId }) => reservationId !== record.reservationId), record]
    .slice(-MAX_OWNED_BOOKINGS);
};

export const readOwnedBookingRecords = (records, now) =>
  Array.isArray(records)
    ? records.filter(
        (record) => isOwnedBookingRecord(record) && isFresh(record.savedAt, now, YEAR_MS),
      ).slice(-MAX_OWNED_BOOKINGS)
    : [];

export const removeOwnedBookingRecord = (records, reservationId) =>
  Array.isArray(records) && typeof reservationId === "string"
    ? records.filter(
        (record) => isOwnedBookingRecord(record) && record.reservationId !== reservationId,
      ).slice(-MAX_OWNED_BOOKINGS)
    : [];

export const encodePendingMutationRecord = (record) => {
  if (!isPendingMutationRecord(record)) throw new TypeError("Invalid pending mutation record");
  return JSON.stringify(record);
};

export const decodePendingMutationRecord = (encoded, now) => {
  const record = parse(encoded);
  return isPendingMutationRecord(record) && isFresh(record.retryAt, now, DAY_MS)
    ? record
    : null;
};
