/**
 * R2 smoke-test worker for v0.5 live validation.
 *
 * Routes:
 *   GET  /             — returns ok
 *   POST /put?k=KEY    — uploads request body to R2 under KEY
 *   GET  /get?k=KEY    — fetches body
 *   GET  /head?k=KEY   — fetches metadata
 *   GET  /list         — lists all objects
 *   DELETE /delete?k=KEY
 */

interface Env {
  MEDIA: R2Bucket
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url)
      const k = url.searchParams.get('k') ?? ''

      if (url.pathname === '/') {
        return new Response('r2-smoke ok', { headers: { 'content-type': 'text/plain' } })
      }
      if (url.pathname === '/put' && req.method === 'POST') {
        const body = await req.arrayBuffer()
        const result = await env.MEDIA.put(k, body, {
          httpMetadata: { contentType: req.headers.get('content-type') ?? 'application/octet-stream' },
          customMetadata: { source: 'smoke' },
        })
        return Response.json({
          ok: true,
          key: result?.key,
          size: result?.size,
          etag: result?.etag,
        })
      }
      if (url.pathname === '/get') {
        const obj = await env.MEDIA.get(k)
        if (!obj) return new Response('not found', { status: 404 })
        return new Response(obj.body, {
          headers: {
            'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
            'x-r2-etag': obj.etag,
            'x-r2-size': String(obj.size),
            'x-r2-source': obj.customMetadata?.source ?? '',
          },
        })
      }
      if (url.pathname === '/head') {
        const meta = await env.MEDIA.head(k)
        if (!meta) return new Response('not found', { status: 404 })
        return Response.json({
          key: meta.key,
          size: meta.size,
          etag: meta.etag,
          httpMetadata: meta.httpMetadata,
          customMetadata: meta.customMetadata,
        })
      }
      if (url.pathname === '/list') {
        const list = await env.MEDIA.list()
        return Response.json({
          truncated: list.truncated,
          objects: list.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag })),
        })
      }
      if (url.pathname === '/delete' && req.method === 'DELETE') {
        await env.MEDIA.delete(k)
        return Response.json({ ok: true })
      }
      return new Response('routes: / /put /get /head /list /delete', { status: 404 })
    } catch (e) {
      return Response.json(
        { ok: false, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined },
        { status: 500 },
      )
    }
  },
}
