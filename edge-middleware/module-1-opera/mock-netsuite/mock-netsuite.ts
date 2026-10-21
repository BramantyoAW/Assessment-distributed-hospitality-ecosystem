import { createMockNetsuite } from './server.js';
import type { FailMode } from './server.js';

/**
 * Runnable mock NetSuite endpoint for local development.
 *
 *   npm run mock:netsuite
 *
 * Control it at runtime:
 *   curl -X POST localhost:4010/__control -H 'content-type: application/json' \
 *        -d '{"failMode":"always"}'
 *   curl localhost:4010/__state
 */

const port = Number(process.env['MOCK_NETSUITE_PORT'] ?? '4010');
const hmacSecret = process.env['NETSUITE_HMAC_SECRET'] ?? 'change-me-hmac-shared-secret';
const receivedLogPath = process.env['MOCK_NETSUITE_LOG'] ?? 'data/netsuite-received.jsonl';

const rawFailMode = process.env['MOCK_NETSUITE_FAIL'] ?? 'never';
const failMode: FailMode =
  rawFailMode === 'always' || rawFailMode === 'once' ? rawFailMode : 'never';

const mock = createMockNetsuite({ hmacSecret, failMode, receivedLogPath });

mock.app.listen(port, () => {
  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      service: 'mock-netsuite',
      message: 'listening',
      port,
      failMode,
      receivedLogPath,
    })}\n`,
  );
});
