import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

interface Binding {
  readonly member: string;
  readonly role: string;
  readonly resource: string;
}

/** Minimal reader for the `bindings:` list in deploy/iam.yaml. */
function parseBindings(yaml: string): Binding[] {
  const bindings: Binding[] = [];
  let current: { member?: string; role?: string; resource?: string } | null = null;

  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- member:')) {
      if (current?.member !== undefined) bindings.push(current as Binding);
      current = { member: trimmed.slice('- member:'.length).trim() };
      continue;
    }
    if (current === null) continue;

    if (trimmed.startsWith('role:')) current.role = trimmed.slice('role:'.length).trim();
    if (trimmed.startsWith('resource:')) current.resource = trimmed.slice('resource:'.length).trim();
  }

  if (current?.member !== undefined && current.role !== undefined && current.resource !== undefined) {
    bindings.push(current as Binding);
  }
  return bindings;
}

const bindings = parseBindings(read('deploy/iam.yaml'));

function forMember(member: string, role: string): Binding[] {
  return bindings.filter((binding) => binding.member === member && binding.role === role);
}

test('the edge host may write exactly one table: camera events', () => {
  const writes = forMember('edge-webhook', 'roles/bigquery.dataEditor');

  assert.equal(writes.length, 1, 'edge must not hold dataEditor anywhere else');
  assert.equal(writes[0]?.resource, 'table:finns_hospitality.fact_camera_events');
});

test('the GraphQL service reads the views and the dimensions, and cannot write', () => {
  const reads = forMember('gcp-graphql', 'roles/bigquery.dataViewer').map((b) => b.resource);

  assert.deepEqual(reads.sort(), [
    'table:finns_hospitality.dim_date',
    'table:finns_hospitality.dim_location',
    'table:finns_hospitality.vw_fact_camera_events',
    'table:finns_hospitality.vw_fact_transactions',
  ]);
  assert.equal(forMember('gcp-graphql', 'roles/bigquery.dataEditor').length, 0);
});

test('the ingest job writes the fact table and its checkpoint, nothing else', () => {
  const writes = forMember('gcp-ingest', 'roles/bigquery.dataEditor').map((b) => b.resource);

  assert.deepEqual(writes.sort(), [
    'table:finns_hospitality.fact_transactions',
    'table:finns_hospitality.ingest_checkpoint',
  ]);
});

test('no binding is dataset-wide: per-table grants are the point', () => {
  for (const binding of bindings) {
    assert.doesNotMatch(binding.resource, /^dataset:/, `${binding.member} holds a dataset-wide role`);
  }
});

test('the NetSuite key reaches the job through Secret Manager, not an env file', () => {
  const yaml = read('deploy/iam.yaml');
  assert.match(yaml, /roles\/secretmanager\.secretAccessor/);
  assert.match(yaml, /secret:finns-netsuite-private-key/);
});

test('the documented journal command uses the unit name the repo actually ships', () => {
  const readme = read('README.md');
  const deploy = read('deploy/README.md');

  const command =
    'sudo journalctl -u edge-webhook.service --since "24 hours ago" --no-pager | grep -iE \'timeout|timed out\'';

  assert.ok(readme.includes(command), 'README.md is missing the documented journal search');
  assert.ok(deploy.includes(command), 'deploy/README.md is missing the documented journal search');

  // The command is only correct if the unit exists under that exact name.
  assert.equal(existsSync(join(ROOT, 'deploy/edge-webhook.service')), true);
  assert.ok(read('deploy/edge-webhook.service').includes('edge-webhook'));
});

test('the root README stays within two pages', () => {
  const lines = read('README.md').trimEnd().split('\n').length;
  assert.ok(lines <= 120, `README.md is ${lines} lines; the brief asks for about two pages`);
});

test('the detail lives in per-area docs rather than the root README', () => {
  for (const file of [
    'deploy/README.md',
    'deploy/cloudrun.md',
    'deploy/wif.md',
    'deploy/iam.yaml',
    'database/README.md',
    'gcp-middleware/README.md',
  ]) {
    assert.equal(existsSync(join(ROOT, file)), true, `${file} is missing`);
    assert.ok(read(file).length > 500, `${file} is too thin to be the detailed doc`);
  }
});

test('the README carries the four strategies the brief lists as deliverables', () => {
  const readme = read('README.md');

  // Deliverable 3 names four topics the README itself must explain, not just link to.
  const required: ReadonlyArray<readonly [string, RegExp]> = [
    ['idempotency (Module 1)', /## Idempotency \(Module 1\)/],
    ['BigQuery auth for the edge IoT server (Module 2)', /## BigQuery authentication, edge IoT \(Module 2\)/],
    ['GCP OIDC (Module 3)', /OIDC/],
    ['Secret Manager (Module 3)', /Secret Manager/],
    ['N\+1 mitigation (Module 3)', /## N\+1 mitigation \(Module 3\)/],
  ];

  for (const [topic, pattern] of required) {
    assert.match(readme, pattern, `README.md does not explain ${topic}`);
  }
});

test('the docs label the unverified parts instead of implying they ran', () => {
  const readme = read('README.md');
  assert.match(readme, /Not executed/i);
  assert.match(readme, /--dry_run/);

  const cloudrun = read('deploy/cloudrun.md');
  assert.match(cloudrun, /NOT EXECUTED/i);
});

test('the cloud ignore file keeps secrets and build output out of the upload', () => {
  const ignore = read('.gcloudignore');

  for (const pattern of ['node_modules/', 'dist/', '.env', '*.pem']) {
    assert.ok(ignore.includes(pattern), `.gcloudignore must exclude ${pattern}`);
  }
});

test('the units do not block executable memory, which V8 needs', () => {
  for (const unit of ['deploy/edge-webhook.service', 'deploy/iot-buffer.service']) {
    const content = read(unit);
    assert.doesNotMatch(
      content,
      /^MemoryDenyWriteExecute=(yes|true)$/m,
      `${unit} would crash node with SIGTRAP (V8 cannot allocate executable memory)`,
    );
    assert.match(content, /LockPersonality=true/, 'the rest of the hardening stays');
  }

  assert.match(read('deploy/README.md'), /5\/TRAP/, 'the failure mode must be documented');
});

test('the install steps create the state and log directories by hand', () => {
  const deploy = read('deploy/README.md');

  // StateDirectory=/LogsDirectory= are not materialised on systemd 259, and the
  // unit then dies with status=209/STDOUT. The install steps must not rely on them.
  assert.ok(
    deploy.includes('install -d -m 0750 -o edge -g edge /var/lib/edge-webhook /var/log/edge-webhook'),
    'Module 1 install must create /var/lib/edge-webhook and /var/log/edge-webhook',
  );
  assert.ok(
    deploy.includes('install -d -m 0750 -o edge -g edge /var/lib/iot-buffer /var/log/iot-buffer'),
    'Module 2 install must create /var/lib/iot-buffer and /var/log/iot-buffer',
  );
  assert.match(deploy, /209\/STDOUT/, 'the troubleshooting table must explain 209/STDOUT');
});

test('the documented device payload matches the enforced contract', () => {
  const deploy = read('deploy/README.md');
  // The example must carry intervalSeconds, or a reviewer pasting it gets a 400.
  assert.match(deploy, /"intervalSeconds":\s*30/);
  assert.match(deploy, /\/api\/v1\/iot\/people-count/);
});
