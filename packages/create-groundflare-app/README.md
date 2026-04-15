# create-groundflare-app

[![npm](https://img.shields.io/npm/v/create-groundflare-app.svg?color=cb0000)](https://www.npmjs.com/package/create-groundflare-app)

Scaffold a new [groundflare](https://www.npmjs.com/package/groundflare)-ready Cloudflare Worker project.

## Usage

```bash
npm create groundflare-app@latest my-worker
# or: npx create-groundflare-app@latest my-worker

cd my-worker
npx groundflare bun analyze   # see what's compatible with the Bun track
npx groundflare up             # provision a VPS + deploy
```

## Options

```text
create-groundflare-app [project-name] [--template=<name>] [--force]

  project-name    Directory to create (default: groundflare-worker)
  --template      Template identifier (default: minimal)
  --force         Overwrite target directory if it already exists
```

## Templates

| Name | Description |
|---|---|
| `minimal` | Hello-world Worker + commented-out `[groundflare]` section ready to fill in |

More templates land in subsequent releases (Hono, SSR adapters, Durable Object starter).

## License

MIT — see [LICENSE](./LICENSE).
