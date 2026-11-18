"""Sanitized layout HTML of a DOCX for the source viewer (T-P3-14, M04-FR-08 "DOCX HTML").

Allow-list only: structural tags (headings, paragraphs, lists, tables, emphasis) with the
``dir``, ``colspan`` and ``rowspan`` attributes. Everything else is dropped: scripts, styles,
images, links (their text stays), event handlers, URLs and comments. Text is re-escaped, so the
output contains no markup the input did not earn. The web app shows it in a sandboxed frame on top
of this (defense in depth).
"""
from __future__ import annotations

from html import escape
from html.parser import HTMLParser

ALLOWED = {
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "ul", "ol", "li", "table", "thead", "tbody",
    "tfoot", "tr", "th", "td", "caption", "b", "strong", "i", "em", "u", "sub", "sup", "blockquote",
    "pre", "code", "span", "div", "hr",
}
VOID = {"br", "hr"}
DROP_CONTENT = {"script", "style", "head", "title", "template", "noscript", "iframe", "object", "svg", "math"}
MAX_CHARS = 2_000_000


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.stack: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in DROP_CONTENT:
            self.skip += 1
            return
        if self.skip or tag not in ALLOWED:
            return
        kept = []
        for name, value in attrs:
            v = (value or "").strip().lower()
            if name == "dir" and v in ("rtl", "ltr", "auto"):
                kept.append(f' dir="{v}"')
            elif name in ("colspan", "rowspan") and v.isdigit() and 0 < int(v) <= 100:
                kept.append(f' {name}="{int(v)}"')
        self.out.append(f"<{tag}{''.join(kept)}>")
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag in self.stack and tag not in VOID and self.stack[-1] == tag:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in DROP_CONTENT:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip or tag not in ALLOWED or tag in VOID or tag not in self.stack:
            return
        # Close everything opened after it, so the output is always well nested.
        while self.stack:
            open_tag = self.stack.pop()
            self.out.append(f"</{open_tag}>")
            if open_tag == tag:
                break

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.out.append(escape(data, quote=False))

    def result(self) -> str:
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")
        return "".join(self.out).strip()


def sanitize_html(html: str) -> str:
    s = _Sanitizer()
    s.feed(html[:MAX_CHARS])
    s.close()
    return s.result()
