const LOCATION_ID = /^[a-z][a-z0-9-]{0,31}$/;

const validId = (id) =>
  typeof id === "string" && LOCATION_ID.test(id) && !id.endsWith("-");

export const validLocationDirectory = (entries, requireDefault = true) => {
  if (!Array.isArray(entries) || entries.length > 4 || (requireDefault && entries.length === 0)) {
    return false;
  }
  const ids = new Set();
  for (const entry of entries) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      !validId(entry.id) || ids.has(entry.id) ||
      typeof entry.label !== "string" ||
      entry.label.trim() !== entry.label ||
      [...entry.label].length < 1 || [...entry.label].length > 80 ||
      typeof entry.bookable !== "boolean"
    ) return false;
    ids.add(entry.id);
  }
  return !requireDefault || ids.has("default");
};

export const explicitLocation = (search) => {
  const ids = new URLSearchParams(search).getAll("location");
  if (ids.length === 0) return null;
  if (ids.length !== 1 || !validId(ids[0])) throw new Error("場所の指定を確認できません。リンクを確認してください。");
  return ids[0];
};

export const storageKey = (base, locationId) => {
  if (!validId(locationId)) throw new TypeError("Invalid location");
  return locationId === "default" ? base : `${base}:location:${locationId}`;
};

export const scopedPath = (path, locationId) => {
  if (!validId(locationId)) throw new TypeError("Invalid location");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\t\r\n]/.test(path)) {
    throw new TypeError("Expected same-origin path");
  }
  const url = new URL(path, "https://scope.invalid");
  // Dot-segment normalization can expose a network-path prefix.
  if (url.origin !== "https://scope.invalid" || url.pathname.startsWith("//")) {
    throw new TypeError("Expected same-origin path");
  }
  if (url.searchParams.has("location")) throw new TypeError("Location already specified");
  if (locationId === "default") return path;
  url.searchParams.set("location", locationId);
  return `${url.pathname}${url.search}${url.hash}`;
};

export const choosePublicLocation = (locations, explicit, defaultPending) => {
  if (explicit !== null) return locations.some(({ id }) => id === explicit) ? explicit : null;
  if (defaultPending || locations.some(({ id, bookable }) => id === "default" && bookable)) {
    return "default";
  }
  return locations.find(({ bookable }) => bookable)?.id ?? "default";
};

export const chooseOperatorLocation = (locations, explicit) => {
  if (explicit !== null) return locations.some(({ id }) => id === explicit) ? explicit : null;
  return locations.find(({ id }) => id === "default")?.id ?? locations[0]?.id ?? null;
};

export const aggregateOwnedProofs = (locations, readRecords) => {
  const proofs = locations.flatMap(({ id, label }) =>
    readRecords(id).slice(-16).map((record) => ({ locationId: id, label, record })));
  return locations.length === 1
    ? proofs
    : proofs.sort((left, right) =>
      right.record.savedAt - left.record.savedAt ||
      left.locationId.localeCompare(right.locationId));
};
