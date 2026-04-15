/**
 * A minimal Cloudflare Worker that runs unchanged on both tracks:
 *   - Mirror (workerd) — default
 *   - Bun (Bun.serve)  — opt in via `[groundflare] runtime = "bun"`
 */

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 })
    }
    return new Response(`hello from {{name}}\n`, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  },
}
