#!/usr/bin/env node
import('../dist/cli.js')
  .then(({ run }) => run())
  .catch((err) => {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(
        'create-groundflare-app: build artifacts missing. Reinstall the package or run `npm run build` from source.',
      )
      process.exit(1)
    }
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
