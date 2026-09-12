import { describe, expect, it } from 'vitest';

import { requestSecretMatches, secretsMatch } from './secret-compare';

const SECRET = 'a'.repeat(64);

describe('secretsMatch', () => {
  it('accepts the exact secret', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
  });

  it('rejects a wrong secret of the same length', () => {
    expect(secretsMatch('b'.repeat(64), SECRET)).toBe(false);
  });

  it('rejects a correct PREFIX — the attack this exists to stop', () => {
    expect(secretsMatch('a'.repeat(63), SECRET)).toBe(false);
    expect(secretsMatch('a'.repeat(65), SECRET)).toBe(false);
  });

  it('rejects empty, null and undefined without throwing', () => {
    // timingSafeEqual throws on length mismatch; hashing first means a
    // different-length guess cannot be distinguished by an error path either.
    expect(secretsMatch('', SECRET)).toBe(false);
    expect(secretsMatch(null, SECRET)).toBe(false);
    expect(secretsMatch(undefined, SECRET)).toBe(false);
  });

  it('rejects everything when the expected secret is empty', () => {
    // Fail closed: a misconfigured deployment must not accept all callers.
    expect(secretsMatch('anything', '')).toBe(false);
    expect(secretsMatch('', '')).toBe(false);
  });

  it('does not throw on wildly mismatched lengths', () => {
    expect(() => secretsMatch('x', SECRET)).not.toThrow();
    expect(() => secretsMatch('x'.repeat(10_000), SECRET)).not.toThrow();
  });
});

describe('requestSecretMatches', () => {
  const url = 'https://app.example.com/api/cron/ingest-gsc';

  it('accepts a Bearer header — what Vercel cron sends', () => {
    const request = new Request(url, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(requestSecretMatches(request, SECRET)).toBe(true);
  });

  it('accepts a ?secret= query param — what a header-less scheduler sends', () => {
    const request = new Request(`${url}?secret=${SECRET}`);
    expect(requestSecretMatches(request, SECRET)).toBe(true);
  });

  it('rejects a wrong header', () => {
    const request = new Request(url, { headers: { authorization: 'Bearer nope' } });
    expect(requestSecretMatches(request, SECRET)).toBe(false);
  });

  it('rejects a wrong query param', () => {
    expect(requestSecretMatches(new Request(`${url}?secret=nope`), SECRET)).toBe(false);
  });

  it('rejects a request carrying neither', () => {
    expect(requestSecretMatches(new Request(url), SECRET)).toBe(false);
  });

  it('rejects a Basic header even when it carries the right value', () => {
    const request = new Request(url, { headers: { authorization: `Basic ${SECRET}` } });
    expect(requestSecretMatches(request, SECRET)).toBe(false);
  });

  it('falls through to the query param when the header is wrong', () => {
    const request = new Request(`${url}?secret=${SECRET}`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(requestSecretMatches(request, SECRET)).toBe(true);
  });
});
