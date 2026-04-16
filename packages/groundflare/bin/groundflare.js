#!/usr/bin/env node

// Silence node:sqlite's experimental warning on Node 22 before any
// import resolves to it. Stable on Node 24; Node 22 LTS still flags
// it. One-liner is cheaper than forcing engines to >=24.
const _origEmit = process.emitWarning
process.emitWarning = function (warning, ...args) {
  const text = typeof warning === 'string' ? warning : warning?.message
  if (typeof text === 'string' && text.includes('SQLite')) return
  return _origEmit.call(process, warning, ...args)
}

import('../dist/cli/index.js')
  .then(({ run }) => run())
  .catch((err) => {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      // Either build artifacts are missing, or a runtime dep failed to
      // resolve. `moduleName` (when present) disambiguates.
      if (err.moduleName) {
        console.error(
          `groundflare: missing runtime dependency ${JSON.stringify(err.moduleName)}.\n` +
            'Reinstall with `npm install groundflare` to restore it.',
        )
      } else {
        console.error(
          'groundflare: build artifacts missing. Run `npm run build` first.',
        )
      }
      process.exit(1)
    }
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
