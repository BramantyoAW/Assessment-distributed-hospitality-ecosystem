/**
 * DataLoaders: the answer to GraphQL's N+1 problem.
 *
 * A query for 50 transactions across 4 locations is 51 naive lookups (one per
 * `Transaction.location`) plus 50 metric lookups. A DataLoader collapses each
 * field into ONE batched call per tick, so the cost becomes 2 queries regardless
 * of page size. `dataloader.test.ts` asserts the call counts, not just the values:
 * a cache would also return correct values here, and caching was never the bug.
 *
 * Two loaders, deliberately separate:
 *   - `location`: id -> dimension row
 *   - `conversion`: (locationId, date) -> aggregate row
 *
 * They stay separate because they batch on different keys and hit different
 * queries; merging them would force one to be a per-tick no-op.
 */

import DataLoader from 'dataloader';

import type { BigQueryGateway, ConversionRecord, LocationRecord } from '../bigquery/gateway.js';

export interface Loaders {
  readonly location: DataLoader<string, LocationRecord | null>;
  readonly conversion: DataLoader<string, ConversionRecord | null>;
}

/** The conversion loader's key: one location-day. */
export function conversionKey(locationId: string, date: string): string {
  return `${locationId}|${date}`;
}

function parseConversionKey(key: string): { locationId: string; businessDate: string } {
  const separator = key.indexOf('|');
  if (separator <= 0) {
    throw new Error(`malformed conversion key: ${key}`);
  }
  return {
    locationId: key.slice(0, separator),
    businessDate: key.slice(separator + 1),
  };
}

export function createLoaders(gateway: BigQueryGateway): Loaders {
  const location = new DataLoader<string, LocationRecord | null>(async (ids) => {
    // The dimension has a handful of rows, so one full read is cheaper than an
    // `IN (…)` list that grows with the request. Documented ceiling: this is only
    // correct while `dim_location` stays small.
    const all = await gateway.listLocations();
    const index = new Map(all.map((row) => [row.locationId, row]));
    return ids.map((id) => index.get(id) ?? null);
  });

  const conversion = new DataLoader<string, ConversionRecord | null>(async (keys) => {
    const requested = keys.map((key) => parseConversionKey(key));
    const records = await gateway.conversionMetrics(requested);
    const index = new Map(
      records.map((record) => [conversionKey(record.locationId, record.businessDate), record]),
    );
    return keys.map((key) => index.get(key) ?? null);
  });

  return { location, conversion };
}
