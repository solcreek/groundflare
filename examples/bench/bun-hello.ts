// Minimal Bun HTTP handler — matches examples/bench/worker.js for fair comparison.
const port = Number(process.env.BUN_PORT ?? 8091)

Bun.serve({
  port,
  fetch() {
    return new Response('ok')
  },
})

console.log(`bun-hello listening on :${port}`)
