import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertPasswordAcceptable, normalizeEmail } from './password.js';
import {
  ALL_PERMISSION_KEYS,
  allGrants,
  grantFor,
  ORG_PERMISSIONS,
  PROJECT_MATRIX_ROLES,
  renderProjectMatrix,
  ROLES,
} from './rbac.js';

const DOC = new URL('../../../../../docs/planning/modules/M13-team-permissions.md', import.meta.url);
const norm = (line: string) =>
  line
    .split('|')
    .map((c) => c.trim())
    .join('|');

describe('permission matrix (M13-AC-06)', () => {
  const doc = readFileSync(DOC, 'utf8');

  it('the documented project matrix is exactly what the catalog renders', () => {
    const start = doc.indexOf('| Permission | qa_lead |');
    expect(start).toBeGreaterThan(0);
    const lines = doc.slice(start).split(/\r?\n/);
    const header = norm(lines[0]!);
    expect(header).toBe(norm(`| Permission | ${PROJECT_MATRIX_ROLES.join(' | ')} |`));
    const documented = [];
    for (const line of lines.slice(2)) {
      if (!line.startsWith('|')) break;
      documented.push(norm(line));
    }
    expect(documented).toEqual(renderProjectMatrix().map(norm));
  });

  it('the documented org-scope list names every org permission and its roles', () => {
    for (const [permission, roles] of Object.entries(ORG_PERMISSIONS)) {
      const line = doc.split(/\r?\n/).find((l) => l.startsWith('- ') && l.includes(`\`${permission}\``));
      expect(line, permission).toBeDefined();
      for (const role of roles) expect(line, `${permission} → ${role}`).toContain(role);
    }
  });
});

describe('catalog', () => {
  it('denies by default and grants exactly what the matrix says', () => {
    expect(grantFor('viewer', 'project.read')).toBe('granted');
    expect(grantFor('viewer', 'testcase.create')).toBeNull();
    expect(grantFor('qa_engineer', 'run.cancel')).toBe('own');
    expect(grantFor('developer', 'testcase.create')).toBe('policy');
    expect(grantFor('qa_engineer', 'finding.resolve')).toBe('granted');
    expect(grantFor('qa_engineer', 'finding.waive')).toBeNull();
    expect(grantFor('qa_engineer', 'report.create')).toBe('granted');
    expect(grantFor('qa_engineer', 'report.schedule')).toBeNull();
    expect(grantFor('qc_reviewer', 'report.export')).toBe('granted');
    expect(grantFor('viewer', 'report.export')).toBe('policy');
    expect(grantFor('qa_lead', 'made.up.permission')).toBeNull();
  });

  it('org_admin administers projects but does not get test work by default (BR-M13-2)', () => {
    expect(grantFor('org_admin', 'project.settings.manage')).toBe('granted');
    expect(grantFor('org_admin', 'project.bindings.manage')).toBe('granted');
    expect(grantFor('org_admin', 'execution.run')).toBeNull();
    expect(grantFor('org_admin', 'testcase.approve')).toBeNull();
    expect(grantFor('qa_lead', 'project.bindings.manage')).toBeNull();
    expect(grantFor('qa_lead', 'user.manage')).toBeNull();
    expect(grantFor('org_admin', 'system.settings')).toBeNull();
    expect(grantFor('platform_admin', 'system.settings')).toBe('granted');
  });

  it('has unique permission keys and seeds only known roles', () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSION_KEYS.length);
    expect(ALL_PERMISSION_KEYS.length).toBeGreaterThan(40);
    for (const g of allGrants()) expect(Object.keys(ROLES)).toContain(g.role);
  });
});

describe('password and email rules', () => {
  it('accepts long passphrases and rejects short, repeated, common or email-based ones', () => {
    expect(() => assertPasswordAcceptable('correct horse battery')).not.toThrow();
    expect(() => assertPasswordAcceptable('كلمة مرور طويلة جدا')).not.toThrow();
    expect(() => assertPasswordAcceptable('short')).toThrow('password.too_short');
    expect(() => assertPasswordAcceptable('aaaaaaaaaaaaaaaa')).toThrow('password.too_common');
    expect(() => assertPasswordAcceptable('Password1234')).toThrow('password.too_common');
    expect(() => assertPasswordAcceptable('someone@example.com', ['someone@example.com'])).toThrow(
      'password.too_common',
    );
    expect(() => assertPasswordAcceptable('x'.repeat(300))).toThrow('password.too_long');
  });

  it('normalizes emails and rejects malformed ones', () => {
    expect(normalizeEmail('  Admin@Example.COM ')).toBe('admin@example.com');
    for (const bad of ['', 'no-at', 'a@b', 'a b@c.de', '@c.de']) {
      expect(() => normalizeEmail(bad), bad).toThrow('email.invalid');
    }
  });
});
