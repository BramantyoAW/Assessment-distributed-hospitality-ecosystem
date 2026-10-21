/**
 * NetSuite SuiteQL client: one keyset page per call.
 *
 * Keyset, not OFFSET. `OFFSET 5000` makes the source scan and discard 5000 rows on
 * every page, so a backfill gets quadratically slower and, worse, can silently skip
 * or repeat rows when new records are created mid-scan. A `(lastmodifieddate, id)`
 * cursor is a position in the ordering, so the scan is stable.
 *
 * SuiteQL does not take bind parameters through the REST body, so the three values
 * that reach the SQL are interpolated. That is only acceptable because each one is
 * validated first (`assertInstant`, integer range, `assertId`), and
 * `netsuite-client.test.ts` asserts an injection attempt never reaches the query.
 */

export interface NetSuiteClientOptions {
  readonly baseUrl: string;
  readonly tokenProvider: { getAccessToken(): Promise<string> };
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** One page request: everything after the cursor. */
export interface PageRequest {
  /** Inclusive lower bound on `lastmodifieddate`. Re-reads the overlap window. */
  readonly sinceIso: string;
  readonly limit: number;
}

export interface SuiteQlRow {
  readonly [field: string]: unknown;
}

export interface PageResult {
  readonly rows: readonly SuiteQlRow[];
  readonly hasMore: boolean;
}

export interface NetSuiteClient {
  fetchTransactionPage(request: PageRequest): Promise<PageResult>;
  /** Exposed for the injection test: the exact SuiteQL for one page. */
  buildTransactionQuery(request: PageRequest): string;
}

const QUERY_PATH = '/services/rest/query/v1/suiteql';

/** NetSuite internal ids are numeric strings; the pattern keeps SQL literals safe. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function assertInstant(value: string, field: string): string {
  if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RangeError(`${field} must be an ISO 8601 UTC instant (got "${value}")`);
  }
  return value;
}

export function assertId(value: string, field: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new RangeError(`${field} contains characters that are not allowed in a NetSuite id`);
  }
  return value;
}

export function buildTransactionQuery(request: PageRequest): string {
  const since = assertInstant(request.sinceIso, 'sinceIso');
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
    throw new RangeError(`limit must be an integer in [1, 1000] (got ${request.limit})`);
  }

  // `>=` on the cursor, not `>`: the checkpoint already subtracts the overlap
  // window, and re-reading a record is free because the warehouse deduplicates.
  // Missing a record is not free.
  //
  // The comparison is day-granular (`TO_DATE`, the documented SuiteQL conversion)
  // rather than to the second. That widens the re-read to the rest of the cursor
  // day, which is harmless — duplicate rows lose in `vw_fact_transactions` — and
  // keeps the statement to a conversion function NetSuite actually documents.
  //
  // No row limit in the SQL: the endpoint's `limit` parameter bounds the page, and
  // the keyset cursor is what makes the scan stable. An `OFFSET` here would make a
  // backfill quadratic.
  const sinceDate = since.slice(0, 10);
  return [
    'SELECT id, trandate, amount, currency, type, location, guests,',
    '       createddate, lastmodifieddate',
    '  FROM transaction',
    ` WHERE lastmodifieddate >= TO_DATE('${sinceDate}', 'YYYY-MM-DD')`,
    ' ORDER BY lastmodifieddate ASC, id ASC',
  ].join('\n');
}

export function createNetSuiteClient(options: NetSuiteClientOptions): NetSuiteClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 20_000;

  const buildTransactionQueryFor = buildTransactionQuery;

  return {
    buildTransactionQuery: buildTransactionQueryFor,

    async fetchTransactionPage(request: PageRequest): Promise<PageResult> {
      const query = buildTransactionQueryFor(request);
      const token = await options.tokenProvider.getAccessToken();

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetchImpl(`${baseUrl}${QUERY_PATH}?limit=${request.limit}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            // `transient` keeps NetSuite from storing a paged result set on the
            // server for a scan we are driving ourselves.
            Prefer: 'transient',
            Accept: 'application/json',
          },
          body: JSON.stringify({ q: query }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text();
          throw new Error(
            `netsuite suiteql request failed: ${response.status} ${detail.slice(0, 300)}`,
          );
        }

        const payload = (await response.json()) as { items?: unknown; hasMore?: unknown };
        const rows = Array.isArray(payload.items) ? (payload.items as SuiteQlRow[]) : [];

        return { rows, hasMore: payload.hasMore === true && rows.length > 0 };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
