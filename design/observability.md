# DESIGN: Observability

> Metrics, logs, health, and alerts — what groundflare exposes so operators can tell if the system is healthy, what's hurting, and where bytes are going. All defaults work with zero configuration; advanced users can plug in Prometheus / Grafana / Loki.

Status: v0 draft. Freezes the `/metrics` + `/health` + logging contract before v0.1 implementation so the runtime adapters know what to emit.

## Goals

1. **Zero-config useful.** Fresh `groundflare up` should give the operator enough observability to tell "is my worker alive, how fast, how error-prone" without installing anything extra.
2. **Standards-first.** Prometheus metrics, journald + structured JSON logs, OpenMetrics. No invented protocols; no lock-in to groundflare's own tooling.
3. **VPS-friendly.** Nothing in the default path adds another daemon. No Prometheus server by default; no Grafana by default. Optional, opt-in.
4. **Parity with Workers mental model.** A user coming from CF Workers should recognize what they're looking at — request rate, p50/p99 latency, binding call counts, error rate.
5. **Alignment with [testing.md](testing.md).** Metrics are themselves test surface: conformance tests assert counters increment correctly.

## Non-goals (v0.1)

- Self-hosted dashboards (Grafana ships in v0.4+ as opt-in)
- Distributed tracing / OpenTelemetry spans (deferred until workerd's tracing story stabilizes; the runtime already emits request IDs that downstream tracing can hook into)
- Remote log shipping (Loki / Better Stack / Axiom) — defer to v0.4 with per-provider config
- Alert *delivery* infrastructure (email SMTP, PagerDuty, Slack outbound) — v0.4; v0.1 emits alert *events* to journald only
- Workers Analytics Engine parity (CF proprietary, no open equivalent)

---

## The metrics surface

One HTTP endpoint, one protocol, one concern.

### `/metrics` — Prometheus scrape format

Bound to `127.0.0.1:9100` (not exposed publicly), scraped by whoever wants the data:

- Default: nothing; user can point their own Prometheus at it
- Opt-in (v0.4): groundflare installs Prometheus + Grafana systemd units on the same VPS
- Or: scraped by Grafana Cloud / Datadog / etc. via a small agent the user installs

**Why Prometheus scrape, not OTLP push:** Pushing metrics requires a collector daemon — another process to run, configure, and keep alive. Pull-based scrape lets the runtime do exactly one thing (serve `/metrics`) and puts the burden of "where do these numbers go" on the consumer. That's the right split for self-hosted.

### Metric taxonomy

All metric names prefixed `groundflare_`. Labels follow Prometheus naming conventions (lowercase, underscores, stable cardinality).

#### Worker-level (always present)

```
groundflare_worker_requests_total{worker, status_class}
groundflare_worker_request_duration_seconds{worker, quantile}    # histogram
groundflare_worker_request_bytes_in{worker}                       # counter
groundflare_worker_request_bytes_out{worker}                      # counter
groundflare_worker_errors_total{worker, kind}                     # kind: uncaught, timeout, binding, ...
groundflare_worker_concurrent_requests{worker}                    # gauge
groundflare_worker_scheduled_invocations_total{worker, cron}      # cron triggers
groundflare_worker_scheduled_duration_seconds{worker, cron}
```

#### Binding-level (one set per binding kind)

```
groundflare_kv_ops_total{binding, op}                   # op: get, put, delete, list
groundflare_kv_op_duration_seconds{binding, op}
groundflare_kv_bytes_stored{binding}                    # gauge, from SQLite
groundflare_kv_keys_total{binding}                      # gauge

groundflare_d1_queries_total{binding, op}               # op: select, insert, update, delete, exec
groundflare_d1_query_duration_seconds{binding, op}
groundflare_d1_rows_read_total{binding}
groundflare_d1_rows_written_total{binding}

groundflare_r2_ops_total{binding, op}                   # op: get, put, delete, head, list
groundflare_r2_op_duration_seconds{binding, op}
groundflare_r2_bytes_in_total{binding}
groundflare_r2_bytes_out_total{binding}

groundflare_do_requests_total{class}
groundflare_do_alarm_invocations_total{class}
groundflare_do_storage_bytes{class}                     # gauge

groundflare_queue_messages_produced_total{queue}
groundflare_queue_messages_consumed_total{queue, outcome} # outcome: ack, retry, dlq
groundflare_queue_pending_messages{queue}               # gauge
groundflare_queue_consumer_lag_seconds{queue}           # p99 visible_at - now
```

#### SQLite health (critical, often-forgotten)

```
groundflare_sqlite_file_bytes{subsystem, path}          # gauge
groundflare_sqlite_wal_bytes{subsystem, path}           # gauge — alert if > 1 GB
groundflare_sqlite_busy_timeouts_total{subsystem}       # counter — nonzero = contention
groundflare_sqlite_checkpoint_duration_seconds{subsystem}
groundflare_sqlite_page_cache_hits_total{subsystem}
groundflare_sqlite_page_cache_misses_total{subsystem}
```

The WAL bytes and busy_timeout counters are load-bearing — production SQLite issues almost always show up here first.

#### System-level (node_exporter overlap, but groundflare-emitted)

```
groundflare_system_cpu_seconds_total{mode}
groundflare_system_memory_bytes{state}                  # resident, wal_cache, caddy, redis, ...
groundflare_system_disk_used_bytes{mount}
groundflare_system_disk_total_bytes{mount}
groundflare_system_disk_io_seconds_total{device, op}
groundflare_system_network_bytes_total{interface, direction}
groundflare_system_uptime_seconds
groundflare_systemd_unit_active{unit}                   # gauge 0/1
groundflare_systemd_unit_restarts_total{unit}
```

If the user already runs node_exporter, they can disable this set via `[groundflare.observability] system_metrics = "off"`. Default **on** — node_exporter is extra install complexity most users won't bother with.

### `/health` — liveness only (v0.1)

Single endpoint, binary outcome:

```
GET /health
  200 OK  {"status":"ok","uptime_seconds":12345,"version":"0.1.0"}
  503 Service Unavailable  {"status":"degraded","reason":"..."}
```

Caddy probes this on startup + rolling deploy gate. Simple and reliable beats clever.

**v0.3** splits to `/health/live` (process alive) + `/health/ready` (can accept traffic) + `/health/deep` (touches SQLite + binding round-trips). Postponed until rolling deploy + binding-adapter rollout makes the split meaningful.

---

## Logging

### Format

One format: **JSON per line** written to stdout by workerd/runtime. journald captures stdout natively, rotates, and exposes structured fields for querying:

```json
{"ts":"2026-04-14T15:30:02.123Z","level":"info","worker":"my-api","msg":"request","method":"GET","path":"/users/42","status":200,"duration_ms":3.2,"bytes_out":214,"req_id":"01JS6KQZ...","cf_ray":null}
```

Fields are flat (no nested objects) for journald/Loki friendliness. Nested payloads live in a single `data` field when unavoidable.

### Log sources

All end up in journald so `journalctl -u groundflare-*` is one stream:

| Source | journald unit | Notes |
|---|---|---|
| Worker request access log | `groundflare-worker.service` | Every request line; `level=info` |
| `console.log` / `console.error` from Worker code | `groundflare-worker.service` | User-emitted, wrapped into the JSON envelope, kept on same stream |
| Scheduled handler invocations | `groundflare-worker.service` | `kind=scheduled`, `cron=...` |
| Caddy access logs | `caddy.service` | JSON by config (Caddy supports natively) |
| systemd timer → `__scheduled` | `groundflare-cron-<hash>.service` | Oneshot, ~1-line entry per trigger |
| Adapter supervisor | `groundflare-worker.service` | Errors from KV/D1/R2/Queue adapters |

### Retention

journald default: persistent on disk, ~1 GB cap, 7-day minimum. `/etc/systemd/journald.conf` pre-configured by groundflare Stage 9 of bootstrap:

```
Storage=persistent
SystemMaxUse=1G
MaxRetentionSec=14day
```

Users who want longer retention point their own log shipper (vector, fluent-bit, promtail) at journald.

---

## CLI observation commands

These wrap journald / `/metrics` / systemd state so the user never has to ssh + remember command flags.

### `groundflare tail`

Streams structured logs over SSH:

```
$ groundflare tail                        # all sources
$ groundflare tail --worker=my-api        # one worker
$ groundflare tail --errors               # level >= error
$ groundflare tail --since=5m             # 5 minutes back
$ groundflare tail --follow               # like tail -f (default when TTY attached)
```

Under the hood: `ssh vps journalctl -u 'groundflare-*' -f -o json | <local formatter>`. Local formatter colorizes by level, dims the envelope, prints one-line per request for info, multiline for errors.

### `groundflare status`

One-screen snapshot of system health. Think `wrangler tail` meets `doctl compute ssh`:

```
groundflare status

VPS                hetzner / cx22 / hel1
Uptime             4d 12h 33m
Worker             my-api @ workerd 1.20260414.1

Requests (1h)      ████████████░░░░░░░░  12,483 req  (3.5 req/s)
Latency            p50  3ms    p95  18ms    p99  42ms
Error rate         0.02%       (3 errors in the last hour)

Bindings
  KV   CACHE        487k keys,  34 MB,  WAL 2 MB       ✓
  D1   DB           213k rows,  52 MB,  WAL 4 MB       ✓
  R2   ASSETS       passthrough → cloudflare           ✓

systemd
  groundflare-worker.service        active (running)   8h
  caddy.service                     active (running)   8h
  groundflare-cron-abc123.timer     waiting (next: 2m) 8h

Disk               1.2 GB / 40 GB  (3%)
Memory             280 MB / 1 GB  (28%)
```

Fetches `/metrics`, `systemctl list-units`, and `/proc/*` snapshots in parallel; renders with `consola` + a small layout helper. No dashboard daemon needed.

### `groundflare logs <worker> [--tail N]`

Non-streaming log dump — useful for scripting / bug reports. Defaults to last 100 lines.

### `groundflare metrics [--raw | --query <prom_expr>]`

- `--raw` dumps the `/metrics` endpoint contents (for piping to `promtool query` or diff-ing between environments)
- `--query` runs a PromQL expression via the bundled renderer — but **only** if the user has opted into the local Prometheus unit (v0.4+). Before then, the flag errors out with a hint.

---

## Alert events (v0.1)

Zero delivery infrastructure in v0.1. The runtime emits structured alert *events* to journald that a downstream log shipper can pick up. Schema:

```json
{"ts":"...","level":"error","msg":"alert","alert_id":"worker_error_rate_high",
 "severity":"warn","description":"Error rate 5.2% over last 5m",
 "labels":{"worker":"my-api"},"value":0.052,"threshold":0.01}
```

Built-in alert triggers (all configurable thresholds in `[groundflare.observability.alerts]`):

| alert_id | Default threshold |
|---|---|
| `worker_error_rate_high` | >1% of requests errored in last 5m |
| `sqlite_wal_large` | WAL file > 1 GB on any SQLite subsystem |
| `sqlite_busy_timeouts` | >0 busy timeouts in last 1m (indicates contention) |
| `disk_nearly_full` | >85% used on any mount |
| `systemd_unit_down` | any `groundflare-*` unit inactive for > 30s |
| `queue_consumer_lagging` | queue p99 lag > 60s |

v0.4 adds actual delivery:

```toml
[groundflare.observability.alerts]
email = "ops@example.com"
webhook = "https://hooks.slack.com/..."
pagerduty_integration_key = "..."
```

groundflare-runtime then subscribes to its own journal alerts stream and dispatches. Keeping this separate from v0.1 means we don't block MVP on SMTP / OAuth / rate limiting logic.

---

## Compared to CF Workers observability

| Feature | CF Workers | groundflare | Winner |
|---|---|---|---|
| Request logs | Tail via Dashboard / API (sampled) | Full logs in journald, unsampled | **groundflare** for debug |
| Metrics | Workers Analytics dashboard | Prometheus scrape, your dashboard | Even; depends on user preference |
| Retention | 90 days on paid plans | Whatever journald + your log shipper allow | **groundflare** for long retention |
| Real user monitoring | Built-in via CF edge analytics | None; bring your own | **CF** |
| Alerts | Workers dashboard thresholds | `/metrics` → your Alertmanager | Even; more flexibility in groundflare, more convenience in CF |
| Distributed tracing | Workers Trace (beta) | Deferred to v1+ | **CF** (for now) |
| Cost | Included in Workers pricing | Free (operates on your VPS) | **groundflare** |

Honest statement: **CF's Workers Analytics Engine is the one feature groundflare can't match at zero cost**. Users who rely heavily on sampled high-cardinality query analytics should keep that binding on CF (via `passthrough` adapter pattern analogous to R2) or accept that their local Prometheus is lower-fidelity.

---

## Implementation notes for v0.1

The Prometheus endpoint ships alongside the main worker in `src/runtime/metrics/`. Counters and histograms use [`prom-client`](https://github.com/siimon/prom-client)-compatible primitives (or a minimal in-house equivalent — ~200 LOC, no deps, since we only need text-format output). The runtime's adapter layer (KV/D1/R2/Queue) wraps every operation with a small instrumentation shim that increments the appropriate counter and observes duration:

```ts
// illustrative, not final API
export function instrumentKvOp<T>(
  binding: string,
  op: 'get' | 'put' | 'delete' | 'list',
  fn: () => Promise<T>,
): Promise<T> {
  const end = kvOpDuration.startTimer({ binding, op })
  return fn()
    .then((r) => { kvOpsTotal.inc({ binding, op }); return r })
    .finally(() => end())
}
```

Writing the shim once at adapter boundary means every adapter automatically emits the right metrics without having to remember. **Conformance tests assert these counters increment** — that's how we keep the metrics surface honest across Mirror / Bun tracks.

---

## Open questions

1. **Histogram bucket choice.** Default Prometheus buckets (5ms … 10s) are reasonable for Workers but p50 in the 1-3ms range means the low bucket edge matters. Leaning: custom buckets `[0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]`. Revisit after real data.
2. **`/metrics` authentication.** Bound to `127.0.0.1` by default, so unreachable externally unless user explicitly reverse-proxies it. Should we *also* require a bearer token on the endpoint for defense-in-depth? Leaning: **no in v0.1** (adds config surface for low-value gain given localhost bind); **optional in v0.4** (`[groundflare.observability] metrics_token = ...`).
3. **Sampling.** For very high-volume workers, emitting per-request access log JSON is expensive. Should we sample (e.g. keep 1% of 200-status requests, 100% of errors)? Leaning: **no sampling by default**, but add `[groundflare.observability] request_log_sampling = 0.01` for users who hit the limit. Error requests always logged in full.
4. **Worker `console.log` routing.** Everything goes to journald — but users are used to seeing `console.log` output in `wrangler dev`. `groundflare tail` covers this, but `groundflare dev` (local simulation) should also pipe console to the terminal. Already planned for v0.2.
5. **Workers Analytics Engine equivalent.** Is there an open-source analog we can recommend? ClickHouse is overkill for a single-VPS user. SQLite + Grafana plugin might work. Leaning: **defer. Likely v1+ topic.**
6. **Metric cardinality safety.** A worker that puts user IDs in error messages could blow up label cardinality (`error_user_12345`). Runtime must strip / hash high-cardinality values from labels. Need a defined rule; leaning "allow-list of labels" approach.
