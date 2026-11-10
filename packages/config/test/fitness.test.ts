import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import rule from '../eslint-rules/no-provider-literals.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe('no-provider-literals', () => {
  it('flags provider names and accepts neutral strings', () => {
    new RuleTester().run('no-provider-literals', rule, {
      valid: [
        "const kind = 'source_control';",
        "import x from '@qos/adapters-github';", // import paths are dependency-cruiser's job
        "const s = 'gitlabel';", // not a whole word
        'const t = `capability:${name}`;',
      ],
      invalid: [
        { code: "if (type === 'github') run();", errors: [{ messageId: 'provider' }] },
        { code: "const p = 'Azure Boards';", errors: [{ messageId: 'provider' }] },
        { code: 'const u = `https://api.${x}/n8n/hook`;', errors: [{ messageId: 'provider' }] },
        { code: "const m = { provider: 'gemini' };", errors: [{ messageId: 'provider' }] },
      ],
    });
  });
});

describe('dependency-cruiser rules', () => {
  const run = (cwd: string, outputType = 'json') =>
    spawnSync(
      process.execPath,
      [
        here('../../../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
        '--config',
        here('../dependency-cruiser.cjs'),
        '--output-type',
        outputType,
        'packages',
      ],
      { cwd, encoding: 'utf8' },
    );

  it('detects every violation in the failing fixture', () => {
    // The default reporter is the one CI uses: it must fail the build.
    expect(run(here('../fixtures/violations'), 'err').status).not.toBe(0);
    const res = run(here('../fixtures/violations'));
    const found = new Set(
      (JSON.parse(res.stdout).summary.violations as { rule: { name: string } }[]).map((v) => v.rule.name),
    );
    expect([...found].sort()).toEqual([
      'domain-is-framework-free',
      'modules-do-not-import-adapters',
      'no-circular',
      'no-cross-module-internals',
      'packages-do-not-import-apps',
    ]);
  });

  it('passes the clean fixture', () => {
    const res = run(here('../fixtures/clean'));
    expect(JSON.parse(res.stdout).summary.violations).toEqual([]);
    expect(run(here('../fixtures/clean'), 'err').status).toBe(0);
  });
});
