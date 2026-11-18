import { describe, expect, it } from 'vitest';
import { providerErrorKind } from './errorKind';

const err = (o: Record<string, unknown>) => Object.assign(new Error(String(o.message ?? '')), o);

describe('providerErrorKind', () => {
  it.each([
    [err({ status: 401, message: 'Incorrect API key' }), 'auth'],
    [err({ status: 403, message: 'forbidden' }), 'auth'],
    [err({ status: 429, message: 'Rate limit' }), 'quota'],
    [err({ status: 429, code: 'insufficient_quota' }), 'quota'],
    [err({ status: 404, code: 'model_not_found', message: 'The model `gpt-4.1-nano` does not exist or you do not have access to it.' }), 'model'],
    [err({ status: 400, message: 'The model gpt-4.1-nano has been decommissioned.' }), 'model'],
    [err({ status: 503, message: 'Service unavailable' }), 'network'],
    [err({ status: 529, message: 'Overloaded' }), 'network'],
    [err({ code: 'ECONNRESET', message: 'socket hang up' }), 'network'],
    [err({ name: 'AbortError', message: 'The operation was aborted' }), 'aborted'],
    [err({ status: 400, message: 'Bad request: max_tokens too large' }), 'other'],
  ])('%s → %s', (e, kind) => {
    expect(providerErrorKind(e)).toBe(kind);
  });

  it('reads through the compat adapter’s re-thrown error to its cause', () => {
    const cause = err({ status: 404, code: 'model_not_found', message: 'model not found' });
    const wrapped = Object.assign(new Error('Groq error 404: model not found'), { cause });
    expect(providerErrorKind(wrapped)).toBe('model');
  });
});
