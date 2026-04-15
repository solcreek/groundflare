#!/usr/bin/env node
import('../dist/cli.js')
  .then(({ run }) => run())
  .then((code) => {
    if (typeof code === 'number' && code !== 0) process.exit(code)
  })
  .catch((err) => {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(
        'groundflare-estimate: build artifacts missing. Run `npm run build` first.',
      )
      process.exit(1)
    }
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
