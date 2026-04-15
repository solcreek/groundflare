# groundflare-estimate

**Compare your Cloudflare Workers bill against a self-hosted VPS — in one command.**

```
npx groundflare-estimate
```

Answer a handful of prompts about your workload (requests per month, CPU time, D1/KV/R2 footprint, Durable Object count), and this tool prints a side-by-side cost comparison against a right-sized Hetzner Cloud VPS. No account, no sign-up, no data leaves your machine.

Example output:

```
+------------------------------------------------------+
|                 groundflare estimate                 |
|         Workload profile: C (compute-heavy)          |
|                   Confidence: low                    |
+------------------------------------------------------+
| Current Cloudflare                         $29.89/mo |
|   Workers Paid base                            $5.00 |
|   Workers request overage                     $12.00 |
|   Workers CPU-ms overage                       $4.40 |
|   D1                                           $7.63 |
|   R2                                           $0.86 |
|                                                      |
| Target: Hetzner CX42                       $17.00/mo |
|   VPS (cx42, 8 vCPU / 16 GB)                  $14.00 |
|   Backups (restic → B2)                        $3.00 |
| Savings: $12.88/mo ($154.56/yr, 43%)                 |
| Prices: 2026-04-14                                   |
|   hetzner: live (2026-04-15)                         |
+------------------------------------------------------+
```

---

## Why this is a separate package

`groundflare-estimate` is the "should I even bother self-hosting my Workers?" conversation — packaged as a stand-alone tool so you can answer that question **without** installing the full [`groundflare`](../groundflare) CLI.

- **Marketing hook** — anyone curious about CF costs can `npx groundflare-estimate` in ~5 seconds
- **Independent release cycle** — pricing changes ship as new versions of this package, not new versions of the CLI
- **Reusable library** — the `groundflare` CLI imports from here; future web UIs and Slack bots can too

## Install and run

**Zero-install** (recommended — always uses the latest version):
```bash
npx groundflare-estimate
```

**Global install:**
```bash
npm install -g groundflare-estimate
groundflare-estimate
```

**As a library:**
```bash
npm install groundflare-estimate
```
```ts
import {
  computeEstimate,
  loadBakedPrices,
  renderEstimate,
  refreshPrices,
  EnvSecretReader,
  type Usage,
} from 'groundflare-estimate'

const usage: Usage = {
  requestsPerMonth: 20_000_000,
  cpuMsPerRequest: 5,
  avgResponseKB: 50,
  d1StorageGB: 2,
  d1ReadsPerMonth: 10_000_000,
  // ...
}

const baked = loadBakedPrices()
const { prices, sources } = await refreshPrices({
  baked,
  secrets: new EnvSecretReader(),   // reads HCLOUD_TOKEN from env
})
const estimate = computeEstimate(usage, prices, { confidence: 'high', priceSources: sources })
console.log(renderEstimate(estimate))
```

## Flags

| Flag | Effect |
|---|---|
| `--no-live` | Skip the live Hetzner refresh; use only the baked-in price table. |
| `--json` | Emit the full `Estimate` object as JSON to stdout, for piping into other tools. |
| `-h`, `--help` | Print usage. |

## Pricing data

Two layers, **baked-in fallback** + **live refresh when possible**:

1. **Baked table** — `src/prices.ts` ships with the package, populated from CF + Hetzner's published pricing pages. Used unconditionally when there's no API token or when the live fetch fails.
2. **Live refresh** — if you set `HCLOUD_TOKEN` (or `GROUNDFLARE_HETZNER_TOKEN`), the tool calls Hetzner's [`/v1/pricing`](https://docs.hetzner.cloud/reference/cloud#pricing-get-all-prices) on each run and merges the fresh numbers over the baked table. `cx22`-`cx52` monthly prices and traffic overage rates are refreshed; `vcpu`/`ram_gb`/`disk_gb` stay from the baked spec (they don't come back from `/v1/pricing`, but they're stable catalog info).

Failure modes are never fatal: a network hiccup, wrong token, or schema surprise falls back to baked with a note at the bottom of the output.

### Currency

Baked USD; Hetzner API serves EUR. We convert live EUR → USD with a fixed `1.07` rate. Fine for a cost comparison that's labelled as an estimate; don't use this for accounting.

### Cloudflare side — always baked

Cloudflare has no customer-facing pricing API, so CF prices are only updated when the package is re-released. Check the `updated` field at the bottom of the output to see the table's age; a warning fires when it's over 90 days old.

## Algorithm outline

1. **Classify** the workload as profile A (typical micro-SaaS), B (media-heavy), C (compute-heavy), or D (data-heavy), based on egress / CPU / D1 usage.
2. **Size** a VPS: compute `cores × peak_rps × cpu_ms × 1.5` for compute headroom; add RAM for Durable Object instances; add disk with 2× growth headroom for SQLite WAL. Pick the smallest Hetzner tier that fits.
3. **Cost** both sides line-by-line. CF uses Workers Paid tiers + D1/KV/R2/DO metered overage. Hetzner uses tier monthly + egress overage + recommended `restic → B2` backups. Profile B adds an optional Bunny CDN cost.
4. **Warn** about anything that can't be migrated (Workers AI, Browser Rendering, Vectorize, Hyperdrive) so the user keeps the right bindings on CF.

See [`design/cost-estimate.md`](../../design/cost-estimate.md) in this repo for the full spec, including the v0.2+ roadmap (CF billing CSV parser, CF Analytics API live fetch, shareable links).

## Confidence levels

- **`high`** — all inputs from the CF Analytics API or a billing CSV. v0.3+ feature; not wired yet.
- **`medium`** — some inputs estimated. v0.2+.
- **`low`** — current default from the interactive prompt. Users guess most fields, so the estimate is a ballpark, not an invoice.

## Non-goals

- **Not a migration executor** — only produces the comparison; run [`groundflare deploy`](../groundflare) to actually move workloads.
- **Not a benchmark** — use `groundflare bun analyze` and friends for perf work.
- **Not a tax / accounting tool** — the currency conversion is a constant, not a live FX feed.

## Roadmap

| Version | Scope |
|---|---|
| **v0.1** (current) | Interactive prompt, Hetzner target only, baked + live hybrid pricing, terminal + JSON output. |
| v0.2 | CF billing CSV input, `--profile` override, DigitalOcean / Linode / Vultr targets. |
| v0.3 | CF Analytics API live usage fetch, higher confidence. |
| v0.4 | Shareable link landing page (`groundflare.dev/e/:id`). |

## License

MIT. See [LICENSE](./LICENSE).
