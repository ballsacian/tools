import { describe, expect, it } from 'vitest'
import { ExitCode } from '../src/exit-codes.js'

describe('ExitCode', () => {
  it('reserves 0 for clean', () => {
    expect(ExitCode.OK).toBe(0)
  })

  it('keeps findings and operational failures distinct', () => {
    // The whole point of the split: a CI script must be able to tell "the code
    // has a problem" from "the tool could not tell". Collapsing these is the
    // bug inherited from ui-drift.mjs.
    const findings: number[] = [ExitCode.DRIFT, ExitCode.AUTHENTICITY]
    expect(findings).not.toContain(ExitCode.OPERATIONAL)
    expect(findings).not.toContain(ExitCode.OK)
  })

  it('has no duplicate codes', () => {
    const codes = Object.values(ExitCode)
    expect(new Set(codes).size).toBe(codes.length)
  })
})
