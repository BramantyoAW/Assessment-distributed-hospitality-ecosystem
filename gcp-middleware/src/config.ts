/**
 * Configuration for the Day 2 GCP tier.
 *
 * Two entry points live in this tree and must NOT share one configuration:
 *
 *  - the Cloud Run **Service** serves GraphQL over HTTP. Its only auth layer is
 *    Cloud Run IAM, so in production it must refuse to start somewhere that
 *    gate does not exist. Cloud Run injects `K_SERVICE` on every instance and
 *    on nothing else, which makes it the cheapest honest signal.
 *
 *  - the Cloud Run **Job** runs the NetSuite ingest with no HTTP and no invoker
 *    gate, triggered through the Cloud Run Admin API. It never receives
 *    `K_SERVICE`, so depending on it would make the job unstartable. It must
 *    therefore be validated by a separate loader that does not mention it.
 *
 * Hence two loaders, one shared block. Validation collects every problem and
 * throws once, so a misconfigured deploy reports all of them at boot instead of
 * one per restart.
 */

export type GatewayKind = 'memory' | 'bigquery';
export type NodeEnv = 'development' | 'test' | 'production';

export interface BigQuerySettings {
  /** Null is only valid for the in-memory gateway. */
  readonly project: string | null;
  readonly dataset: string;
  readonly location: string;
  readonly gateway: GatewayKind;
}

interface CommonConfig {
  readonly nodeEnv: NodeEnv;
  /** IANA zone used to derive every `business_date`. */
  readonly businessTimezone: string;
  readonly bigquery: BigQuerySettings;
  readonly queryTimeoutMs: number;
  readonly maxQueryRows: number;
}

export interface ServiceConfig extends CommonConfig {
  readonly kind: 'service';
  readonly port: number;
  readonly host: string;
  /** True when `K_SERVICE` is present, i.e. Cloud Run injected it. */
  readonly runsOnCloudRun: boolean;
}

export interface JobConfig extends CommonConfig {
  readonly kind: 'job';
}

const DEFAULTS = {
  port: 3003,
  host: '0.0.0.0',
  dataset: 'finns_hospitality',
  location: 'asia-southeast2',
  businessTimezone: 'Asia/Makassar',
  queryTimeoutMs: 10_000,
  maxQueryRows: 500,
} as const;

/** GraphQL caps `first` at 500, so a larger server cap would be a lie. */
const MAX_QUERY_ROWS_CEILING = 500;

function parseNodeEnv(env: NodeJS.ProcessEnv, problems: string[]): NodeEnv {
  const raw = (env['NODE_ENV'] ?? 'development').trim().toLowerCase();
  if (raw === 'development' || raw === 'test' || raw === 'production') return raw;
  problems.push(`NODE_ENV must be "development", "test" or "production" (got "${raw}")`);
  return 'development';
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    problems.push(`${name} must be an integer in [${min}, ${max}] (got "${raw}")`);
    return fallback;
  }
  return parsed;
}

function readTimezone(env: NodeJS.ProcessEnv, problems: string[]): string {
  const raw = env['BUSINESS_TIMEZONE']?.trim() || DEFAULTS.businessTimezone;
  try {
    // Throws RangeError on an unknown zone; catching it turns a typo into a
    // startup error instead of a silently wrong business_date at ingest time.
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    problems.push(`BUSINESS_TIMEZONE must be a valid IANA zone (got "${raw}")`);
    return DEFAULTS.businessTimezone;
  }
}

function readGateway(env: NodeJS.ProcessEnv, problems: string[]): GatewayKind {
  const raw = (env['BQ_GATEWAY'] ?? 'memory').trim().toLowerCase();
  if (raw === 'memory' || raw === 'bigquery') return raw;
  problems.push(`BQ_GATEWAY must be "memory" or "bigquery" (got "${raw}")`);
  return 'memory';
}

function readBigQuery(env: NodeJS.ProcessEnv, problems: string[]): BigQuerySettings {
  const gateway = readGateway(env, problems);
  const project = env['BQ_PROJECT']?.trim() || null;

  // Refuse to boot on an unusable combination. A process that starts and only
  // fails on the first query has already answered a health check.
  if (gateway === 'bigquery' && project === null) {
    problems.push('BQ_PROJECT is required when BQ_GATEWAY=bigquery');
  }

  return {
    project,
    dataset: env['BQ_DATASET']?.trim() || DEFAULTS.dataset,
    location: env['BQ_LOCATION']?.trim() || DEFAULTS.location,
    gateway,
  };
}

function readCommon(env: NodeJS.ProcessEnv, problems: string[]): CommonConfig {
  const maxQueryRows = readInt(
    env,
    'MAX_QUERY_ROWS',
    DEFAULTS.maxQueryRows,
    1,
    MAX_QUERY_ROWS_CEILING,
    problems,
  );

  return {
    nodeEnv: parseNodeEnv(env, problems),
    businessTimezone: readTimezone(env, problems),
    bigquery: readBigQuery(env, problems),
    queryTimeoutMs: readInt(env, 'QUERY_TIMEOUT_MS', DEFAULTS.queryTimeoutMs, 1, 300_000, problems),
    maxQueryRows,
  };
}

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const problems: string[] = [];
  const common = readCommon(env, problems);

  const service = env['K_SERVICE']?.trim() ?? '';
  const runsOnCloudRun = service !== '';

  if (common.nodeEnv === 'production' && !runsOnCloudRun) {
    problems.push(
      'NODE_ENV=production requires K_SERVICE: this service relies on Cloud Run IAM as its ' +
        'only authentication layer, so it must run on Cloud Run. Use NODE_ENV=development ' +
        'to run it locally.',
    );
  }

  const config: ServiceConfig = {
    kind: 'service',
    ...common,
    port: readInt(env, 'PORT', DEFAULTS.port, 1, 65_535, problems),
    host: env['HOST']?.trim() || DEFAULTS.host,
    runsOnCloudRun,
  };

  if (problems.length > 0) {
    throw new Error(`Invalid service configuration:\n  - ${problems.join('\n  - ')}`);
  }

  return config;
}

/**
 * The job deliberately does not read `PORT` and does not require `K_SERVICE`.
 * It is triggered by Cloud Scheduler through `run.jobs.run`, so there is no HTTP
 * surface and no Cloud Run-injected service variable to depend on.
 */
export function loadJobConfig(env: NodeJS.ProcessEnv = process.env): JobConfig {
  const problems: string[] = [];
  const common = readCommon(env, problems);

  if (problems.length > 0) {
    throw new Error(`Invalid job configuration:\n  - ${problems.join('\n  - ')}`);
  }

  return { kind: 'job', ...common };
}
