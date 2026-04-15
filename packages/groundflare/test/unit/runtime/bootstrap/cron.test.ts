import { describe, it, expect } from 'vitest'
import {
  UnsupportedCronError,
  cronToSystemdCalendar,
  parseCron,
} from '../../../../src/runtime/bootstrap/index.js'

describe('parseCron — happy paths', () => {
  it('parses `* * * * *` as all-any', () => {
    const f = parseCron('* * * * *')
    expect(f.minute).toEqual({ kind: 'any' })
    expect(f.hour).toEqual({ kind: 'any' })
    expect(f.day).toEqual({ kind: 'any' })
    expect(f.month).toEqual({ kind: 'any' })
    expect(f.weekday).toEqual({ kind: 'any' })
  })

  it('parses specific values in every field', () => {
    const f = parseCron('15 9 3 6 2')
    expect(f.minute).toEqual({ kind: 'value', value: 15 })
    expect(f.hour).toEqual({ kind: 'value', value: 9 })
    expect(f.day).toEqual({ kind: 'value', value: 3 })
    expect(f.month).toEqual({ kind: 'value', value: 6 })
    expect(f.weekday).toEqual({ kind: 'value', value: 2 })
  })

  it('parses step values (*/N)', () => {
    const f = parseCron('*/5 */2 * * *')
    expect(f.minute).toEqual({ kind: 'step', step: 5 })
    expect(f.hour).toEqual({ kind: 'step', step: 2 })
  })

  it('normalizes weekday 7 to 0 (both = Sunday)', () => {
    const f = parseCron('0 0 * * 7')
    expect(f.weekday).toEqual({ kind: 'value', value: 0 })
  })

  it('parses weekday range 1-5', () => {
    const f = parseCron('0 9 * * 1-5')
    expect(f.weekday).toEqual({ kind: 'range', from: 1, to: 5 })
  })

  it('parses weekday list 1,3,5 and deduplicates + sorts', () => {
    const f = parseCron('0 9 * * 5,3,1,3')
    expect(f.weekday).toEqual({ kind: 'list', values: [1, 3, 5] })
  })

  it('tolerates extra whitespace between fields', () => {
    const f = parseCron('   *   *   *   *   *   ')
    expect(f.minute).toEqual({ kind: 'any' })
  })
})

describe('parseCron — rejections', () => {
  it('rejects expressions with fewer than 5 fields', () => {
    expect(() => parseCron('* * * *')).toThrow(UnsupportedCronError)
  })

  it('rejects expressions with more than 5 fields', () => {
    expect(() => parseCron('* * * * * *')).toThrow(UnsupportedCronError)
  })

  it('rejects letters in simple fields', () => {
    expect(() => parseCron('A * * * *')).toThrow(/minute/)
    expect(() => parseCron('* H * * *')).toThrow(/hour/)
  })

  it('rejects out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/minute value 60/)
    expect(() => parseCron('* 24 * * *')).toThrow(/hour value 24/)
    expect(() => parseCron('* * 0 * *')).toThrow(/day value 0/)
    expect(() => parseCron('* * 32 * *')).toThrow(/day value 32/)
    expect(() => parseCron('* * * 0 *')).toThrow(/month value 0/)
    expect(() => parseCron('* * * 13 *')).toThrow(/month value 13/)
    expect(() => parseCron('* * * * 8')).toThrow(/weekday 8/)
  })

  it('rejects step=0 and step=oversized', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/)
    expect(() => parseCron('*/60 * * * *')).toThrow(/step/)
  })

  it('rejects ranges in non-weekday fields', () => {
    expect(() => parseCron('1-5 * * * *')).toThrow(/unsupported minute field/)
    expect(() => parseCron('* 9-17 * * *')).toThrow(/unsupported hour field/)
  })

  it('rejects weekday range that wraps (e.g. 5-2)', () => {
    expect(() => parseCron('0 0 * * 5-2')).toThrow(/wraps past Saturday/)
  })

  it('rejects mixed list/range syntax', () => {
    expect(() => parseCron('0 0 * * 1,3-5')).toThrow(UnsupportedCronError)
  })
})

describe('cronToSystemdCalendar — every-minute patterns', () => {
  it('translates `* * * * *` to wildcard all', () => {
    expect(cronToSystemdCalendar('* * * * *')).toBe('*-*-* *:*:00')
  })

  it('translates `*/5 * * * *` to 0-stepped minute', () => {
    expect(cronToSystemdCalendar('*/5 * * * *')).toBe('*-*-* *:0/5:00')
  })

  it('translates `*/30 * * * *` similarly', () => {
    expect(cronToSystemdCalendar('*/30 * * * *')).toBe('*-*-* *:0/30:00')
  })
})

describe('cronToSystemdCalendar — fixed-minute patterns', () => {
  it('translates `30 * * * *` to every hour at :30', () => {
    expect(cronToSystemdCalendar('30 * * * *')).toBe('*-*-* *:30:00')
  })

  it('translates `0 * * * *` to every hour at :00 (hourly)', () => {
    expect(cronToSystemdCalendar('0 * * * *')).toBe('*-*-* *:0:00')
  })
})

describe('cronToSystemdCalendar — fixed-time patterns', () => {
  it('translates `0 0 * * *` to daily midnight', () => {
    expect(cronToSystemdCalendar('0 0 * * *')).toBe('*-*-* 0:0:00')
  })

  it('translates `30 9 * * *` to daily 09:30', () => {
    expect(cronToSystemdCalendar('30 9 * * *')).toBe('*-*-* 9:30:00')
  })

  it('translates `0 0 1 * *` to monthly on the 1st', () => {
    expect(cronToSystemdCalendar('0 0 1 * *')).toBe('*-*-1 0:0:00')
  })

  it('translates `0 0 1 1 *` to yearly', () => {
    expect(cronToSystemdCalendar('0 0 1 1 *')).toBe('*-1-1 0:0:00')
  })
})

describe('cronToSystemdCalendar — weekday patterns', () => {
  it('translates `0 0 * * 0` to Sunday midnight', () => {
    expect(cronToSystemdCalendar('0 0 * * 0')).toBe('Sun *-*-* 0:0:00')
  })

  it('normalizes `0 0 * * 7` to Sunday too', () => {
    expect(cronToSystemdCalendar('0 0 * * 7')).toBe('Sun *-*-* 0:0:00')
  })

  it('translates `0 9 * * 1-5` to Mon..Fri at 09:00', () => {
    expect(cronToSystemdCalendar('0 9 * * 1-5')).toBe('Mon..Fri *-*-* 9:0:00')
  })

  it('translates `0 9 * * 1,3,5` to Mon,Wed,Fri at 09:00', () => {
    expect(cronToSystemdCalendar('0 9 * * 1,3,5')).toBe('Mon,Wed,Fri *-*-* 9:0:00')
  })

  it('translates `0 0 * * */2` to Sun,Tue,Thu,Sat (every other day)', () => {
    expect(cronToSystemdCalendar('0 0 * * */2')).toBe('Sun,Tue,Thu,Sat *-*-* 0:0:00')
  })
})

describe('cronToSystemdCalendar — UnsupportedCronError carries the expression', () => {
  it('attaches the original expression to the error', () => {
    try {
      cronToSystemdCalendar('bad cron here x y z')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCronError)
      expect((err as UnsupportedCronError).expression).toBe('bad cron here x y z')
    }
  })
})
