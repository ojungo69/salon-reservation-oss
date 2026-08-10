/**
 * Parse a YYYY-MM-DD date string as JST midnight and return the UTC ISO string.
 * Returns null for invalid or non-existent dates (e.g. 2026-02-30).
 */
export const parseDateJstToUtcIso = (dateStr: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
