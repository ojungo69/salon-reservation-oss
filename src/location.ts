import { parseDateJstToUtcIso } from "./date-parse.ts";

export const DEFAULT_LOCATION_ID = "default";
export const MAX_LOCATIONS = 4;

export const parseLocationId = (value: unknown): string | null =>
  typeof value === "string" &&
  /^[a-z][a-z0-9-]{0,31}$/.test(value) &&
  !value.endsWith("-")
    ? value
    : null;

const requireLocationId = (value: string): string => {
  const locationId = parseLocationId(value);
  if (locationId === null) throw new Error("Invalid location identity");
  return locationId;
};

export const adapterObjectName = (locationId: string): string =>
  requireLocationId(locationId) === DEFAULT_LOCATION_ID
    ? "installation"
    : `location:${locationId}`;

export const dayObjectName = (locationId: string, date: string): string => {
  requireLocationId(locationId);
  if (typeof date !== "string" || parseDateJstToUtcIso(date) === null) {
    throw new Error("Invalid location date");
  }
  return locationId === DEFAULT_LOCATION_ID
    ? `single-location:${date}`
    : `location:${locationId}:${date}`;
};

export const locationFromAdapterId = (
  id: DurableObjectId,
  legacyId: DurableObjectId,
): string => {
  if (id.name === undefined || id.name === "installation") {
    if (id.equals(legacyId)) return DEFAULT_LOCATION_ID;
    throw new Error("Invalid adapter identity");
  }
  const locationId = parseLocationId(/^location:([^:]+)$/.exec(id.name)?.[1]);
  if (locationId === null || locationId === DEFAULT_LOCATION_ID) {
    throw new Error("Invalid adapter identity");
  }
  return locationId;
};

export const locationFromDayId = (
  id: DurableObjectId,
  date: string,
  legacyId: DurableObjectId,
): string => {
  const legacyName = dayObjectName(DEFAULT_LOCATION_ID, date);
  if (id.name === undefined || id.name === legacyName) {
    if (id.equals(legacyId)) return DEFAULT_LOCATION_ID;
    throw new Error("Invalid day identity");
  }
  const parts = /^location:([^:]+):([^:]+)$/.exec(id.name);
  const locationId = parseLocationId(parts?.[1]);
  if (locationId === null || locationId === DEFAULT_LOCATION_ID || parts?.[2] !== date) {
    throw new Error("Invalid day identity");
  }
  return locationId;
};
