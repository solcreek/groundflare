export default {
  async fetch(req, env) {
    const url = new URL(req.url)

    if (url.pathname === '/health') {
      return new Response('ok')
    }

    if (url.pathname === '/kv') {
      await env.CACHE.put('last-visit', new Date().toISOString())
      const value = await env.CACHE.get('last-visit')
      return Response.json({ binding: 'KV', value })
    }

    if (url.pathname === '/db') {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS visits (ts TEXT)')
      await env.DB.prepare('INSERT INTO visits (ts) VALUES (?)').bind(new Date().toISOString()).run()
      const { results } = await env.DB.prepare('SELECT COUNT(*) as count FROM visits').all()
      return Response.json({ binding: 'D1', visits: results })
    }

    return new Response(`${env.GREETING} — try /health, /kv, or /db`)
  },
}
