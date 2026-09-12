import { beforeEach, describe, expect, it } from 'vitest';

import { redact, redactError, registerSecret } from './redact';

describe('redact', () => {
  it('strips the password out of a Postgres connection string', () => {
    const out = redact(
      'connection to postgresql://neondb_owner:npg_S3cr3tPw@ep-x-pooler.neon.tech/neondb failed',
    );
    expect(out).not.toContain('npg_S3cr3tPw');
    expect(out).toContain('postgresql://neondb_owner:***@ep-x-pooler.neon.tech/neondb');
  });

  it('strips userinfo credentials from any scheme', () => {
    expect(redact('https://admin:hunter2@example.com/x')).toBe('https://admin:***@example.com/x');
  });

  it('removes an entire PEM private key block', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0\n-----END PRIVATE KEY-----';
    const out = redact(`key rejected: ${pem}`);
    expect(out).toBe('key rejected: [REDACTED PEM]');
    expect(out).not.toContain('MIIEvQIBADANBg');
  });

  it('masks Basic and Bearer authorization headers', () => {
    expect(redact('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: Basic ***');
    expect(redact('"Authorization":"Bearer abc.def.ghi"')).toContain('Bearer ***');
  });

  it('masks secret-bearing query params and JSON fields', () => {
    expect(redact('GET /api/cron/ingest?secret=ab12cd34&job=gsc')).toContain('secret=***');
    expect(redact('{"api_key":"sk-live-999","ok":true}')).not.toContain('sk-live-999');
  });

  describe('registered literal secrets', () => {
    beforeEach(() => {
      registerSecret('a-very-distinctive-pingback-secret');
    });

    it('scrubs a registered value even where no pattern would match it', () => {
      const out = redact('tag=a-very-distinctive-pingback-secret');
      expect(out).toBe('tag=***');
    });

    it('ignores values too short to be meaningful secrets', () => {
      registerSecret('abc');
      expect(redact('value abc stays')).toBe('value abc stays');
    });
  });
});

describe('redactError', () => {
  it('collapses an Error to a single safe line', () => {
    const error = new Error(
      'ECONNREFUSED\n  at postgresql://u:p4ssw0rd@db.neon.tech/main\n  at retry()',
    );
    const out = redactError(error);
    expect(out).not.toContain('p4ssw0rd');
    expect(out).not.toContain('\n');
  });

  it('handles non-Error throws', () => {
    expect(redactError('plain string')).toBe('plain string');
    expect(redactError({ code: 'X' })).toBe('{"code":"X"}');
    expect(redactError(undefined)).toBe('undefined');
  });

  it('caps runaway messages', () => {
    expect(redactError(new Error('x'.repeat(5000))).length).toBe(2000);
  });
});
