#!/usr/bin/env node
import('../dist/cli/index.js')
  .then(({ run }) => run())
  .catch((err) => {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('groundflare: build artifacts missing. Run `npm run build` first.')
      process.exit(1)
    }
    console.error(err.stack ?? err)
    process.exit(1)
  })
