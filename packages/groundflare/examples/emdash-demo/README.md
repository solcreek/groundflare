# emdash-demo — v0.5 live showcase

A copy of [emdash-cms/templates/starter-cloudflare](https://github.com/emdash-cms/templates/tree/main/starter-cloudflare)
(MIT) with one addition: a `[groundflare]` block in `wrangler.jsonc`.
Zero code patches, zero dependency swaps.

Used as the live-validation target for `groundflare@0.5.0` — the release
that ships a SeaweedFS sidecar and a R2 ↔ S3 adapter Worker so
`env.MEDIA` on a self-hosted box works without operator intervention.

## What this proves

`emdash` exercises most of the Cloudflare Workers surface groundflare
targets: Astro SSR, D1, R2 media storage, KV sessions, `worker_loaders`
plugin sandboxing, a build step (`astro build`) whose multi-file output
(`dist/server/entry.mjs` + chunks) needs re-bundling before it hits
workerd. If this stack boots on a $6 DO droplet, everything simpler does.

Measured end-to-end on `s-1vcpu-1gb` in `sgp1`:

| stage | time |
|---|---|
| provision + cloud-init (+ SeaweedFS install) | ~2 min |
| deploy (bundle 6.5 MB, R2 bucket ensure, systemctl restart) | ~30 s |
| first request → `302 /_emdash/admin/setup` | 3.3 s |

RAM at rest (1 GB droplet):

| process | RSS |
|---|---|
| weed (SeaweedFS) | ~175 MB |
| workerd | ~125 MB |
| caddy | ~38 MB |
| **free** | ~460 MB |

S3 round-trip through `env.MEDIA` lands bytes in `/var/lib/groundflare/
r2-state/*.dat` on disk. `http://127.0.0.1:8333/my-emdash-media/<key>` serves
the same bytes back verbatim — verified via a direct `curl -X PUT` +
`curl -X GET`.

## Running it yourself

```bash
# 1. Install deps (pnpm required — emdash templates use pnpm-lock.yaml)
pnpm install

# 2. Set your DigitalOcean token
groundflare secret set provider.digitalocean.token <token>

# 3. Edit wrangler.jsonc — change:
#    - [groundflare].email (Let's Encrypt registration)
#    - [groundflare].domain (point this at the droplet IP via DNS,
#      or just use the printed IP + curl --resolve for a smoke test)

# 4. Provision + deploy in one shot
groundflare up --workspace emdash-demo

# 5. Load the site — curl via the domain + VPS IP for the first walkthrough
curl -H "Host: emdash.example.com" \
     --resolve emdash.example.com:443:<VPS_IP> \
     https://emdash.example.com/_emdash/admin/setup

# 6. Tear it all down
groundflare destroy --workspace emdash-demo --yes
```

## What the `[groundflare]` block does

Everything else in `wrangler.jsonc` is emdash's native config — the
same file that `npm create emdash` scaffolds. The groundflare-specific
extension picks the provider/region/size/ACME email and the primary
domain. Provider + region + size map to DO's API; domain drives
Caddy's reverse-proxy Host dispatch.

R2 defaults work without any extra config: the `MEDIA` binding routes
to a local SeaweedFS sidecar installed by cloud-init. If you'd rather
back the bucket with B2 / Wasabi / real R2 / anything S3-compatible,
add a `groundflare` block inside the r2_buckets entry — see
[`../r2-smoke/wrangler.toml`](../r2-smoke/wrangler.toml) and the root
[CHANGELOG](../../CHANGELOG.md#v050--self-host-r2-end-to-end) for
credential wiring.

## Known limitations

- The `/` route redirects to Astro's prerendered `/404` on a fresh DB
  (the emdash middleware still runs but Astro's router picks the 404
  page ahead of emdash's setup redirect). `/_emdash/admin/setup`
  renders directly — use that for the first-time wizard walkthrough.
- No DNS provisioning yet. `[groundflare].domain` must resolve to the
  VPS IP externally (via your DNS provider or a hosts-file / curl
  --resolve for testing).
