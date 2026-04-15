import { describe, it, expect } from 'vitest'

describe('scaffolding sanity', () => {
  it('runs the test pipeline end-to-end', () => {
    expect(1 + 1).toBe(2)
  })

  it('respects TypeScript strict mode', () => {
    const x: number = 42
    expect(typeof x).toBe('number')
  })

  it('handles async assertions', async () => {
    await expect(Promise.resolve('ok')).resolves.toBe('ok')
  })
})
