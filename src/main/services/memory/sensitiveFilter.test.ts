import { describe, expect, it } from 'vitest';
import { checkSensitive } from './sensitiveFilter';

describe('checkSensitive — the never-store gate', () => {
  const rejected: [string, string][] = [
    ['My password is hunter2 for the staging box.', 'credential'],
    ['The API key is sk-abc123XYZ456789 for prod.', 'credential'],
    ['AWS key AKIAIOSFODNN7EXAMPLE is in the vault.', 'credential'],
    ['Card number 4111 1111 1111 1111 expires next year.', 'payment'],
    ['My IBAN is listed in the doc.', 'payment'],
    ['SSN is 123-45-6789.', 'government-id'],
    ['Passport number needs renewing before the trip.', 'government-id'],
    ['She was diagnosed with diabetes last spring.', 'health'],
    ['He takes medication for anxiety.', 'health'],
    ['They discussed his religious beliefs at length.', 'sensitive-personal'],
    ['Her immigration status is still pending.', 'sensitive-personal'],
  ];

  for (const [text, reason] of rejected) {
    it(`rejects ${reason}: "${text.slice(0, 40)}…"`, () => {
      expect(checkSensitive(text)).toEqual({ sensitive: true, reason });
    });
  }

  it('passes benign, durable facts', () => {
    for (const text of [
      'Prefers concise bullet-point answers in meetings.',
      'Sam is the design lead on the checkout project.',
      'Goal: ship the pricing page redesign by Q3.',
      'Uses a two-week sprint cadence with Friday demos.',
      'Decided to build on Postgres rather than Mongo.',
    ]) {
      expect(checkSensitive(text)).toEqual({ sensitive: false, reason: null });
    }
  });
});
