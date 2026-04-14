# groundflare

> Your Cloudflare Worker, grounded.

Run any Cloudflare Worker on your own hardware. Same code, your machine, no vendor lock-in.

**Status:** early development — defining scope. Star to follow.

## What it is

groundflare brings wrangler-like deploy DX to self-hosted Workers. Take any `wrangler.toml` project and deploy it to a $5 VPS — provisioning, hardening, SSL, rolling deploys, and Workers-specific tooling included.

```bash
groundflare up         # provision VPS + deploy your Worker (one command)
groundflare deploy     # push code, zero-downtime restart
groundflare tail       # live structured logs
groundflare estimate   # how much would I save vs my Cloudflare bill?
```

## Why

Cloudflare Workers offer the best serverless DX in the industry — but sometimes you need to run yours somewhere else:

- **D1 hit a limit** (10 GB cap, write throughput, stale reads)
- **Bill grew faster than usage** (unpredictable cost spikes)
- **Compliance / data residency** (GDPR, HIPAA, air-gapped)
- **Want predictable economics** ($5 VPS for the same workload)

groundflare keeps your Worker code unchanged and gives you a place to run it.

## What's supported

- Workers runtime (Cloudflare's open-source `workerd`)
- Durable Objects (SQLite-backed, native to workerd)
- Service Bindings, Cache API
- KV → SQLite (WAL-enabled, embedded)
- R2 → pluggable S3-compatible backend (default: passthrough to CF R2; self-host: SeaweedFS default, rustfs on roadmap once GA)
- D1 → libSQL / SQLite
- Queues → SQLite-backed (Redis Streams opt-in for high throughput)
- Cron Triggers → systemd timers (OS-native, restart-resilient)

## What's not supported

These have no local runtime and aren't planned:

- Workers AI (use external inference or keep binding on Cloudflare)
- Vectorize, Browser Rendering, Hyperdrive, Email Workers

## License

MIT
