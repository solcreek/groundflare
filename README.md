# groundflare (monorepo)

> Your Cloudflare Worker, grounded.

Run any Cloudflare Worker on your own hardware. Same code, your machine, no vendor lock-in.

This repository is a monorepo containing:

| Package | Path | Status |
|---|---|---|
| [`groundflare`](./packages/groundflare) — the CLI | `packages/groundflare` | [![npm](https://img.shields.io/npm/v/groundflare.svg?color=cb0000)](https://www.npmjs.com/package/groundflare) |
| `create-groundflare-app` — project scaffold | `packages/create-groundflare-app` | planned (v0.3) |

For usage, installation, and design documentation, see the [`groundflare` package README](./packages/groundflare/README.md).

Cross-cutting architecture documents live under [`design/`](./design). They describe the two-runtime track model, bootstrap pipeline, performance measurements, and compatibility matrix that apply to all packages in this repo.

## Working in the monorepo

```bash
# clone + install — npm workspaces links packages/* automatically
git clone https://github.com/solcreek/groundflare.git
cd groundflare
npm ci

# run the CLI from source
npm --prefix packages/groundflare run dev -- bun analyze --cwd ./my-worker

# tests + gates
npm run check
npm run lint
npm test
npm run test:bun
npm run test:e2e
```

## License

MIT — see [LICENSE](./LICENSE).
