# {{name}}

A Cloudflare Worker scaffolded with [`create-groundflare-app`](https://www.npmjs.com/package/create-groundflare-app), ready to deploy on your own hardware via [`groundflare`](https://www.npmjs.com/package/groundflare).

## Deploy

1. Pick a provider and edit `wrangler.toml`'s `[groundflare]` section:

   ```toml
   [groundflare]
   provider = "hetzner"   # or digitalocean, linode, vultr, contabo
   region   = "hel1"
   size     = "cx22"
   email    = "ops@example.com"
   domain   = "{{name}}.example.com"
   ```

2. Store your provider's API token:

   ```bash
   groundflare secret set provider.hetzner.token <your-token>
   ```

3. Provision the VPS and deploy the Worker:

   ```bash
   groundflare up
   ```

## Optional: run on the Bun track

`Bun.serve` delivers ~7,000–9,000 rps per binding on a $6/mo VPS. Verify compatibility first:

```bash
groundflare bun analyze
```

If the report says you're ready, flip the runtime:

```bash
groundflare bun prepare
groundflare up
```

## Local development

Use [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) for the local dev loop — groundflare is only the deploy target, not a local runtime:

```bash
npx wrangler dev src/index.ts
```
