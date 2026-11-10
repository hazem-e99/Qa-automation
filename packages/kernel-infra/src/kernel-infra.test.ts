import { describe, expect, it } from 'vitest';
import { BaseConfig, ConfigError, evaluateReadiness, loadConfig } from './index.js';

describe('loadConfig', () => {
  it('applies defaults and accepts a valid environment', () => {
    const c = loadConfig(BaseConfig, { DATABASE_URL: 'postgres://u:p@h:5432/d' });
    expect(c).toMatchObject({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
  });
  it('names the bad variable without echoing its value', () => {
    try {
      loadConfig(BaseConfig, { DATABASE_URL: 'mysql://user:supersecret@h/d', LOG_LEVEL: 'loud' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('LOG_LEVEL');
      expect(msg).not.toContain('supersecret');
    }
  });
});

describe('evaluateReadiness', () => {
  const base = { service: 's', version: '1' };
  it('is ok only when every check passes', async () => {
    const ok = await evaluateReadiness({ ...base, checks: { a: async () => {}, b: async () => {} } });
    expect(ok.status).toBe('ok');
    const bad = await evaluateReadiness({
      ...base,
      checks: {
        a: async () => {},
        b: async () => {
          throw new Error('password=hunter2 refused');
        },
      },
    });
    expect(bad.status).toBe('fail');
    expect(bad.checks.b).toEqual({ status: 'fail', detail: 'unavailable' });
    expect(JSON.stringify(bad)).not.toContain('hunter2');
  });
  it('fails a check that hangs', async () => {
    const r = await evaluateReadiness({
      ...base,
      timeoutMs: 50,
      checks: { slow: () => new Promise(() => {}) },
    });
    expect(r.checks.slow).toEqual({ status: 'fail', detail: 'timeout' });
  });
});
