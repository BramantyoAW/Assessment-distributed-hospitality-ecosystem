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

function formatterFor(timeZone: string, withHour: boolean): Intl.DateTimeFormat {
  const key = `${timeZone}|${withHour ? 'hour' : 'date'}`;
  const existing = formatters.get(key);
  if (existing !== undefined) return existing;

  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withHour ? { hour: '2-digit', hour12: false } : {}),
  });
  formatters.set(key, created);
  return created;
}

function partsOf(isoTimestamp: string, timeZone: string, withHour: boolean): string[] {
  const instant = new Date(isoTimestamp);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`not an ISO 8601 timestamp: ${isoTimestamp}`);
  }

  const parts = formatterFor(timeZone, withHour).formatToParts(instant);
  const read = (type: 'year' | 'month' | 'day' | 'hour'): string => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) throw new Error(`timezone formatting dropped the ${type} part`);
    return found.value;
  };

  // Some ICU builds render midnight as 24; `en-US` with hour12:false may too.
  const hour = withHour ? (read('hour') === '24' ? '00' : read('hour')) : '00';
  return [read('year'), read('month'), read('day'), hour];
}

/** `2026-04-30T16:30:00Z` in `Asia/Makassar` is the business date `2026-05-01`. */
export function toBusinessDate(isoTimestamp: string, timeZone: string = VENUE_TIMEZONE): string {
  const [year, month, day] = partsOf(isoTimestamp, timeZone, false);
  return `${year}-${month}-${day}`;
}

/**
 * Start of the containing hour, as an ISO 8601 string with the venue offset.
 *
 * Asia/Makassar has no daylight saving and is a fixed UTC+8, so a fixed offset is
 * exact here. A venue with DST would need the offset resolved per instant.
 */
export function toHourBucketStart(
  isoTimestamp: string,
  timeZone: string = VENUE_TIMEZONE,
): string {
  const [year, month, day, hour] = partsOf(isoTimestamp, timeZone, true);
  return `${year}-${month}-${day}T${hour}:00:00+08:00`;
}

/** Start of the business day, as an ISO 8601 string with the venue offset. */
export function toDayBucketStart(
  isoTimestamp: string,
  timeZone: string = VENUE_TIMEZONE,
): string {
  return `${toBusinessDate(isoTimestamp, timeZone)}T00:00:00+08:00`;
}
