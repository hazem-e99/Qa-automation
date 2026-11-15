/**
 * Work item rich text (HTML) to Markdown (doc 14 §3: "HTML→MD"). Deliberately small: block
 * structure, lists, emphasis, links and line breaks are kept; every other tag is dropped with its
 * attributes, scripts and styles with their content. The output is text, never HTML.
 */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return '';
  let s = html.slice(0, 1_000_000);
  s = s.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Links: keep http(s) targets only.
  s = s.replace(
    /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, _q, href: string, inner: string) => {
      const text = inner.replace(/<[^>]*>/g, '').trim();
      const target = decode(href).trim();
      return /^https?:\/\//i.test(target) && text ? `[${text}](${target})` : text;
    },
  );
  s = s.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (_m, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${inner}\n\n`,
  );
  s = s.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) =>
    inner.trim() ? `**${inner.trim()}**` : '',
  );
  s = s.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) =>
    inner.trim() ? `_${inner.trim()}_` : '',
  );
  // Lists: number items of ordered lists, bullet the rest.
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol\s*>/gi, (_m, inner: string) => {
    let n = 0;
    return `\n${inner.replace(/<li\b[^>]*>/gi, () => `\n${++n}. `)}\n`;
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/li\s*>/gi, '');
  s = s.replace(/<\/(p|div|ul|ol|tr|table|blockquote|pre)\s*>/gi, '\n');
  s = s.replace(/<(p|div|tr|table|blockquote|pre)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/t[dh]\s*>/gi, ' | ');
  s = s.replace(/<[^>]*>/g, '');
  s = decode(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
