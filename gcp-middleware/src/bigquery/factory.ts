/**
 * One place that turns configuration into a gateway.
 *
 * Both entry points (service and job) go through here so they cannot disagree
 * about which warehouse they talk to, and so `BQ_GATEWAY=memory` in production is
 * a decision made in one line rather than in four.
 */

import type { JobConfig, ServiceConfig } from '../config.js';
import { createBigQueryGateway } from './bigquery.gateway.js';
import type { BigQueryGateway } from './gateway.js';
import { createMemoryGateway } from './memory.gateway.js';

export function createGateway(config: ServiceConfig | JobConfig): BigQueryGateway {
  if (config.bigquery.gateway === 'memory') {
    return createMemoryGateway();
  }

  // `readBigQuery` already refused to boot without a project, so this cast is
  // documenting an invariant rather than hoping.
  const project = config.bigquery.project;
  if (project === null) {
    throw new Error('BQ_GATEWAY=bigquery requires BQ_PROJECT');
  }

  return createBigQueryGateway({
    project,
    dataset: config.bigquery.dataset,
    location: config.bigquery.location,
    queryTimeoutMs: config.queryTimeoutMs,
  });
}
