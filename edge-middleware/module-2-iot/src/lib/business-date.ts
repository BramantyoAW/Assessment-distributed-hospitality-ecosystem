/**
 * Business date: the calendar day a venue experienced, not the UTC day.
 *
 * Bali (WITA, UTC+8) means a 00:30 local reading is 16:30 UTC the day before.
 * Deriving the date with `toISOString().slice(0, 10)` puts that reading in the
 * previous day, so a dashboard shows yesterday's footfall at midnight and the
 * conversion rate is wrong with no error anywhere.
 *
 * Duplicated in module-2 and gcp-middleware on purpose: they are separately
 * deployed processes, and a shared package would couple their releases for
 * fifteen lines. `business-date.test.ts` in both trees pins the boundary case.
 */

export const VENUE_TIMEZONE = 'Asia/Makassar';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing !== undefined) return existing;

  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  formatters.set(timeZone, created);
  return created;
}

/** `2026-04-30T16:30:00Z` in `Asia/Makassar` is the business date `2026-05-01`. */
export function toBusinessDate(isoTimestamp: string, timeZone: string = VENUE_TIMEZONE): string {
  const instant = new Date(isoTimestamp);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`not an ISO 8601 timestamp: ${isoTimestamp}`);
  }

  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: 'year' | 'month' | 'day'): string => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) throw new Error(`timezone formatting dropped the ${type} part`);
    return found.value;
  };

  return `${read('year')}-${read('month')}-${read('day')}`;
}
