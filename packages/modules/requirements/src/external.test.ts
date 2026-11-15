import { describe, expect, it } from 'vitest';
import { contentFromItem, splitCriteria } from './external.js';

describe('external items as requirement content (T-P3-10)', () => {
  it('splits acceptance criteria into one criterion per list item or line', () => {
    expect(
      splitCriteria(
        '1. Given an open invoice\n2) A declined card fails\n\n- Bullet one\n* Bullet two\nPlain line',
      ),
    ).toEqual(['Given an open invoice', 'A declined card fails', 'Bullet one', 'Bullet two', 'Plain line']);
    expect(splitCriteria(null)).toEqual([]);
    expect(splitCriteria('-')).toEqual([]);
  });

  it('prefixes the title with the work item id and keeps tags within limits', () => {
    const c = contentFromItem('1203', {
      title: '  Pay invoice by card ',
      descriptionMarkdown: 'Body',
      acceptanceCriteriaMarkdown: '1. First',
      tags: ['payments', 'x'.repeat(60)],
    });
    expect(c).toMatchObject({
      title: '1203: Pay invoice by card',
      bodyMd: 'Body',
      acceptanceCriteria: [{ text: 'First', origin: 'source' }],
    });
    expect(c.tags.map((t) => t.length)).toEqual([8, 40]);
    expect(contentFromItem('7', {}).title).toBe('7: Work item 7');
  });
});
