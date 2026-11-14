import { describe, expect, it } from 'vitest';
import {
  canTransition,
  cleanContent,
  contentHash,
  detectLanguage,
  diffSnapshots,
  normalizeForSearch,
  searchTextOf,
  similarity,
} from './domain.js';

describe('Arabic-aware search normalization (M04-AC-06)', () => {
  it('ignores diacritics, so "الدخول" matches "الدُّخول"', () => {
    expect(normalizeForSearch('الدُّخول')).toBe(normalizeForSearch('الدخول'));
    expect(normalizeForSearch('تسجيلُ الدُّخولِ إلى النظامِ')).toContain(normalizeForSearch('الدخول'));
  });

  it('unifies alef, ya, ta marbuta and hamza seats, removes tatweel, maps digits', () => {
    expect(normalizeForSearch('أحمد إلى آخر')).toBe('احمد الي اخر');
    expect(normalizeForSearch('مدرسة')).toBe('مدرسه');
    expect(normalizeForSearch('مسـؤول')).toBe('مسوول');
    expect(normalizeForSearch('رقم ٣٤٥ و ۶')).toBe('رقم 345 و 6');
  });

  it('handles Latin case and accents and collapses whitespace', () => {
    expect(normalizeForSearch('  Café   LOGIN\n')).toBe('cafe login');
  });

  it('detects the dominant language', () => {
    expect(detectLanguage('يجب أن يتمكن المستخدم')).toBe('ar');
    expect(detectLanguage('The user shall log in')).toBe('en');
    expect(detectLanguage('يجب أن يدعم النظام OAuth login flows')).toBe('mixed');
    expect(detectLanguage('12 34')).toBeNull();
  });
});

describe('requirement content', () => {
  const base = {
    title: '  Login   form ',
    bodyMd: 'Body\r\n',
    priority: 'high',
    tags: ['Auth', 'auth', ' '],
    acceptanceCriteria: [
      { text: ' AC 1 ', origin: 'source' as const },
      { text: ' ', origin: 'source' as const },
    ],
  };

  it('cleans whitespace, tags and empty criteria', () => {
    expect(cleanContent(base)).toEqual({
      title: 'Login form',
      bodyMd: 'Body',
      priority: 'high',
      tags: ['auth'],
      acceptanceCriteria: [{ text: 'AC 1', origin: 'source' }],
    });
    expect(() => cleanContent({ ...base, title: 'x' })).toThrow('requirement.title_invalid');
    expect(() => cleanContent({ ...base, priority: 'urgent' })).toThrow('requirement.priority_invalid');
  });

  it('hashes content so any change (including AC origin) gives a new hash, tag order does not', () => {
    const c = cleanContent(base);
    expect(contentHash(c)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash({ ...c, tags: ['b', 'a'] })).toBe(contentHash({ ...c, tags: ['a', 'b'] }));
    expect(contentHash({ ...c, acceptanceCriteria: [{ text: 'AC 1', origin: 'inferred' }] })).not.toBe(
      contentHash(c),
    );
    expect(searchTextOf({ ...c, title: 'تسجيلُ الدُّخول' })).toContain('الدخول');
  });

  it('allows only the documented workflow transitions', () => {
    expect(canTransition('draft', 'in_review')).toBe(true);
    expect(canTransition('in_review', 'approved')).toBe(true);
    expect(canTransition('approved', 'superseded')).toBe(true);
    expect(canTransition('approved', 'draft')).toBe(false);
    expect(canTransition('superseded', 'approved')).toBe(false);
    expect(canTransition('draft', 'approved')).toBe(false);
  });
});

describe('snapshot diffing (M04-FR-15)', () => {
  const item = (title: string, body = '', ac: string[] = [], externalKey?: string) => ({
    title,
    body,
    acceptanceCriteria: ac,
    externalKey: externalKey ?? null,
  });

  it('matches by key, then by title similarity, and classifies added / removed / changed', () => {
    const prev = [
      item('The user can log in with email', 'old', ['valid email works']),
      item('Password reset by email', 'x'),
      item('Export reports to PDF', 'x'),
      item('Keyed item', 'a', [], 'REQ-9'),
    ];
    const next = [
      item('The user can log in with email address', 'new', ['valid email works', 'locked after 5 failures']),
      item('Password reset by email', 'x'),
      item('Dark mode for the dashboard', 'x'),
      item('Keyed item renamed entirely', 'a', [], 'REQ-9'),
    ];
    const d = diffSnapshots(prev, next);
    expect(d.added.map((i) => i.title)).toEqual(['Dark mode for the dashboard']);
    expect(d.removed.map((i) => i.title)).toEqual(['Export reports to PDF']);
    expect(d.unchanged.map((i) => i.title)).toEqual(['Password reset by email']);
    const login = d.changed.find((c) => c.before.title.startsWith('The user'))!;
    expect(login.fields).toEqual(['title', 'body', 'acceptanceCriteria']);
    expect(login.ac).toEqual({ added: ['locked after 5 failures'], removed: [] });
    expect(d.changed.find((c) => c.before.externalKey === 'REQ-9')!.fields).toEqual(['title']);
  });

  it('treats diacritics-only edits as unchanged and works for Arabic titles', () => {
    const d = diffSnapshots([item('تسجيل الدخول إلى النظام')], [item('تسجيلُ الدُّخولِ إلى النظام')]);
    expect(d.unchanged).toHaveLength(1);
    expect(similarity('تسجيل الدخول', 'تسجيل الخروج')).toBeCloseTo(1 / 3);
  });
});
