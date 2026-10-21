/**
 * The one interface in the IoT module, and it earns its place: two real
 * implementations (a local JSONL sink, and a BigQuery load job), so the batching
 * logic does not change when the warehouse is wired in.
 *
 * Rows are already normalised before they reach an adapter (ISO 8601 timestamps,
 * integers, business date), so an adapter never re-parses device input.
 *
 * `businessDate` is part of the row rather than derived inside an adapter: it is
 * a warehouse column, it must be testable without a warehouse, and both adapters
 * must write the same eight `fact_camera_events` columns.
 */

export interface IotRow {
  readonly eventId: string;
  readonly locationId: string;
  /** YYYY-MM-DD on the venue business calendar (Asia/Makassar). */
  readonly businessDate: string;
  readonly cameraId: string | null;
  readonly peopleCount: number;
  /** Seconds this count represents. Required: summing without it is unauditable. */
  readonly intervalSeconds: number;
  readonly observedAt: string;
  readonly receivedAt: string;
}

export interface BigQueryAdapter {
  /**
   * Deliver one batch.
   *
   * Resolves only after the batch is durably accepted. Throwing means "not
   * delivered": the caller requeues the rows. Partial success is not modelled,
   * because neither a BigQuery load job nor a MERGE exposes it usefully.
   */
  insertBatch(rows: readonly IotRow[]): Promise<void>;
}
