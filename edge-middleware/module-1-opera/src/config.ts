/**
 * Configuration for Module 1 (Opera webhook edge middleware).
 *
 * Every value comes from the environment. Nothing secret is hardcoded here, and
 * the loader fails fast with one aggregated message so a missing variable is
 * obvious at boot instead of surfacing later as a 401 in production.
 */

export interface OperaConfig {
  readonly port: number;
  readonly bearerToken: string;
  readonly netsuiteUrl: string;
  readonly hmacSecret: string;
  readonly keyId: string;
  readonly dbPath: string;
  readonly pollIntervalMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxDelayMs: number;
  readonly maxAttempts: number;
  readonly shutdownGraceMs: number;
  readonly bodyLimit: string;
  readonly netsuiteTimeoutMs: number;
}

const DEFAULTS = {
  port: 3001,
  dbPath: 'data/opera-queue.db',
  pollIntervalMs: 250,
  retryBaseMs: 500,
  retryMaxDelayMs: 30_000,
  maxAttempts: 5,
  shutdownGraceMs: 5_000,
  bodyLimit: '512kb',
  netsuiteTimeoutMs: 5_000,
  keyId: 'edge-v1',
} as const;

export function loadOperaConfig(env: NodeJS.ProcessEnv = process.env): OperaConfig {
  const problems: string[] = [];

  const readRequired = (name: string): string => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      problems.push(`${name} is required and must not be empty`);
      return '';
    }
    return raw.trim();
  };

  const readInt = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      problems.push(`${name} must be an integer in [${min}, ${max}] (got "${raw}")`);
      return fallback;
    }
    return parsed;
  };

  const bearerToken = readRequired('OPERA_BEARER_TOKEN');
  const netsuiteUrl = readRequired('NETSUITE_URL');
  const hmacSecret = readRequired('NETSUITE_HMAC_SECRET');

  if (netsuiteUrl !== '') {
    let parsed: URL | undefined;
    try {
      parsed = new URL(netsuiteUrl);
    } catch {
      problems.push(`NETSUITE_URL is not a valid URL (got "${netsuiteUrl}")`);
    }
    if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.push(`NETSUITE_URL must use http or https (got "${parsed.protocol}")`);
    }
  }

  const config: OperaConfig = {
    port: readInt('OPERA_PORT', DEFAULTS.port, 1, 65_535),
    bearerToken,
    netsuiteUrl,
    hmacSecret,
    keyId: env['NETSUITE_KEY_ID']?.trim() || DEFAULTS.keyId,
    dbPath: env['OPERA_DB_PATH']?.trim() || DEFAULTS.dbPath,
    pollIntervalMs: readInt('POLL_INTERVAL_MS', DEFAULTS.pollIntervalMs, 0, 60_000),
    retryBaseMs: readInt('RETRY_BASE_MS', DEFAULTS.retryBaseMs, 0, 3_600_000),
    retryMaxDelayMs: readInt('RETRY_MAX_DELAY_MS', DEFAULTS.retryMaxDelayMs, 0, 86_400_000),
    maxAttempts: readInt('MAX_ATTEMPTS', DEFAULTS.maxAttempts, 1, 100),
    shutdownGraceMs: readInt('SHUTDOWN_GRACE_MS', DEFAULTS.shutdownGraceMs, 0, 120_000),
    bodyLimit: env['OPERA_BODY_LIMIT']?.trim() || DEFAULTS.bodyLimit,
    netsuiteTimeoutMs: readInt('NETSUITE_TIMEOUT_MS', DEFAULTS.netsuiteTimeoutMs, 100, 120_000),
  };

  if (config.retryBaseMs > config.retryMaxDelayMs) {
    problems.push('RETRY_BASE_MS must not exceed RETRY_MAX_DELAY_MS');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid Opera configuration:\n  - ${problems.join('\n  - ')}`);
  }

  return config;
}
