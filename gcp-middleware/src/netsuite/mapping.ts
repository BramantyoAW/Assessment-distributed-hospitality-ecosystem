/**
 * NetSuite row -> `fact_transactions` row, with explicit rejections.
 *
 * The rule this file exists for: a row that cannot be mapped is *counted and
 * explained*, never silently coerced. Coercing a missing `trandate` to "today", or a
 * missing amount to 0, would put fake revenue in the warehouse where the only
 * evidence it is fake is that it looks plausible.
 *
 * `business_date` comes from `trandate` by taking its date part and doing NO
 * timezone conversion. `trandate` is already the venue's business date; converting
 * it would move a late-night transaction to the next day in a report that already
 * means "the day the venue traded".
 */

import type { OccurredAtSource, TransactionFact } from '../bigquery/gateway.js';

export type RejectionReason =
  | 'missing_id'
  | 'invalid_trandate'
  | 'invalid_amount'
  | 'invalid_lastmodifieddate'
  | 'unknown_location';

export interface MappingContext {
  /** Stamped once per run, so every row in a batch shares it. */
  readonly ingestedAt: string;
  /** `row.location` is a NetSuite internal id; the dimension uses location_id. */
  readonly resolveLocationId: (rawLocation: unknown) => string | null;
  readonly sourceSystem?: string;
  readonly defaultCurrency?: string;
}

export type MappingResult =
  | { readonly ok: true; readonly fact: TransactionFact }
  | { readonly ok: false; readonly reason: RejectionReason; readonly transactionId: string | null };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_PATTERN = /^-?\d{1,15}(?:\.\d{1,9})?$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?/;

/** NetSuite transaction types mapped onto the warehouse vocabulary. */
const TXN_TYPE_BY_SOURCE: Readonly<Record<string, string>> = {
  'cash sale': 'fnb',
  invoice: 'room',
  'journal entry': 'other',
  'credit memo': 'other',
  'sales order': 'retail',
  'item fulfillment': 'retail',
  'service': 'spa',
};

export function mapTransactionType(rawType: unknown): string {
  if (typeof rawType !== 'string') return 'other';
  return TXN_TYPE_BY_SOURCE[rawType.trim().toLowerCase()] ?? 'other';
}

export function mapTransactionRow(
  row: Readonly<Record<string, unknown>>,
  context: MappingContext,
): MappingResult {
  const transactionId = readId(row['id']);
  if (transactionId === null) return { ok: false, reason: 'missing_id', transactionId: null };

  const businessDate = readBusinessDate(row['trandate']);
  if (businessDate === null) return { ok: false, reason: 'invalid_trandate', transactionId };

  const amount = readAmount(row['amount']);
  if (amount === null) return { ok: false, reason: 'invalid_amount', transactionId };

  const sourceModifiedAt = readTimestamp(row['lastmodifieddate']);
  if (sourceModifiedAt === null) {
    return { ok: false, reason: 'invalid_lastmodifieddate', transactionId };
  }

  const locationId = context.resolveLocationId(row['location']);
  if (locationId === null) return { ok: false, reason: 'unknown_location', transactionId };

  // `createddate` is when the record appeared, not when the sale happened. Falling
  // back to the modified timestamp keeps the column NOT NULL rather than inventing
  // an event time.
  const sourceCreatedAt = readTimestamp(row['createddate']) ?? sourceModifiedAt;

  const occurred = readOccurredAt(row['trandate']);

  const fact: TransactionFact = {
    transactionId,
    locationId,
    businessDate,
    occurredAt: occurred.value,
    occurredAtSource: occurred.source,
    sourceCreatedAt,
    sourceModifiedAt,
    amount,
    currency: readCurrency(row['currency'], context.defaultCurrency ?? 'IDR'),
    txnType: mapTransactionType(row['type']),
    guests: readGuests(row['guests']),
    sourceSystem: context.sourceSystem ?? 'netsuite',
    ingestedAt: context.ingestedAt,
  };

  return { ok: true, fact };
}

function readId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const asString = String(Math.trunc(value));
    return ID_PATTERN.test(asString) ? asString : null;
  }
  if (typeof value === 'string' && ID_PATTERN.test(value.trim())) return value.trim();
  return null;
}

function readBusinessDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().slice(0, 10);
  if (!DATE_PATTERN.test(candidate)) return null;

  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    return null;
  }
  return candidate;
}

function readAmount(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return DECIMAL_PATTERN.test(trimmed) ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // A JSON number has already lost precision; two decimals is the best available
    // reconstruction, and it is still better than dropping the row.
    return value.toFixed(2);
  }
  return null;
}

function readTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * `trandate` is a date, so by default there is no event time and the source is
 * `unavailable`. A full timestamp is used when the source actually sent one.
 */
function readOccurredAt(value: unknown): {
  readonly value: string | null;
  readonly source: OccurredAtSource;
} {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value.trim())) {
    return { value: null, source: 'unavailable' };
  }

  const parsed = Date.parse(value.trim().replace(' ', 'T'));
  if (Number.isNaN(parsed)) return { value: null, source: 'unavailable' };
  return { value: new Date(parsed).toISOString(), source: 'record' };
}

function readCurrency(value: unknown, fallback: string): string {
  if (typeof value === 'string' && /^[A-Z]{3}$/.test(value.trim().toUpperCase())) {
    return value.trim().toUpperCase();
  }
  return fallback;
}

function readGuests(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return Number(value.trim());
  return null;
}
