import { describe, expect, it } from 'vitest';

import { createLogger, type LogLevel } from './logger';

function capture(minLevel: LogLevel = 'debug') {
  const lines: Array<{ level: LogLevel; parsed: Record<string, unknown> }> = [];
  const logger = createLogger(
    {},
    { minLevel, sink: (level, line) => lines.push({ level, parsed: JSON.parse(line) }) },
  );
  return { logger, lines };
}

describe('createLogger', () => {
  it('emits one JSON object per line with level and message', () => {
    const { logger, lines } = capture();
    logger.info('ingest complete');

    expect(lines).toHaveLength(1);
    expect(lines[0]!.parsed).toMatchObject({ level: 'info', message: 'ingest complete' });
  });

  it('carries the §12 fields', () => {
    const { logger, lines } = capture();
    logger.info('done', {
      job: 'ingest-gsc',
      run_id: 'run-1',
      property_id: 'prop-1',
      duration_ms: 1234,
      rows_written: 48,
    });

    expect(lines[0]!.parsed).toMatchObject({
      job: 'ingest-gsc',
      run_id: 'run-1',
      property_id: 'prop-1',
      duration_ms: 1234,
      rows_written: 48,
    });
  });

  it('respects the minimum level', () => {
    const { logger, lines } = capture('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('routes errors and warnings to their own sink level', () => {
    const { logger, lines } = capture();
    logger.error('boom');
    expect(lines[0]!.level).toBe('error');
  });

  describe('child loggers', () => {
    it('inherit context and can add to it', () => {
      const { logger, lines } = capture();
      const run = logger.child({ job: 'ingest-gsc', run_id: 'run-1' });
      const property = run.child({ property_id: 'prop-1' });

      property.info('per-property');

      expect(lines[0]!.parsed).toMatchObject({
        job: 'ingest-gsc',
        run_id: 'run-1',
        property_id: 'prop-1',
      });
    });

    it('do not leak context back to the parent', () => {
      const { logger, lines } = capture();
      logger.child({ property_id: 'prop-1' }).info('child');
      logger.info('parent');

      expect(lines[1]!.parsed.property_id).toBeUndefined();
    });

    it('let per-call fields override context', () => {
      const { logger, lines } = capture();
      logger.child({ job: 'a' }).info('x', { job: 'b' });
      expect(lines[0]!.parsed.job).toBe('b');
    });
  });

  describe('redaction', () => {
    it('scrubs a connection string in the message', () => {
      const { logger, lines } = capture();
      logger.error('failed: postgresql://u:hunter2@db.neon.tech/main');

      expect(JSON.stringify(lines[0]!.parsed)).not.toContain('hunter2');
    });

    it('scrubs a credential nested inside a field, by field NAME', () => {
      // Pattern matching cannot save us here: once the pair becomes
      // {Authorization: "Basic dXNlcj..."} the key is JSON structure and the
      // value is a short opaque string. The field name is the reliable signal.
      const { logger, lines } = capture();
      logger.error('call failed', {
        meta: { request: { headers: { Authorization: 'Basic dXNlcjpwYXNz' } } },
      });

      const serialised = JSON.stringify(lines[0]!.parsed);
      expect(serialised).not.toContain('dXNlcjpwYXNz');
      expect(serialised).toContain('***');
    });

    it('scrubs every conventional credential field name', () => {
      const { logger, lines } = capture();
      logger.error('config dump', {
        secret: 'cron-secret-value',
        token: 'tok_live_123',
        password: 'hunter2',
        api_key: 'sk-live-999',
        privateKey: '-----BEGIN PRIVATE KEY-----abc',
        cookie: 'session=abc123',
      });

      const serialised = JSON.stringify(lines[0]!.parsed);
      for (const leaked of ['cron-secret-value', 'tok_live_123', 'hunter2', 'sk-live-999', 'abc123']) {
        expect(serialised, `leaked ${leaked}`).not.toContain(leaked);
      }
    });

    it('does not redact an innocent field that merely mentions a scheme', () => {
      // The reason for keying off the name rather than widening the pattern:
      // a pattern loose enough to catch "Basic dXNlcj..." also eats prose.
      const { logger, lines } = capture();
      logger.info('note', { message_body: 'Basic understanding of the local pack' });
      expect(lines[0]!.parsed.message_body).toBe('Basic understanding of the local pack');
    });

    it('scrubs a secret inside an array of objects', () => {
      const { logger, lines } = capture();
      logger.warn('batch', { tasks: [{ url: 'https://x.com?secret=abcdef123456' }] });
      expect(JSON.stringify(lines[0]!.parsed)).not.toContain('abcdef123456');
    });

    it('reduces an Error field to a safe single line', () => {
      const { logger, lines } = capture();
      logger.error('threw', {
        cause: new Error('postgres://u:p4ssw0rd@h/db\n  at frame()'),
      });

      const serialised = JSON.stringify(lines[0]!.parsed);
      expect(serialised).not.toContain('p4ssw0rd');
      expect(lines[0]!.parsed.cause).not.toContain('\n');
    });
  });

  describe('robustness', () => {
    it('does not throw on a circular field', () => {
      // A bad log field must not take down the job it was describing.
      const { logger, lines } = capture();
      const circular: Record<string, unknown> = { name: 'x' };
      circular.self = circular;

      expect(() => logger.info('cyclic', { circular })).not.toThrow();
      expect(lines).toHaveLength(1);
    });

    it('bounds deep nesting rather than recursing forever', () => {
      const { logger, lines } = capture();
      let deep: Record<string, unknown> = { value: 'leaf' };
      for (let i = 0; i < 20; i++) deep = { nested: deep };

      expect(() => logger.info('deep', { deep })).not.toThrow();
      expect(JSON.stringify(lines[0]!.parsed)).toContain('depth limit');
    });

    it('truncates a very long array instead of serialising all of it', () => {
      const { logger, lines } = capture();
      logger.info('big', { items: Array.from({ length: 500 }, (_, i) => i) });
      expect((lines[0]!.parsed.items as unknown[]).length).toBe(100);
    });

    it('serialises Dates as ISO strings', () => {
      const { logger, lines } = capture();
      logger.info('at', { when: new Date('2026-09-12T00:00:00Z') });
      expect(lines[0]!.parsed.when).toBe('2026-09-12T00:00:00.000Z');
    });
  });
});
