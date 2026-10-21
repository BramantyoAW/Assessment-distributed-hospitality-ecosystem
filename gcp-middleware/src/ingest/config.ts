/**
 * Configuration for the ingest job, loaded separately from the service.
 *
 * It builds on `loadJobConfig` (which already refuses an unusable BigQuery setup)
 * and adds the NetSuite and paging settings. Kept separate so the service never
 * needs a NetSuite credential and the job never needs a port.
 *
 * `NETSUITE_BOOTSTRAP_SINCE` is required, not defaulted. A hidden default would be
 * the code deciding how much history to backfill; that is an operational decision
 * and it belongs in the deploy manifest where it can be reviewed.
 */

import type { JobConfig } from '../config.js';
import { loadJobConfig } from '../config.js';

export interface NetSuiteSettings {
  readonly accountId: string;
  readonly clientId: string;
  readonly certificateId: string;
  readonly privateKeyPem: string;
  readonly baseUrl: string;
  readonly scope: string;
}

export interface IngestSettings {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly lookbackMinutes: number;
  readonly bootstrapSince: string;
  /** NetSuite internal location id -> `dim_location.location_id`. */
  readonly locationMap: Readonly<Record<string, string>>;
}

export interface IngestConfig {
  readonly job: JobConfig;
  readonly netSuite: NetSuiteSettings;
  readonly ingest: IngestSettings;
}

const DEFAULTS = {
  pageSize: 200,
  maxPages: 50,
  lookbackMinutes: 10,
  scope: 'rest_webservices',
} as const;

export function loadIngestConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const job = loadJobConfig(env);
  const problems: string[] = [];

  const readRequired = (name: string): string => {
    const value = env[name]?.trim() ?? '';
    if (value === '') problems.push(`${name} is required`);
    return value;
  };

  const readInt = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim() ?? '';
    if (raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      problems.push(`${name} must be an integer in [${min}, ${max}] (got "${raw}")`);
      return fallback;
    }
    return parsed;
  };

  const accountId = readRequired('NETSUITE_ACCOUNT_ID');
  const clientId = readRequired('NETSUITE_CLIENT_ID');
  const certificateId = readRequired('NETSUITE_CERTIFICATE_ID');
  const bootstrapSince = readRequired('NETSUITE_BOOTSTRAP_SINCE');

  // Secret Manager delivers the PEM with real newlines; some CI systems deliver it
  // with literal `\n`, which produces an unreadable key and a confusing sign error.
  const privateKeyPem = (env['NETSUITE_PRIVATE_KEY'] ?? '').replace(/\\n/g, '\n').trim();
  if (privateKeyPem === '') {
    problems.push('NETSUITE_PRIVATE_KEY is required (PEM, PKCS#8)');
  } else if (!privateKeyPem.includes('-----BEGIN')) {
    problems.push('NETSUITE_PRIVATE_KEY does not look like a PEM block');
  }

  if (bootstrapSince !== '' && Number.isNaN(Date.parse(bootstrapSince))) {
    problems.push(
      `NETSUITE_BOOTSTRAP_SINCE must be an ISO date or timestamp (got "${bootstrapSince}")`,
    );
  }

  const locationMap = readLocationMap(env['NETSUITE_LOCATION_MAP'], problems);

  const baseUrl =
    env['NETSUITE_BASE_URL']?.trim() ||
    (accountId === ''
      ? ''
      : `https://${accountId.replace(/_/g, '-').toLowerCase()}.suitetalk.api.netsuite.com`);

  if (baseUrl === '') {
    problems.push('NETSUITE_BASE_URL is required when NETSUITE_ACCOUNT_ID is unavailable');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid ingest configuration:\n  - ${problems.join('\n  - ')}`);
  }

  return {
    job,
    netSuite: {
      accountId,
      clientId,
      certificateId,
      privateKeyPem,
      baseUrl,
      scope: env['NETSUITE_SCOPE']?.trim() || DEFAULTS.scope,
    },
    ingest: {
      pageSize: readInt('INGEST_PAGE_SIZE', DEFAULTS.pageSize, 1, 1_000),
      maxPages: readInt('INGEST_MAX_PAGES', DEFAULTS.maxPages, 1, 1_000),
      lookbackMinutes: readInt('NETSUITE_LOOKBACK_MINUTES', DEFAULTS.lookbackMinutes, 0, 1_440),
      bootstrapSince,
      locationMap,
    },
  };
}

/**
 * An empty map is valid and means "no NetSuite location is mapped yet": every row
 * is then rejected as `unknown_location` on the first run, which is a loud, counted
 * failure instead of revenue landing on a made-up location id.
 */
function readLocationMap(
  raw: string | undefined,
  problems: string[],
): Readonly<Record<string, string>> {
  if (raw === undefined || raw.trim() === '') return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      problems.push('NETSUITE_LOCATION_MAP must be a JSON object of id -> location_id');
      return {};
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    const map: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (typeof value !== 'string' || value.trim() === '') {
        problems.push(`NETSUITE_LOCATION_MAP["${key}"] must be a non-empty string`);
        continue;
      }
      map[key] = value.trim();
    }
    return map;
  } catch {
    problems.push('NETSUITE_LOCATION_MAP is not valid JSON');
    return {};
  }
}
