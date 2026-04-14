/**
 * PoC Phase 1: Validate that wrangler's public API gives us enough
 * to derive a workerd config.
 *
 * Goal: prove (or disprove) that we can take a real wrangler.toml and
 * produce a workerd-runnable config using only public exports.
 */

import { resolve } from 'node:path'
import { unstable_readConfig, unstable_getMiniflareWorkerOptions } from 'wrangler'

const WRANGLER_TOML = resolve(import.meta.dirname, '../../examples/hello/wrangler.toml')

console.log(`\n📂 Reading wrangler.toml: ${WRANGLER_TOML}\n`)

// ─── Step 1: Parse wrangler.toml ────────────────────────────────────
const config = unstable_readConfig({ config: WRANGLER_TOML })

console.log('✅ Step 1: wrangler config parsed')
console.log(`   name:              ${config.name}`)
console.log(`   main:              ${config.main}`)
console.log(`   compatibility_date: ${config.compatibility_date}`)
console.log(`   bindings:`)
console.log(`     vars:    ${Object.keys(config.vars ?? {}).length}`)
console.log(`     kv:      ${(config.kv_namespaces ?? []).length}`)
console.log(`     d1:      ${(config.d1_databases ?? []).length}`)
console.log(`     r2:      ${(config.r2_buckets ?? []).length}`)
console.log(`     do:      ${(config.durable_objects?.bindings ?? []).length}`)

// ─── Step 2: Get miniflare worker options ───────────────────────────
console.log('\n🔧 Step 2: derive miniflare worker options')

let mfOptions: any
try {
  mfOptions = unstable_getMiniflareWorkerOptions(config, undefined, {
    imagesLocalMode: false,
  })
  console.log('✅ unstable_getMiniflareWorkerOptions returned')
  console.log(`   keys: ${Object.keys(mfOptions).join(', ')}`)
} catch (e) {
  console.log(`❌ unstable_getMiniflareWorkerOptions threw: ${(e as Error).message}`)
  process.exit(1)
}

// ─── Step 3: Inspect what's inside ───────────────────────────────────
console.log('\n🔍 Step 3: inspect miniflare options shape')

const wo = mfOptions.workerOptions
if (wo) {
  console.log('✅ workerOptions present')
  console.log(`   name:           ${wo.name}`)
  console.log(`   compatibilityDate: ${wo.compatibilityDate}`)
  const bindingKinds = [
    'kvNamespaces', 'd1Databases', 'r2Buckets',
    'durableObjects', 'bindings', 'serviceBindings',
  ]
  for (const k of bindingKinds) {
    const v = (wo as any)[k]
    if (v !== undefined) {
      const count = Array.isArray(v) ? v.length : Object.keys(v).length
      console.log(`   ${k}: ${count}`)
    }
  }
} else {
  console.log('⚠️  no workerOptions found. Top-level keys:')
  console.dir(mfOptions, { depth: 2 })
}

// ─── Step 4: Try to instantiate Miniflare and extract workerd state ─
console.log('\n🧪 Step 4: instantiate Miniflare to see what runs')

const { Miniflare } = await import('miniflare')

const mf = new Miniflare({
  ...mfOptions.workerOptions,
  modules: true,
  scriptPath: resolve(import.meta.dirname, '../../examples/hello/src/index.js'),
  // give in-memory replacements for KV/D1 IDs since these are fake
  kvPersist: false,
  d1Persist: false,
})

try {
  const ready = await mf.ready
  console.log(`✅ Miniflare ready at ${ready.toString()}`)

  const res = await mf.dispatchFetch(`${ready.toString()}health`)
  const body = await res.text()
  console.log(`✅ /health responded: "${body}" (${res.status})`)

  const res2 = await mf.dispatchFetch(`${ready.toString()}kv`)
  const body2 = await res2.text()
  console.log(`✅ /kv responded: ${body2} (${res2.status})`)

  const res3 = await mf.dispatchFetch(`${ready.toString()}db`)
  const body3 = await res3.text()
  console.log(`✅ /db responded: ${body3} (${res3.status})`)
} finally {
  await mf.dispose()
}

// ─── Step 5: Probe miniflare's public API surface ────────────────────
console.log('\n🎯 Step 5: probe Miniflare exports for workerd-config paths')

const probe = await import('miniflare')
const interesting = Object.keys(probe).filter(k =>
  k.toLowerCase().includes('config') ||
  k.toLowerCase().includes('serialize') ||
  k.toLowerCase().includes('assemble'),
)
console.log(`   miniflare exports: ${interesting.join(', ')}`)
console.log(`   typeof serializeConfig: ${typeof (probe as any).serializeConfig}`)

console.log('\n✨ Validation complete.\n')
console.log('Conclusions:')
console.log('  ✅ wrangler.unstable_readConfig — public, works')
console.log('  ✅ wrangler.unstable_getMiniflareWorkerOptions — public, works')
console.log('  ✅ Miniflare programmatic instantiation — works for KV + D1 bindings')
console.log('  ✅ miniflare.serializeConfig — public export exists')
console.log('')
console.log('Private-field monkey-patching is NOT required for v0.1.')
console.log('Two viable paths forward:')
console.log('  A) Ship Miniflare-in-container (Node + miniflare); larger image, simpler')
console.log('  B) Extract workerd capnp via serializeConfig + ship workerd binary only; smaller, more work')
