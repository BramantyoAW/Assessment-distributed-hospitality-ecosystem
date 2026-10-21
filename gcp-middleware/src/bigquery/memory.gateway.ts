/**
 * In-memory warehouse, used by every local test and by the `memory` gateway.
 *
 * It is not a stub that returns canned answers: it stores rows, applies the same
 * "newest wins" rule as `vw_fact_*`, and aggregates with the same
 * aggregate-before-join shape as `CONVERSION_METRICS_SQL`. A test that inserts the
 * same transaction twice therefore exercises the rule instead of assuming it, and
 * the conversion fixture (0.12, not 0.04) fails here if the shape regresses.
 *
 * Dedupe runs at read time, not at insert time, because that is when the SQL view
 * runs. A late-arriving older version must lose to the row already there;
 * deduping on insert would let it overwrite.
 */

import type { Comparator } from '../ingest/dedupe.js';
import { dedupeByKey } from '../ingest/dedupe.js';
import { toDayBucketStart, toHourBucketStart } from '../lib/business-date.js';
import type {
  BigQueryGateway,
  CameraEventFact,
  CheckpointRecord,
  ConversionRecord,
  LocationRecord,
  TransactionFact,
  TransactionQuery,
  VisitorCountQuery,
  VisitorCountRecord,
} from './gateway.js';

const newerTransaction: Comparator<TransactionFact> = (a, b) => {
  const byModified = Date.parse(a.sourceModifiedAt) - Date.parse(b.sourceModifiedAt);
  if (byModified !== 0) return byModified;
  // R2 ordered the SQL view by ingestedAt alone. An older version can land after
  // a newer one, so the source timestamp must win first; this mirrors that.
  return Date.parse(a.ingestedAt) - Date.parse(b.ingestedAt);
};

const newerCameraEvent: Comparator<CameraEventFact> = (a, b) =>
  Date.parse(a.receivedAt) - Date.parse(b.receivedAt);

/** Matches `database/seed/dim_location.sql`, so the demo queries return rows. */
export const SEED_LOCATIONS: readonly LocationRecord[] = [
  {
    locationId: 'loc-beach-club',
    name: 'Beach Club',
    area: 'beachfront',
    capacity: 400,
    isOutdoor: true,
    timezone: 'Asia/Makassar',
    openedOn: '2024-01-01',
  },
  {
    locationId: 'loc-pool',
    name: 'Main Pool',
    area: 'pool',
    capacity: 120,
    isOutdoor: true,
    timezone: 'Asia/Makassar',
    openedOn: '2024-01-01',
  },
  {
    locationId: 'loc-restaurant',
    name: 'Sunset Restaurant',
    area: 'restaurant',
    capacity: 180,
    isOutdoor: false,
    timezone: 'Asia/Makassar',
    openedOn: '2024-01-01',
  },
  {
    locationId: 'loc-lobby',
    name: 'Lobby',
    area: 'lobby',
    capacity: 80,
    isOutdoor: false,
    timezone: 'Asia/Makassar',
    openedOn: '2024-01-01',
  },
];

export interface MemoryGatewayOptions {
  readonly locations?: readonly LocationRecord[];
}

export function createMemoryGateway(options: MemoryGatewayOptions = {}): BigQueryGateway {
  const locations = options.locations ?? SEED_LOCATIONS;
  const transactions: TransactionFact[] = [];
  const cameraEvents: CameraEventFact[] = [];
  const checkpoints: CheckpointRecord[] = [];

  const dedupedTransactions = (): readonly TransactionFact[] =>
    dedupeByKey(transactions, (row) => row.transactionId, newerTransaction);
  const dedupedCameraEvents = (): readonly CameraEventFact[] =>
    dedupeByKey(cameraEvents, (row) => row.eventId, newerCameraEvent);

  return {
    insertTransactions: async (rows) => {
      transactions.push(...rows);
    },
    insertCameraEvents: async (rows) => {
      cameraEvents.push(...rows);
    },
    readTransactions: async () => dedupedTransactions(),
    readCameraEvents: async () => dedupedCameraEvents(),
    listLocations: async () => locations,

    listTransactions: async (query: TransactionQuery) =>
      dedupedTransactions()
        .filter(
          (row) =>
            row.locationId === query.locationId &&
            row.businessDate >= query.from &&
            row.businessDate <= query.to,
        )
        .slice()
        .sort((a, b) =>
          a.businessDate === b.businessDate
            ? a.transactionId.localeCompare(b.transactionId)
            : b.businessDate.localeCompare(a.businessDate),
        )
        .slice(0, query.limit),

    visitorCounts: async (query: VisitorCountQuery): Promise<readonly VisitorCountRecord[]> => {
      const buckets = new Map<string, VisitorCountRecord>();
      const seenReadings = new Set<string>();

      for (const row of dedupedCameraEvents()) {
        if (row.locationId !== query.locationId) continue;
        if (row.businessDate < query.from || row.businessDate > query.to) continue;
        // COUNT(DISTINCT event_id): the view already guarantees one row per id,
        // but the counter must not depend on that.
        if (seenReadings.has(row.eventId)) continue;
        seenReadings.add(row.eventId);

        const bucketStart =
          query.bucket === 'DAY'
            ? toDayBucketStart(row.observedAt)
            : toHourBucketStart(row.observedAt);
        const key = `${row.locationId}|${bucketStart}`;
        const existing = buckets.get(key);

        buckets.set(key, {
          locationId: row.locationId,
          bucketStart,
          visits: (existing?.visits ?? 0) + row.peopleCount,
          readings: (existing?.readings ?? 0) + 1,
          cameraSeconds: (existing?.cameraSeconds ?? 0) + row.intervalSeconds,
        });
      }

      return [...buckets.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
    },

    conversionMetrics: async (keys): Promise<readonly ConversionRecord[]> => {
      const wanted = new Map<string, { locationId: string; businessDate: string }>();
      for (const key of keys) {
        wanted.set(`${key.locationId}|${key.businessDate}`, key);
      }

      // Aggregated separately, exactly like the SQL: joining the two facts first
      // would multiply transactions by the number of camera readings.
      const money = new Map<string, { count: number; cents: Decimal }>();
      for (const row of dedupedTransactions()) {
        const key = `${row.locationId}|${row.businessDate}`;
        if (!wanted.has(key)) continue;
        const current = money.get(key) ?? { count: 0, cents: ZERO };
        money.set(key, { count: current.count + 1, cents: current.cents.plus(row.amount) });
      }

      const visits = new Map<string, { visits: number; readings: number; seconds: number }>();
      for (const row of dedupedCameraEvents()) {
        const key = `${row.locationId}|${row.businessDate}`;
        if (!wanted.has(key)) continue;
        const current = visits.get(key) ?? { visits: 0, readings: 0, seconds: 0 };
        visits.set(key, {
          visits: current.visits + row.peopleCount,
          readings: current.readings + 1,
          seconds: current.seconds + row.intervalSeconds,
        });
      }

      const records: ConversionRecord[] = [];
      for (const [key, { locationId, businessDate }] of wanted) {
        const txn = money.get(key);
        const visit = visits.get(key);
        if (txn === undefined && visit === undefined) continue;

        records.push({
          locationId,
          businessDate,
          totalTransactions: txn?.count ?? 0,
          totalRevenue: (txn?.cents ?? ZERO).toFixed(2),
          totalVisits: visit?.visits ?? 0,
          totalReadings: visit?.readings ?? 0,
          cameraSeconds: visit?.seconds ?? 0,
          // SAFE_DIVIDE: no visits means "not measurable", not zero.
          conversionRate:
            visit === undefined || visit.visits === 0
              ? null
              : (txn?.count ?? 0) / visit.visits,
        });
      }

      return records.sort(
        (a, b) =>
          a.locationId.localeCompare(b.locationId) ||
          a.businessDate.localeCompare(b.businessDate),
      );
    },

    latestCheckpoint: async (stream) => {
      const matching = checkpoints.filter((record) => record.stream === stream);
      if (matching.length === 0) return null;
      return matching.reduce((newest, record) =>
        Date.parse(record.writtenAt) > Date.parse(newest.writtenAt) ? record : newest,
      );
    },

    appendCheckpoint: async (record) => {
      checkpoints.push(record);
    },
  };
}

/**
 * Exact decimal arithmetic for NUMERIC amounts.
 *
 * `0.1 + 0.2` in floating point is why this exists: revenue totalling a few
 * thousand rows would drift, and a demo that shows 599.9999999999999 is worse
 * than one that shows nothing.
 */
class Decimal {
  readonly #scaled: bigint;
  readonly #scale: number;

  private constructor(scaled: bigint, scale: number) {
    this.#scaled = scaled;
    this.#scale = scale;
  }

  static parse(value: string): Decimal {
    const trimmed = value.trim();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (match === null) throw new TypeError(`not a decimal number: ${value}`);

    const sign = match[1] === '-' ? -1n : 1n;
    const fraction = match[3] ?? '';
    const digits = BigInt(`${match[2]}${fraction}`);
    return new Decimal(sign * digits, fraction.length);
  }

  get scale(): number {
    return this.#scale;
  }

  toScaled(scale: number): bigint {
    return this.#scaled * 10n ** BigInt(scale - this.#scale);
  }

  plus(value: string): Decimal {
    const other = Decimal.parse(value);
    const scale = Math.max(this.#scale, other.#scale, 2);
    return new Decimal(this.toScaled(scale) + other.toScaled(scale), scale);
  }

  toFixed(scale: number): string {
    const negative = this.#scaled < 0n;
    const digits = (negative ? -this.#scaled : this.#scaled).toString().padStart(scale + 1, '0');
    const whole = digits.slice(0, digits.length - scale);
    const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;
    return `${negative ? '-' : ''}${whole}${fraction}`;
  }
}

const ZERO = Decimal.parse('0.00');
