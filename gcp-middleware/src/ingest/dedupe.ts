/**
 * Dedupe by a business key, "newest row wins".
 *
 * BigQuery's `PRIMARY KEY ... NOT ENFORCED` does not reject duplicates and the
 * Sandbox forbids the `MERGE` that would upsert them away, so the same rule has
 * to exist twice: once as a SQL view for the warehouse, and once here for the
 * in-memory gateway used by tests. Keeping it in one function means the two
 * cannot drift in the way that matters (which row wins), and `dedupe.test.ts`
 * pins the rule the SQL view implements.
 *
 * Determinism, stated rather than implied:
 *   - `compare(a, b) > 0` means a is newer and must win;
 *   - on a tie the later row in input order wins, so a replay of the same batch
 *     is idempotent and the result never depends on Map iteration order;
 *   - output keeps first-seen insertion order.
 */

export type Comparator<T> = (a: T, b: T) => number;

export function dedupeByKey<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  compare: Comparator<T>,
): T[] {
  const winners = new Map<string, { readonly row: T; readonly position: number }>();

  for (const row of rows) {
    const key = keyOf(row);
    const current = winners.get(key);
    if (current === undefined || compare(row, current.row) >= 0) {
      winners.set(key, { row, position: current?.position ?? winners.size });
    }
  }

  return [...winners.values()].sort((a, b) => a.position - b.position).map((entry) => entry.row);
}
