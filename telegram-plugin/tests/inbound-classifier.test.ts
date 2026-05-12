import { describe, it, expect } from 'vitest'
import { classifyInbound } from '../inbound-classifier.js'

describe('inbound-classifier — status query', () => {
  describe('positive matches (status_query=true)', () => {
    const positives = [
      '?',
      '??',
      '???',
      'status',
      'Status',
      'STATUS',
      'status?',
      'status ?',
      'update',
      'update?',
      'any update',
      'any update?',
      'still there',
      'still there?',
      'Still There?',
      'still working',
      'still working?',
      'are you there',
      'are you there?',
      'you there',
      'you there?',
      'hello?',
      'Hello??',
      'hey?',
      // surrounding whitespace
      '  status?  ',
      '\nstill there?\n',
    ]
    for (const text of positives) {
      it(`matches: ${JSON.stringify(text)}`, () => {
        expect(classifyInbound(text).isStatusQuery).toBe(true)
      })
    }
  })

  describe('negative matches (status_query=false)', () => {
    const negatives = [
      '',
      '   ',
      'hello',
      'hi',
      'what is the status of the deploy',
      'status of the deploy?',
      'are you there with the report',
      'what update did you see',
      'i need an update on the metrics',
      // Plausible but rejected — message too long to be a standalone ping
      'status? also can you check the deployment script for the lint errors please',
      // Punctuation-shaped but not a query
      '.',
      '!',
      '!?',
    ]
    for (const text of negatives) {
      it(`does not match: ${JSON.stringify(text)}`, () => {
        expect(classifyInbound(text).isStatusQuery).toBe(false)
      })
    }
  })

  it('handles null/undefined safely', () => {
    expect(classifyInbound(null).isStatusQuery).toBe(false)
    expect(classifyInbound(undefined).isStatusQuery).toBe(false)
  })

  it('does not match messages over 40 chars even if they start with a status word', () => {
    const longPretendStatusQuery = 'status? but actually i wanted to ask about deploys'
    expect(classifyInbound(longPretendStatusQuery).isStatusQuery).toBe(false)
  })
})
