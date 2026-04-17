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

/**
 * Drives a full multipart upload against the local SeaweedFS sidecar:
 * createMultipartUpload → uploadPart × 2 (5 MiB each, minimum S3 part
 * size except for the final part) → completeMultipartUpload → GET-back
 * for verification. Returns a JSON report.
 *
 * Exists so groundflare's v0.5 live validation can exercise the R2
 * adapter's multipart hot path end-to-end on a real droplet. The L3
 * e2e suite covers it locally against a downloaded weed binary; this
 * endpoint closes the loop on real VPS deploys.
 */
async function multipartSelfTest(env: Env): Promise<Response> {
  const key = 'mp-test.bin'
  const partSize = 5 * 1024 * 1024
  // First part: 5 MiB of 'A' = 0x41
  const part1 = new Uint8Array(partSize).fill(0x41)
  // Last part: small tail, can be <5 MiB
  const tailText = 'MULTIPART-END-MARKER'
  const part2 = new TextEncoder().encode(tailText)

  const started = Date.now()
  const upload = await env.MEDIA.createMultipartUpload(key, {
    httpMetadata: { contentType: 'application/octet-stream' },
  })

  const resumed = env.MEDIA.resumeMultipartUpload(key, upload.uploadId)
  const u1 = await resumed.uploadPart(1, part1)
  const u2 = await resumed.uploadPart(2, part2)

  const result = await resumed.complete([
    { partNumber: u1.partNumber, etag: u1.etag },
    { partNumber: u2.partNumber, etag: u2.etag },
  ])

  // Pull the final object back to verify — headers tell us size +
  // etag; the tail marker in the last bytes confirms ordering.
  const got = await env.MEDIA.get(key)
  const body = got ? await got.arrayBuffer() : null
  const tailSeen =
    body && body.byteLength >= tailText.length
      ? new TextDecoder().decode(
          new Uint8Array(body).subarray(body.byteLength - tailText.length),
        )
      : null

  await env.MEDIA.delete(key)

  return Response.json({
    ok: result !== null,
    elapsedMs: Date.now() - started,
    uploadId: upload.uploadId,
    result: result
      ? {
          key: result.key,
          size: result.size,
          etag: result.etag,
        }
      : null,
    verify: {
      getSize: body?.byteLength ?? null,
      expectedSize: partSize + part2.byteLength,
      tailMatches: tailSeen === tailText,
    },
  })
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
      if (url.pathname === '/multipart-test') {
        return await multipartSelfTest(env)
      }
      return new Response('routes: / /put /get /head /list /delete /multipart-test', { status: 404 })
    } catch (e) {
      return Response.json(
        { ok: false, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined },
        { status: 500 },
      )
    }
  },
}
