import { describe, expect, it } from 'vitest';
import { createLogger, runWithCorrelation, sanitizeCorrelationId, scrub } from './index.js';

function capture() {
  const lines: string[] = [];
  return { lines, destination: { write: (s: string) => void lines.push(s) } };
}

describe('logger', () => {
  it('redacts secret keys at depth and secrets inside text (log scan)', () => {
    const { lines, destination } = capture();
    const log = createLogger({ service: 't', destination });
    log.info(
      { password: 'p@ss-1', nested: { token: 'tok-123456', deep: { apiKey: 'k-999' } }, safe: 'visible' },
      'connecting to postgres://app:hunter2@db:5432/x',
    );
    log.error({ err: new Error('failed with Bearer abcdef1234567890') }, 'boom');
    const out = lines.join('');
    for (const secret of ['p@ss-1', 'tok-123456', 'k-999', 'hunter2', 'abcdef1234567890']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('visible');
    expect(out).toContain('[REDACTED]');
  });

  it('adds the correlation id from the async context', () => {
    const { lines, destination } = capture();
    const log = createLogger({ service: 't', destination });
    runWithCorrelation('corr-12345678', () => log.info('inside'));
    log.info('outside');
    expect(JSON.parse(lines[0]!).correlationId).toBe('corr-12345678');
    expect(JSON.parse(lines[1]!).correlationId).toBeUndefined();
  });

  it('rejects unsafe correlation ids from callers', () => {
    expect(sanitizeCorrelationId('ok-id_12345')).toBe('ok-id_12345');
    expect(sanitizeCorrelationId('bad id\n{"injected":1}')).toBeNull();
    expect(scrub('token ghp_abcdefghijklmnopqrstuvwx')).toBe('token [REDACTED]');
  });
});
