import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';

import type { Batcher } from '../batch/batcher.js';
import type { Logger } from '../logger.js';
import type { IotEventsRepo, NewIotEvent } from '../store/events.repo.js';
import { createApiKeyMiddleware } from './api-key.middleware.js';

export const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const LOCATION_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const CAMERA_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/** Sanity ceiling: a hotel venue cannot physically hold more than this. */
const MAX_PEOPLE_COUNT = 1_000_000;

/**
 * A single camera event may not claim to span more than an hour. Without a
 * ceiling one row could assert "12 people over 8 hours" and distort every
 * `cameraSeconds` total downstream.
 */
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 3_600;

/**
 * What `intervalSeconds` means when the camera does not send one.
 *
 * The brief's payload is `{eventId, locationId, cameraId?, peopleCount, observedAt}`,
 * so a payload without the field must still be accepted: rejecting the documented
 * contract because the warehouse wants a duration would break Module 2.
 *
 * The duration is therefore assumed, not demanded — but the assumption is explicit:
 * configured by `IOT_DEFAULT_INTERVAL_SECONDS`, logged per request as
 * `iot_interval_defaulted`, and documented, so a `cameraSeconds` total can always be
 * traced back to it. A silent default would be indistinguishable from a measurement.
 */
export const DEFAULT_INTERVAL_SECONDS = 60;

export type ParseResult =
  | {
      readonly ok: true;
      readonly value: NewIotEvent;
      /** True when `intervalSeconds` was absent and the configured default was used. */
      readonly intervalDefaulted: boolean;
    }
  | { readonly ok: false; readonly fields: readonly string[] };

export interface IotIngestDeps {
  readonly repo: IotEventsRepo;
  readonly batcher: Batcher;
  readonly logger: Logger;
  readonly apiKey: string;
  /** Used when the payload omits `intervalSeconds`. */
  readonly defaultIntervalSeconds?: number;
}

/**
 * `POST /api/v1/iot/people-count`
 *
 * Body: { eventId, locationId, cameraId?, peopleCount, intervalSeconds?, observedAt }
 *
 * `intervalSeconds` is optional for compatibility with the brief's payload; when it
 * is absent the configured default is assumed and logged.
 *
 * Writes to SQLite and returns 202. The BigQuery call belongs to the batcher, so
 * camera latency is never tied to warehouse latency.
 */
export function createIotIngestRouter(deps: IotIngestDeps): Router {
  const router = Router();

  router.post(
    '/',
    requireJsonContentType,
    createApiKeyMiddleware(deps.apiKey),
    (req: Request, res: Response) => {
      const defaultIntervalSeconds = deps.defaultIntervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
      const parsed = parsePeopleCountPayload(req.body, defaultIntervalSeconds);

      if (!parsed.ok) {
        res.status(400).json({ error: 'invalid_payload', fields: parsed.fields });
        return;
      }

      if (parsed.intervalDefaulted) {
        deps.logger.warn('iot_interval_defaulted', {
          eventId: parsed.value.eventId,
          assumedIntervalSeconds: parsed.value.intervalSeconds,
          hint: 'send intervalSeconds from the camera to make cameraSeconds exact',
        });
      }

      const outcome = deps.repo.ingest(parsed.value);

      deps.logger.info('iot_event_ingested', {
        eventId: parsed.value.eventId,
        status: outcome,
        locationId: parsed.value.locationId,
        peopleCount: parsed.value.peopleCount,
      });

      // Buffer only. `maybeFlush` exists for the size trigger, not for this row.
      deps.batcher.maybeFlush();

      res.status(202).json({ status: outcome, eventId: parsed.value.eventId });
    },
  );

  return router;
}

export function parsePeopleCountPayload(
  body: unknown,
  defaultIntervalSeconds: number = DEFAULT_INTERVAL_SECONDS,
): ParseResult {
  const fields: string[] = [];
  const source: Record<string, unknown> =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  const eventId = readIdentifier(source['eventId'], EVENT_ID_PATTERN);
  if (eventId === null) {
    fields.push(`eventId is required and must match ${EVENT_ID_PATTERN.source}`);
  }

  const locationId = readIdentifier(source['locationId'], LOCATION_PATTERN);
  if (locationId === null) {
    fields.push(`locationId is required and must match ${LOCATION_PATTERN.source}`);
  }

  let cameraId: string | null = null;
  const cameraIdRaw = source['cameraId'];
  if (cameraIdRaw !== undefined && cameraIdRaw !== null) {
    cameraId = readIdentifier(cameraIdRaw, CAMERA_PATTERN);
    if (cameraId === null) {
      fields.push(`cameraId must be a string matching ${CAMERA_PATTERN.source}`);
    }
  }

  const peopleCountRaw = source['peopleCount'];
  const peopleCountValid =
    typeof peopleCountRaw === 'number' &&
    Number.isInteger(peopleCountRaw) &&
    peopleCountRaw >= 0 &&
    peopleCountRaw <= MAX_PEOPLE_COUNT;
  if (!peopleCountValid) {
    fields.push(`peopleCount is required and must be an integer in [0, ${MAX_PEOPLE_COUNT}]`);
  }

  const observedAtRaw = source['observedAt'];
  const observedAtValid =
    typeof observedAtRaw === 'string' && !Number.isNaN(Date.parse(observedAtRaw));
  if (!observedAtValid) {
    fields.push('observedAt is required and must be an ISO 8601 timestamp');
  }

  // Optional, because the brief's payload does not include it. When absent the
  // configured default is assumed and the caller logs it, so the assumption stays
  // visible; when present it must be a sane integer, because a camera that claims
  // "12 people over 8 hours" would distort every `cameraSeconds` total.
  const intervalSecondsRaw = source['intervalSeconds'];
  const intervalDefaulted = intervalSecondsRaw === undefined || intervalSecondsRaw === null;
  const intervalSeconds = intervalDefaulted
    ? defaultIntervalSeconds
    : (intervalSecondsRaw as number);

  const intervalSecondsValid =
    Number.isInteger(intervalSeconds) &&
    intervalSeconds >= MIN_INTERVAL_SECONDS &&
    intervalSeconds <= MAX_INTERVAL_SECONDS;
  if (!intervalSecondsValid) {
    fields.push(
      `intervalSeconds must be an integer in ` +
        `[${MIN_INTERVAL_SECONDS}, ${MAX_INTERVAL_SECONDS}] when provided`,
    );
  }

  if (fields.length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    intervalDefaulted,
    value: {
      eventId: eventId ?? '',
      locationId: locationId ?? '',
      cameraId,
      peopleCount: peopleCountRaw as number,
      intervalSeconds,
      // Normalised here, once, so every downstream layer sees one format.
      observedAt: new Date(observedAtRaw as string).toISOString(),
    },
  };
}

function readIdentifier(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : null;
}

function requireJsonContentType(req: Request, res: Response, next: NextFunction): void {
  if (!req.is('application/json')) {
    res.status(415).json({ error: 'unsupported_media_type' });
    return;
  }
  next();
}
