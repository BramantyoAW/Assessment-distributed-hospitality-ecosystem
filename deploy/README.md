# Deploy: Module 1 on an Ubuntu VM (systemd, no Docker)

Target: Ubuntu 24.04 Multipass VM running `edge-webhook.service`.

## 0. Node 24, not the distro package

Ubuntu 24.04 ships Node 18. This code needs `node:sqlite` (22.5+),
`--env-file-if-exists` (22+) and global `fetch`. Install 24 from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # must be v24.x
```

## 1. Build on the workstation, install on the VM

```bash
npm ci
npm run build        # -> dist/
npm test
```

```bash
# On the VM
sudo useradd --system --home /opt/edge-webhook --shell /usr/sbin/nologin edge
sudo mkdir -p /opt/edge-webhook
sudo cp -r dist package.json package-lock.json /opt/edge-webhook/
cd /opt/edge-webhook
sudo npm ci --omit=dev          # express only; devDependencies are not needed at runtime
```

## 2. Secrets, state, unit

```bash
sudo install -d -m 0755 /etc/edge-webhook
sudo install -m 0640 -o root -g edge deploy/env.example /etc/edge-webhook/env
sudoedit /etc/edge-webhook/env          # set both secrets

sudo install -m 0644 deploy/edge-webhook.service /etc/systemd/system/edge-webhook.service

# Create the state and log directories by hand. The unit declares
# StateDirectory=/LogsDirectory=, which is the correct intent, but not every
# systemd creates them: on systemd 259 (Ubuntu 26.04) they are not
# materialised and the unit crash-loops with `status=209/STDOUT`, because
# StandardOutput=append: cannot open a file in a directory that does not exist.
sudo install -d -m 0750 -o edge -g edge /var/lib/edge-webhook /var/log/edge-webhook

sudo systemctl daemon-reload
sudo systemctl enable --now edge-webhook.service
systemctl status edge-webhook.service --no-pager
```

`StateDirectory=edge-webhook` and `LogsDirectory=edge-webhook` create
`/var/lib/edge-webhook` and `/var/log/edge-webhook` with the right ownership,
which is why the database lives there and not under `/opt`.

## 3. Verify

```bash
curl -s localhost:3001/healthz
# {"status":"ok","service":"edge-middleware-module-1-opera"}

curl -s -w ' [%{http_code}]\n' -X POST localhost:3001/webhook/opera \
  -H "authorization: Bearer $OPERA_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"eventId":"evt-demo-1","amount":100}'
# {"status":"accepted","eventId":"evt-demo-1"} [202]

# same event again
# {"status":"duplicate","eventId":"evt-demo-1"} [202]
```

## 4. Prove the restart policy

```bash
systemctl show -p NRestarts --value edge-webhook.service    # note the number
sudo systemctl kill -s SIGKILL edge-webhook.service
sleep 7
systemctl show -p NRestarts --value edge-webhook.service    # increased by 1
systemctl is-active edge-webhook.service                    # active
```

`kill -9` skips the graceful path on purpose. A row left in `processing` is
reclaimed to `pending` on the next start, and the log records it:

```bash
grep -a reclaimed_stale_events /var/log/edge-webhook/edge-webhook.log
```

## 5. Reading the logs

One JSON object per line, so `grep` is enough.

```bash
tail -f /var/log/edge-webhook/edge-webhook.log
```

Failed jobs and their reasons:

```bash
grep -a '"level":"error"' /var/log/edge-webhook/edge-webhook.log | less
grep -a 'netsuite_retry_scheduled' /var/log/edge-webhook/edge-webhook.log | less
```

Timeouts (the case the brief asks about, e.g. NetSuite not answering):

```bash
grep -ai 'timeout' /var/log/edge-webhook/edge-webhook.log | less
grep -a --line-buffered 'TIMEOUT' /var/log/edge-webhook/edge-webhook.log | less
```

`-a` matters: a log file that ever received a binary byte makes plain `grep`
print `Binary file ... matches` instead of the lines. `--line-buffered` keeps
`less` and pipes updating as new events arrive.

Count events by outcome:

```bash
grep -ao '"status":"[a-z]*"' /var/log/edge-webhook/edge-webhook.log | sort | uniq -c
```

## 6. Log rotation is not configured

`StandardOutput=append:` has no rotation and no size cap. systemd does not
rotate this file; it will grow until the disk complains. Add logrotate:

```bash
sudo tee /etc/logrotate.d/edge-webhook >/dev/null <<'EOF'
/var/log/edge-webhook/edge-webhook.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
EOF
```

`copytruncate` is required because systemd holds the file descriptor open;
rotating with `rename` would leave systemd writing to the moved inode.

## 7. Module 2 (`iot-buffer.service`)

Same image, same user, separate unit and separate env file:

```bash
sudo install -m 0640 -o root -g edge deploy/iot-env.example /etc/edge-webhook/iot-env
sudoedit /etc/edge-webhook/iot-env          # set IOT_API_KEY

sudo install -m 0644 deploy/iot-buffer.service /etc/systemd/system/iot-buffer.service
sudo install -d -m 0750 -o edge -g edge /var/lib/iot-buffer /var/log/iot-buffer
sudo systemctl daemon-reload
sudo systemctl enable --now iot-buffer.service
```

```bash
curl -s localhost:3002/healthz
curl -s -w ' [%{http_code}]\n' -X POST localhost:3002/api/v1/iot/people-count \
  -H "x-api-key: $IOT_API_KEY" -H 'content-type: application/json' \
  -d '{"eventId":"iot-demo-1","locationId":"loc-lobby","peopleCount":12,"observedAt":"2026-05-01T10:00:00Z"}'
```

Verify buffering and the shutdown flush, which is the point of the unit's
`TimeoutStopSec=20`:

```bash
# rows sit in the buffer until the interval elapses
sqlite3 /var/lib/iot-buffer/iot-buffer.db 'SELECT status, COUNT(*) FROM iot_events GROUP BY status;'

sudo systemctl restart iot-buffer.service
# after restart, buffered rows are delivered before exit:
grep -a iot_batch_sent /var/log/iot-buffer/iot-buffer.log
wc -l /var/lib/iot-buffer/bigquery-sink.jsonl
```

Failed batches are the dead-letter queue, and they stay visible:

```bash
sqlite3 /var/lib/iot-buffer/iot-buffer.db \
  "SELECT event_id, attempts, last_error FROM iot_events WHERE status='failed';"
grep -a iot_batch_failed /var/log/iot-buffer/iot-buffer.log
```

## 8. Contract changes in the final revision

Two things differ from the Day 1 notes in this file. Both are deliberate.

**The people-count path.** The contract path is now
`POST /api/v1/iot/people-count`. The old `/ingest/people-count` still works: it is
the same router mounted twice, not a second handler, so the two cannot drift.

```bash
curl -sS -X POST "http://127.0.0.1:3002/api/v1/iot/people-count" \
  -H "content-type: application/json" \
  -H "x-api-key: $IOT_API_KEY" \
  -d '{"eventId":"iot-demo-2","locationId":"loc-pool","peopleCount":8,"intervalSeconds":30,"observedAt":"2026-05-01T10:05:00Z"}'
```

**`intervalSeconds` is optional, and its absence is logged.** "12 people" is not a
measurement without a duration: `SUM(people_count)` over readings of different lengths
is not comparable, and `cameraSeconds` becomes unauditable. But the payload in the
brief does not carry the field, so it cannot be required — a camera that only sends
`{eventId, locationId, cameraId?, peopleCount, observedAt}` must still get a `202`.

When the field is absent, the value of `IOT_DEFAULT_INTERVAL_SECONDS` (default `60`) is
recorded and the request logs `iot_interval_defaulted`:

```bash
grep -a iot_interval_defaulted /var/log/iot-buffer/iot-buffer.log | head
```

That keeps the assumption visible instead of indistinguishable from a measurement. A
camera that does send the field should send it; an out-of-range value (`0`, `3601`,
`4.5`) is rejected with `400`, because those are device bugs, not defaults.

Rows written by a build older than this contract have no interval at all and cannot be
shipped. They are **not** given a default — that default would be indistinguishable
from a measurement — so they are quarantined at boot:

Rows written before this contract existed have no interval and cannot be shipped.
They are **not** given a default — an invented 30 seconds would flow straight into
`SUM(interval_seconds)` as if it had been measured. Instead they are quarantined at
boot:

```bash
grep -a quarantined_pre_contract_rows /var/log/iot-buffer/iot-buffer.log
sqlite3 /var/lib/iot-buffer/iot-buffer.db \
  "SELECT event_id, last_error FROM iot_events WHERE status='failed';"
```

## 9. Searching the journal for timeouts

The unit name in this repository is `edge-webhook.service`, and that is the name to
search. Confirm it before trusting the command — the file name and the unit name only
match because `deploy/edge-webhook.service` is installed as
`/etc/systemd/system/edge-webhook.service`:

```bash
ls -l /etc/systemd/system/edge-webhook.service
systemctl list-units --type=service --all 'edge-*' --no-pager
```

Then the search itself:

```bash
sudo journalctl -u edge-webhook.service --since "24 hours ago" --no-pager | grep -iE 'timeout|timed out'
```

The same pattern for the buffer, whose unit is `iot-buffer.service`:

```bash
sudo journalctl -u iot-buffer.service --since "24 hours ago" --no-pager | grep -iE 'timeout|timed out'
```

Be precise about what each source contains, because it decides what an empty result means:

| Source | Contains |
| --- | --- |
| `journalctl -u <unit>` | systemd's own lifecycle records: started, stopped, failed, exit codes |
| `/var/log/<unit>/<unit>.log` | the application's JSON lines, because `StandardOutput=append:` redirects them there |

So a `timeout` **inside the application** (an HTTP call to NetSuite that gave up) appears in
the file log, not in the journal; a unit that systemd had to stop because it hung appears in
the journal. Search both, and read an empty result as "nothing matched", never as "the
command does not work":

```bash
sudo grep -aiE 'timeout|timed out' /var/log/edge-webhook/edge-webhook.log | tail -50
sudo journalctl -u edge-webhook.service --no-pager | grep -iE 'failed|exited|signal'
```

**Verification status: EXECUTED** on a Multipass VM on 2026-10-21, systemd 259. The
`journalctl` command above returns 0 matches on a healthy unit (expected — see the table),
and the same search against the file log returns the application's retry records. The
start/restart/boot behaviour is recorded in §10.

## 10. Verification record (executed, not planned)

Run on a Multipass VM: Ubuntu 26.04, kernel `7.0.0-38-generic`, `aarch64`, systemd
`259 (259.5-0ubuntu3.4)`, Node `v24.22.0`.

| Check | Result |
| --- | --- |
| `systemctl enable --now edge-webhook.service iot-buffer.service` | `active (running)` for both |
| `sudo reboot`, then without touching anything | `active` both, `up 0 minutes`, `NRestarts=0` |
| Queue before/after reboot | `completed 4`, `failed 1` — identical, nothing lost |
| Buffer before/after reboot | `sent 5`, sink `5` lines — identical |
| `systemctl kill -s SIGKILL edge-webhook.service` | `NRestarts` 0→1, back to `active` in ~5 s, queue unchanged |
| NetSuite unreachable, event queued | `pending` with `network: fetch failed`, retried 6× with backoff, then `completed` once the endpoint returned |
| Duplicate `eventId` | `202` + `{"status":"duplicate"}`, one row, one delivery |
| Shutdown flush (`systemctl stop iot-buffer.service`) | 3 buffered rows `pending` → `sent`, sink 2 → 5 lines, `shutdown_complete` on `SIGTERM` |
| `journalctl -u edge-webhook.service --since "24 hours ago" ... \| grep -iE 'timeout\|timed out'` | runs, 0 matches |

Two things this run taught, both now baked into the files above:

- `StateDirectory=`/`LogsDirectory=` were **not** materialised on this systemd version, so
  the install step creates the directories explicitly. Without it the unit dies with
  `status=209/STDOUT`.
- `MemoryDenyWriteExecute=true` killed node with `Check failed: 12 == errno` (V8 cannot
  allocate executable memory). Isolated with `systemd-run --property=...`; the directive is
  gone from both units.

Still **not** verified, and never claimed: BigQuery (DDL, dry run, load job), a real
NetSuite account, Cloud Run deploy, IAM bindings, Secret Manager, WIF. The VM run proves
systemd behaviour only.

## 11. When the unit will not start

| `systemctl status` says | Cause | Fix |
| --- | --- | --- |
| `status=209/STDOUT` | the log directory does not exist, so `StandardOutput=append:` cannot open the file | create the directories: `sudo install -d -m 0750 -o edge -g edge /var/log/edge-webhook /var/lib/edge-webhook` |
| `status=203/EXEC` | `ExecStart` points at a node that is not `/usr/bin/node` (nvm installs elsewhere) | install Node from nodesource, or edit `ExecStart` |
| `status=217/USER` | the `edge` user does not exist | re-run the `useradd` line |
| `status=1/FAILURE` + `Invalid configuration` | a required variable is missing from `/etc/edge-webhook/env` | read the logged list, it names every missing variable |
| `code=dumped, status=5/TRAP`, log shows `Check failed: 12 == errno` | `MemoryDenyWriteExecute=true` is set: V8 cannot allocate executable memory | remove that line from the unit (the shipped units do not set it) |
| `status=226/NAMESPACE` | `ProtectSystem=strict` cannot be applied (unusual kernel/container) | run on a real VM, not inside a container |
| `unable to open database file` | `OPERA_DB_PATH` still points under `/opt`, which `ProtectSystem=strict` makes read-only | point it at `/var/lib/edge-webhook/` |

Look at the actual reason before guessing:

```bash
systemctl status edge-webhook.service --no-pager -l
sudo journalctl -u edge-webhook.service -n 40 --no-pager
```

## 12. Uninstall

```bash
sudo systemctl disable --now edge-webhook.service iot-buffer.service
sudo rm /etc/systemd/system/edge-webhook.service /etc/systemd/system/iot-buffer.service
sudo systemctl daemon-reload
sudo rm -rf /opt/edge-webhook /etc/edge-webhook \
            /var/lib/edge-webhook /var/log/edge-webhook \
            /var/lib/iot-buffer /var/log/iot-buffer
sudo userdel edge
```
