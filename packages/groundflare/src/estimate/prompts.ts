/**
 * Interactive Usage collection via consola prompts.
 *
 * One prompt per field. Defaults target a "typical micro-SaaS" profile A
 * so someone mashing Enter gets a plausible but small estimate.
 */

import { consola } from 'consola'

import type { Usage } from './types.js'

const DEFAULTS: Usage = {
  requestsPerMonth: 1_000_000,
  cpuMsPerRequest: 5,
  avgResponseKB: 20,
  d1StorageGB: 1,
  d1ReadsPerMonth: 5_000_000,
  d1WritesPerMonth: 100_000,
  kvStorageGB: 0,
  kvReadsPerMonth: 0,
  kvWritesPerMonth: 0,
  r2StorageGB: 5,
  r2ClassAOpsPerMonth: 10_000,
  r2ClassBOpsPerMonth: 1_000_000,
  doInstanceCount: 0,
  doRequestsPerMonth: 0,
  doDurationGBSeconds: 0,
  doStorageGB: 0,
  usesWorkersAI: false,
  usesBrowserRendering: false,
  usesVectorize: false,
  usesHyperdrive: false,
}

export async function promptUsage(): Promise<Usage> {
  consola.info('Answer a few questions — press Enter to accept the default.')

  const requestsPerMonth = await promptNumber(
    'Worker requests per month',
    DEFAULTS.requestsPerMonth,
  )
  const cpuMsPerRequest = await promptNumber(
    'Average CPU time per request (ms)',
    DEFAULTS.cpuMsPerRequest,
  )
  const avgResponseKB = await promptNumber(
    'Average response size (KB)',
    DEFAULTS.avgResponseKB,
  )

  const d1StorageGB = await promptNumber('D1 storage (GB)', DEFAULTS.d1StorageGB)
  const d1ReadsPerMonth = await promptNumber(
    'D1 rows read per month',
    DEFAULTS.d1ReadsPerMonth,
  )
  const d1WritesPerMonth = await promptNumber(
    'D1 rows written per month',
    DEFAULTS.d1WritesPerMonth,
  )

  const kvStorageGB = await promptNumber('KV storage (GB)', DEFAULTS.kvStorageGB)
  const kvReadsPerMonth = await promptNumber(
    'KV reads per month',
    DEFAULTS.kvReadsPerMonth,
  )
  const kvWritesPerMonth = await promptNumber(
    'KV writes per month',
    DEFAULTS.kvWritesPerMonth,
  )

  const r2StorageGB = await promptNumber('R2 storage (GB)', DEFAULTS.r2StorageGB)
  const r2ClassAOpsPerMonth = await promptNumber(
    'R2 class A operations per month (writes, lists)',
    DEFAULTS.r2ClassAOpsPerMonth,
  )
  const r2ClassBOpsPerMonth = await promptNumber(
    'R2 class B operations per month (reads)',
    DEFAULTS.r2ClassBOpsPerMonth,
  )

  const doInstanceCount = await promptNumber(
    'Distinct Durable Object instances',
    DEFAULTS.doInstanceCount,
  )
  const doRequestsPerMonth = await promptNumber(
    'DO requests per month',
    DEFAULTS.doRequestsPerMonth,
  )
  const doDurationGBSeconds = await promptNumber(
    'DO duration (GB-seconds)',
    DEFAULTS.doDurationGBSeconds,
  )
  const doStorageGB = await promptNumber('DO storage (GB)', DEFAULTS.doStorageGB)

  const usesWorkersAI = await promptBool('Use Workers AI?', DEFAULTS.usesWorkersAI)
  const usesBrowserRendering = await promptBool(
    'Use Browser Rendering?',
    DEFAULTS.usesBrowserRendering,
  )
  const usesVectorize = await promptBool('Use Vectorize?', DEFAULTS.usesVectorize)
  const usesHyperdrive = await promptBool('Use Hyperdrive?', DEFAULTS.usesHyperdrive)

  return {
    requestsPerMonth,
    cpuMsPerRequest,
    avgResponseKB,
    d1StorageGB,
    d1ReadsPerMonth,
    d1WritesPerMonth,
    kvStorageGB,
    kvReadsPerMonth,
    kvWritesPerMonth,
    r2StorageGB,
    r2ClassAOpsPerMonth,
    r2ClassBOpsPerMonth,
    doInstanceCount,
    doRequestsPerMonth,
    doDurationGBSeconds,
    doStorageGB,
    usesWorkersAI,
    usesBrowserRendering,
    usesVectorize,
    usesHyperdrive,
  }
}

async function promptNumber(message: string, defaultValue: number): Promise<number> {
  const raw = await consola.prompt(message, {
    type: 'text',
    default: String(defaultValue),
  })
  if (raw === undefined || raw === null || raw === '') return defaultValue
  const n = Number(String(raw).replace(/[_,]/g, ''))
  if (!Number.isFinite(n) || n < 0) return defaultValue
  return n
}

async function promptBool(message: string, defaultValue: boolean): Promise<boolean> {
  const answer = await consola.prompt(message, {
    type: 'confirm',
    initial: defaultValue,
  })
  return answer === true
}

export { DEFAULTS as USAGE_DEFAULTS }
