# DESIGN: `groundflare estimate`

> One-command answer to "how much would I save by moving my Cloudflare Worker to a $5 VPS?"

Status: v0 draft — subject to refinement after first-user validation.

## Purpose

Reduce the activation cost of groundflare to **a single command that produces a number**. A CF user considering migration shouldn't need to do the math themselves. The tool reads their usage, classifies their workload, sizes a VPS, and outputs savings with confidence.

The secondary purpose is marketing: the shareable link at `groundflare.dev/e/:id` turns every estimate into a referral surface. "I saved $287/mo by switching" → HN/Twitter/LinkedIn gold.

## Non-goals

- Not a migration executor — only produces the comparison
- Not a benchmark tool (separate `groundflare benchmark` covers perf)
- Not an affiliate link farm (VPS provider pricing is informational, no referral rev share by default)

## User flows

### Flow 1: Interactive (no data required)
```bash
$ groundflare estimate
? Monthly requests: 1M
? Average response size (KB): 20
? D1 storage (GB): 2
? D1 rows read / month: 10M
? R2 storage (GB): 5
? Use Workers AI? No
? Use Durable Objects? Yes
  ...
→ Generates estimate
```

Sensible defaults provided; user can accept all with `Enter`.

### Flow 2: From CF billing CSV
```bash
$ groundflare estimate --bill ~/Downloads/cf-invoice-2026-03.csv
→ Parses line items
→ Generates estimate
```

### Flow 3: Live from CF API
```bash
$ groundflare estimate --cf-token $TOKEN --account-id $ACCOUNT
→ Queries GraphQL Analytics API (last 30 days)
→ Generates estimate
```

Tokens stored in OS keychain; can be rotated via `groundflare logout`.

## Core algorithm

### Step 1: Workload classification

```
IF egress_TB_per_month > 10 OR avg_response_KB > 1000:
    profile = B (media-heavy)
ELIF total_cpu_ms > 100_000_000:
    profile = C (compute-heavy)
ELIF d1_rows_read > 10_000_000 OR db_size_GB > 5:
    profile = D (data-heavy)
ELSE:
    profile = A (typical micro-SaaS)
```

User can override with `--profile=a|b|c|d`.

### Step 2: VPS sizing

```
peak_rps = max_rps_last_30_days (from analytics or default 10× avg)
avg_cpu_ms = total_cpu_ms / total_requests

cores_needed = ceil(peak_rps * avg_cpu_ms / 1000 * 1.5)   # 50% headroom
ram_needed_GB = 1 + 0.5 * DO_instance_count + kv_cache_estimate
disk_needed_GB = 2 * (d1_GB + kv_GB + r2_GB)              # double for WAL + growth

FIT TO SMALLEST HETZNER TIER:
  CX22 (2 vCPU / 4 GB / 40 GB / $4.80): if cores ≤ 2 AND ram ≤ 3 AND disk ≤ 35
  CX32 (4 vCPU / 8 GB / 80 GB / $7.50): ...
  CX42 (8 vCPU / 16 GB / 160 GB / $14): ...
  CX52 (16 vCPU / 32 GB / 320 GB / $28): ...
  > CX52 → flag "not ideal for single-node, suggest hybrid or scale-out"
```

### Step 3: Cost calculation

```
cloudflare_monthly =
  5.00                                # Workers Paid base
  + max(0, requests - 10M) * 0.30e-6  # request overage
  + max(0, cpu_ms - 30M) * 0.02e-6    # CPU overage
  + d1_storage_GB * 0.75              # D1 storage
  + d1_rows_read * 0.001e-3           # D1 reads
  + d1_rows_written * 1e-6            # D1 writes
  + kv_reads * 0.50e-6                # KV reads
  + kv_writes * 5.00e-6               # KV writes
  + kv_storage_GB * 0.50              # KV storage
  + r2_storage_GB * 0.015             # R2 storage
  + r2_class_a_ops * 4.50e-6          # R2 Class A
  + r2_class_b_ops * 0.36e-6          # R2 Class B
  + do_requests * 0.20e-6             # DO requests
  + do_duration_gb_s * 12.50e-6       # DO duration
  + do_storage_GB * 0.20              # DO storage

hetzner_monthly =
  vps_tier_price                      # CX22/32/42/52
  + max(0, egress_TB - 20) * 1.00     # overage (EU/US)
  + 3.00                              # restic → B2 backups (recommended)
  + bunny_cdn_cost if profile == B    # $5/TB for assets
  + r2_kept_on_cf if hybrid           # R2 stays on CF for profile B

savings_monthly = cloudflare_monthly - hetzner_monthly
```

Prices above must be verified against CF + Hetzner public pricing at build time (have a `prices.json` updated quarterly).

### Step 4: Confidence scoring

```
HIGH:   All inputs from API/CSV, no unmigrateable bindings, profile fit clean
MEDIUM: Some inputs estimated, minor unmigrateable bindings (e.g. just Analytics Engine)
LOW:    Interactive mode with many defaults, OR heavy Workers AI / Vectorize / Hyperdrive usage
```

## Output format

### Terminal (default)

```
┌─────────────────────────────────────────────────┐
│  groundflare estimate                            │
│  Workload profile: A (typical micro-SaaS)        │
│  Confidence: high                                │
├─────────────────────────────────────────────────┤
│                                                  │
│  Current Cloudflare                $42.50/mo    │
│  ├─ Workers Paid                    $5.00       │
│  ├─ Workers overage                 $2.50       │
│  ├─ D1 (2 GB, 15M reads)           $18.00       │
│  ├─ KV (1 GB, 5M ops)              $12.00       │
│  └─ R2 (10 GB)                      $5.00       │
│                                                  │
│  Target: Hetzner CX22 + hybrid R2                │
│  ├─ VPS (CX22, 2 vCPU/4 GB)         $4.80       │
│  ├─ R2 (kept on CF, free egress)    $5.00       │
│  ├─ Backups (restic → B2)           $3.00       │
│  └─ CDN (Bunny, optional)           $0.00       │
│                                     ──────       │
│  Target total                      $12.80/mo    │
│                                                  │
│  💰 Savings: $29.70/mo  ($356/year)             │
│                                                  │
│  ⚠️  Not migrateable (keep on CF):              │
│      • Workers AI — no local runtime             │
│                                                  │
│  🔗 Share: https://groundflare.dev/e/abc123ef   │
└─────────────────────────────────────────────────┘

Next step:
  $ groundflare init --vps hetzner --size cx22
```

### JSON (for scripting)

```json
{
  "generated_at": "2026-04-14T12:34:56Z",
  "profile": "A",
  "confidence": "high",
  "current": {
    "provider": "cloudflare",
    "monthly": 42.50,
    "breakdown": { "workers": 7.50, "d1": 18.00, "kv": 12.00, "r2": 5.00 }
  },
  "target": {
    "provider": "hetzner",
    "tier": "cx22",
    "monthly": 12.80,
    "breakdown": { "vps": 4.80, "r2_on_cf": 5.00, "backups": 3.00 }
  },
  "savings": { "monthly": 29.70, "annual": 356.40, "percent": 70 },
  "warnings": [
    { "code": "workers-ai-not-migratable", "impact": "keep-on-cf", "cost_delta": 0 }
  ],
  "share_url": "https://groundflare.dev/e/abc123ef"
}
```

### Markdown (for PRs / docs)
Structured table + callouts, same content.

## Shareable link (opt-in)

- Default: no data leaves machine
- `--share` flag: anonymized summary uploaded to `groundflare.dev/e/:id`
- Shared payload: profile, confidence, totals, breakdown categories, savings %
- Never shared: account IDs, URLs, worker names, secrets, absolute request volumes (only buckets: "< 1M", "1M-10M", etc.)
- Link expires after 30 days unless user claims it with a groundflare account

Marketing implication: every shared estimate is a landing page with "Run your own: `npx groundflare estimate`".

## Edge cases

| Scenario | Handling |
|---|---|
| Uses Workers AI / Vectorize | Flag as "not migratable — keep binding on CF, proxy from self-hosted Worker" |
| Uses Hyperdrive | Recommend libSQL local OR real Postgres — depends on source DB |
| Uses Browser Rendering | Flag as "not migratable — use external service (Browserless)" |
| Uses Email Workers | Flag as "not migratable — use Resend / Postmark" |
| Egress > 20 TB | Recommend hybrid: R2 for assets, VPS for compute |
| Egress > 100 TB | Warn: "At this scale, CF is likely cheaper overall — migration not recommended" |
| Single-worker > 10k RPS sustained | Recommend CX42+ or multi-node (outside v1 scope) |
| DO instances > 1000 | Flag: "workerd handles DO natively but groundflare is single-node; review topology" |
| Uses Queues | Note: local adapter via Redis Streams in roadmap, currently unsupported |
| Free tier (no Workers Paid) | Output "you're under CF free limits — no savings available" |

## CLI

```
groundflare estimate [options]

Data sources (pick one):
  --bill <path>            CF billing CSV export
  --cf-token <token>       CF API token for live fetch
  --account-id <id>        CF account ID (required with --cf-token)
  (interactive if none)

Overrides:
  --profile <a|b|c|d>      Skip auto-classification
  --provider <name>        hetzner | do | linode | vultr | contabo
                           (default: hetzner)
  --region <code>          eu-central | us-east | ap-south
                           (default: eu-central)

Output:
  --format <fmt>           terminal | json | markdown  (default: terminal)
  --out <path>             Write to file instead of stdout
  --share                  Upload anonymized summary, get shareable link
  --no-color               Plain terminal output

Misc:
  --currency <code>        USD | EUR | GBP  (default: USD)
  --no-telemetry           Disable anonymous usage reporting
```

## Pricing data

`prices.json` shipped with CLI, structure:

```json
{
  "updated": "2026-04-14",
  "cloudflare": {
    "workers_paid_base": 5.00,
    "workers_request_per_million": 0.30,
    "workers_cpu_ms_per_million": 0.02,
    "d1_storage_per_gb": 0.75,
    ...
  },
  "hetzner": {
    "cx22": { "price": 4.80, "vcpu": 2, "ram_gb": 4, "disk_gb": 40, "traffic_tb": 20 },
    "cx32": { "price": 7.50, "vcpu": 4, "ram_gb": 8, "disk_gb": 80, "traffic_tb": 20 },
    ...
  },
  "backup": { "restic_b2_per_gb": 0.005 },
  "cdn": { "bunny_per_gb": 0.005 }
}
```

CI task updates quarterly; stale prices warn user with timestamp in output.

## Roadmap

| Version | Scope | Time |
|---|---|---|
| **v0.1** | Interactive mode, Hetzner only, profile A/B/C/D, terminal output | 1 week |
| **v0.2** | Billing CSV parser, JSON + markdown output, 5 VPS providers | 3 days |
| **v0.3** | CF API live fetch, keychain token storage | 1 week |
| **v0.4** | Shareable link + `groundflare.dev/e/:id` landing pages | 1 week |
| **v1.0** | Multi-region pricing, historical trend analysis, post-migration actual-cost verification (`--actual`) | 2 weeks |

Target: v0.1 out with groundflare v0.2 release (Kamal-for-Workers demo). Estimator is the bait; the deploy tool is the product.

## Open questions

1. Do we show absolute dollars in the shared link, or only relative savings ("saved 70%")? Absolute is more shareable; relative is more privacy-safe.
2. Affiliate links to VPS providers: conflict of interest risk, but real rev possibility. Decision: **off by default**, optional with `GROUNDFLARE_REFERRAL_AFFILIATES=on`, disclosed in output.
3. Should free-tier CF users (no Workers Paid) still see an estimate? Leaning: **show it**, but flag "you're on free tier — migration rarely pays off below $5/mo CF spend."
4. Can we detect sensitive bindings we don't know about (new CF services launched post-release)? Leaning: parse `wrangler.toml` for unknown binding types and flag as "unknown — manual review."
