import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import physical from '../eslint-rules/no-physical-direction.js';
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

describe('no-physical-direction', () => {
  it('flags left/right utilities and accepts logical ones', () => {
    new RuleTester().run('no-physical-direction', physical, {
      valid: [
        "const c = 'ms-3 pe-2 start-0 border-e rounded-s-md text-start';",
        "const c = 'mx-auto px-4 flex-1 leading-tight';",
        "const c = 'focus:start-2 hover:me-1';",
        "const label = 'Turn left at the right time';",
      ],
      invalid: [
        { code: "const c = 'flex ml-4';", errors: [{ messageId: 'physical' }] },
        { code: "const c = 'pr-2';", errors: [{ messageId: 'physical' }] },
        { code: "const c = 'absolute left-0';", errors: [{ messageId: 'physical' }] },
        { code: "const c = 'md:text-right';", errors: [{ messageId: 'physical' }] },
        { code: "const c = 'border-l rounded-r-lg';", errors: [{ messageId: 'physical' }] },
        { code: "const c = '-mr-1';", errors: [{ messageId: 'physical' }] },
        { code: 'const c = `p-2 ${x} float-left`;', errors: [{ messageId: 'physical' }] },
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
