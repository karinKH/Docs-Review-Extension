import { describe, expect, test } from 'vitest';
import { renderToDom, fixture } from './helpers';
import { headingPathAt } from '../../src/core/markdown/pipeline';

const src = fixture('sample.md');

describe('markdown pipeline', () => {
  const r = renderToDom(src);

  test('plain text spans carry exact source offsets', () => {
    const spans = Array.from(r.root.querySelectorAll('span[data-sp]')).filter(
      (s) => s.childNodes.length === 1 && s.firstChild!.nodeType === 3 && !s.closest('[data-atomic]'),
    );
    expect(spans.length).toBeGreaterThan(30);
    let exact = 0;
    for (const s of spans) {
      const [a, b] = s.getAttribute('data-sp')!.split(':').map(Number) as [number, number];
      if (src.slice(a, b) === s.textContent) exact++;
    }
    // Most spans match byte for byte; the rest contain escapes, entities or trimmed line breaks.
    expect(exact / spans.length).toBeGreaterThan(0.85);
  });

  test('builds an outline with section ranges', () => {
    expect(r.outline.map((o) => [o.depth, o.text])).toEqual([
      [1, 'Launch plan'],
      [2, 'Goals'],
      [2, 'Timeline'],
      [3, 'Risks'],
      [2, 'סיכום בעברית'],
    ]);
    const timeline = r.outline[2]!;
    expect(src.slice(timeline.start, timeline.sectionEnd)).toContain('### Risks');
    expect(src.slice(timeline.start, timeline.sectionEnd)).not.toContain('סיכום');
  });

  test('heading path at an offset', () => {
    const at = src.indexOf('Escaped');
    expect(headingPathAt(r.outline, at).map((h) => h.text)).toEqual(['Launch plan', 'Timeline', 'Risks']);
    expect(headingPathAt(r.outline, 0)).toEqual([]);
  });

  test('sanitises raw HTML', () => {
    expect(r.html).not.toContain('<script');
    expect(r.html).not.toContain('onclick');
    expect(r.html).toContain('<b');
  });

  test('blocks remote images until allowed', () => {
    expect(r.remoteImages).toEqual(['https://example.com/a.png']);
    const img = r.root.querySelector('img')!;
    expect(img.getAttribute('src')).toBeNull();
    expect(img.getAttribute('data-remote-src')).toBe('https://example.com/a.png');
  });

  test('links open safely in a new tab', () => {
    const a = r.root.querySelector('a[href^="https://example.com/docs"]')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('heading ids, callouts, math, right-to-left', () => {
    expect(r.root.querySelector('#h-goals')).not.toBeNull();
    expect(r.root.querySelector('.callout-warning .callout-title')?.textContent).toBe('Warning');
    expect(r.root.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
    const hebrew = Array.from(r.root.querySelectorAll('p')).find((p) => p.textContent?.includes('זהו'))!;
    expect(hebrew.getAttribute('dir')).toBe('rtl');
    const english = Array.from(r.root.querySelectorAll('p')).find((p) => p.textContent?.includes('This plan covers'))!;
    expect(english.getAttribute('dir')).toBe('ltr');
  });

  test('direction follows the majority of letters, not the first one', () => {
    const x = renderToDom('Claude Code עוזר לכתוב מסמכים ארוכים בעברית.\n');
    expect(x.root.querySelector('p')!.getAttribute('dir')).toBe('rtl');
  });

  test('javascript: links are removed', () => {
    const x = renderToDom('[bad](javascript:alert(1)) <a href="javascript:alert(2)">x</a>');
    expect(x.html).not.toContain('javascript:');
  });
});
