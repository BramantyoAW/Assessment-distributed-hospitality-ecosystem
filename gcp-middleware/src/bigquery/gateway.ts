/**
 * The warehouse boundary.
 *
 * Everything above this interface (resolvers, loaders, ingest) is pure logic and
 * therefore testable without GCP. Two implementations: the real
 * `@google-cloud/bigquery` gateway, and an in-memory one whose fixtures back
 * every local test.
 *
 * The read methods return already-aggregated shapes, not raw tables, because the
 * aggregation rules are the correctness argument (aggregate before join) and
 * they must live in one place per implementation instead of in every resolver.
 */

/** Whether a real event timestamp exists in the source. */
export type OccurredAtSource = 'record' | 'unavailable';

/** One row of `fact_transactions`, after dedupe. */
export interface TransactionFact {
  readonly transactionId: string;
  readonly locationId: string;
  /** YYYY-MM-DD on the WITA business calendar. */
  readonly businessDate: string;
  readonly occurredAt: string | null;
  readonly occurredAtSource: OccurredAtSource;
  /** `createddate`: when the record was created, not when the event happened. */
  readonly sourceCreatedAt: string | null;
  /** `lastmodifieddate`: drives the ingest checkpoint. */
  readonly sourceModifiedAt: string;
  /** NUMERIC kept as a decimal string so no precision is lost in transit. */
  readonly amount: string;
  readonly currency: string;
  readonly txnType: string;
  readonly guests: number | null;
  readonly sourceSystem: string;
  readonly ingestedAt: string;
}

/** One row of `fact_camera_events`, after dedupe. */
export interface CameraEventFact {
  readonly eventId: string;
  readonly locationId: string;
  /** YYYY-MM-DD on the WITA business calendar. */
  readonly businessDate: string;
  readonly cameraId: string | null;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly peopleCount: number;
  /** Seconds this count represents. Required: summing without it is unauditable. */
  readonly intervalSeconds: number;
}

export interface LocationRecord {
  readonly locationId: string;
  readonly name: string;
  readonly area: string | null;
  readonly capacity: number | null;
  readonly isOutdoor: boolean;
  readonly timezone: string;
  readonly openedOn: string | null;
}

/** One aggregate bucket of camera readings. */
export interface VisitorCountRecord {
  readonly locationId: string;
  /** ISO 8601 start of the bucket, in the venue timezone. */
  readonly bucketStart: string;
  /** SUM(people_count): a count of sightings, not of distinct humans. */
  readonly visits: number;
  readonly readings: number;
  readonly cameraSeconds: number;
}

/**
 * The four numbers a dashboard actually needs for one location-day.
 *
 * `conversionRate` is `transactions / visits`, computed with SAFE_DIVIDE so a
 * location with no camera data returns null instead of a 500 or a division by
 * zero. `null` means "not measurable", which is different from 0 ("measured,
 * nobody converted").
 */
export interface ConversionRecord {
  readonly locationId: string;
  readonly businessDate: string;
  readonly totalTransactions: number;
  /** NUMERIC as a decimal string. */
  readonly totalRevenue: string;
  readonly totalVisits: number;
  readonly totalReadings: number;
  readonly cameraSeconds: number;
  readonly conversionRate: number | null;
}

export type VisitBucket = 'HOUR' | 'DAY';

export interface TransactionQuery {
  readonly locationId: string;
  /** Inclusive, YYYY-MM-DD. */
  readonly from: string;
  readonly to: string;
  readonly limit: number;
}

export interface VisitorCountQuery extends TransactionQuery {
  readonly bucket: VisitBucket;
}

/** One row of the append-only `ingest_checkpoint` table. */
export interface CheckpointRecord {
  readonly stream: string;
  readonly cursorModifiedAt: string;
  readonly cursorId: string;
  readonly overlapMinutes: number;
  readonly runStartedAt: string;
  readonly pages: number;
  readonly rowsLoaded: number;
  readonly rowsRejected: number;
  readonly writtenAt: string;
}

export interface BigQueryGateway {
  insertTransactions(rows: readonly TransactionFact[]): Promise<void>;
  insertCameraEvents(rows: readonly CameraEventFact[]): Promise<void>;
  /** Deduplicated by `transaction_id`, newest `source_modified_at` wins. */
  readTransactions(): Promise<readonly TransactionFact[]>;
  /** Deduplicated by `event_id`, newest `received_at` wins. */
  readCameraEvents(): Promise<readonly CameraEventFact[]>;

  listLocations(): Promise<readonly LocationRecord[]>;
  listTransactions(query: TransactionQuery): Promise<readonly TransactionFact[]>;
  visitorCounts(query: VisitorCountQuery): Promise<readonly VisitorCountRecord[]>;
  /** One record per requested key; missing keys are simply absent. */
  conversionMetrics(
    keys: readonly { readonly locationId: string; readonly businessDate: string }[],
  ): Promise<readonly ConversionRecord[]>;

  latestCheckpoint(stream: string): Promise<CheckpointRecord | null>;
  appendCheckpoint(record: CheckpointRecord): Promise<void>;
}
