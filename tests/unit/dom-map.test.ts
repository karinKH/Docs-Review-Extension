import { describe, expect, test } from 'vitest';
import { renderToDom, fixture } from './helpers';
import { domPointToSource, SourceDomIndex } from '../../src/core/markdown/dom-map';

const src = fixture('sample.md');

function textNodes(root: Element): Text[] {
  const out: Text[] = [];
  const w = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
  return out;
}

describe('DOM <-> source mapping', () => {
  const r = renderToDom(src);

  test('every plain text character maps to the same source character', () => {
    let checked = 0;
    for (const t of textNodes(r.root)) {
      const el = t.parentElement!;
      if (el.closest('[data-atomic]') || el.closest('pre') || !el.hasAttribute('data-sp')) continue;
      const value = t.nodeValue!;
      for (let k = 0; k < value.length; k++) {
        const ch = value[k]!;
        if (/\s/.test(ch)) continue;
        const j = domPointToSource(r.ctx, r.root, t, k, 'start');
        expect(j, `char ${ch} in "${value}"`).not.toBeNull();
        expect(src[j!], `char ${k} of "${value}"`).toBe(ch);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  test('escapes and entities map past their syntax', () => {
    const t = textNodes(r.root).find((n) => n.nodeValue!.includes('Escaped'))!;
    const k = t.nodeValue!.indexOf('stars');
    const j = domPointToSource(r.ctx, r.root, t, k, 'start')!;
    expect(src.slice(j, j + 5)).toBe('stars');
    const amp = textNodes(r.root).find((n) => n.nodeValue!.includes('&'))!;
    const ja = domPointToSource(r.ctx, r.root, amp, amp.nodeValue!.indexOf('&'), 'start')!;
    expect(src.slice(ja, ja + 5)).toBe('&amp;');
  });

  test('code block characters map exactly, including indentation', () => {
    const pre = r.root.querySelector('pre[data-code] code.language-ts')!.parentElement!;
    const t = textNodes(pre)[0]!;
    const k = t.nodeValue!.indexOf('return');
    const j = domPointToSource(r.ctx, r.root, t, k, 'start')!;
    expect(src.slice(j, j + 6)).toBe('return');
    expect(r.ctx.lines.lineOf(j)).toBe(src.slice(0, src.indexOf('  return')).split('\n').length);
  });

  test('math maps to its whole source span', () => {
    const katex = r.root.querySelector('.math-wrap .katex')!;
    const inner = textNodes(katex)[0]!;
    const s = domPointToSource(r.ctx, r.root, inner, 0, 'start')!;
    const e = domPointToSource(r.ctx, r.root, inner, 0, 'end')!;
    expect(src.slice(s, e)).toBe('$E = mc^2$');
  });

  test('source ranges round-trip to DOM ranges', () => {
    const index = new SourceDomIndex(r.root, r.ctx);
    const cases = ['500 weekly active teams', 'Q3 launch', 'Ship the prompt compiler', 'יש בה שני משפטים', 'return `Hello, ${name}`;'];
    for (const c of cases) {
      const s = src.indexOf(c);
      const range = index.toRange(s, s + c.length)!;
      expect(range, c).not.toBeNull();
      expect(range.toString()).toBe(c);
    }
  });

  test('a range across inline formatting maps to the full source span', () => {
    const index = new SourceDomIndex(r.root, r.ctx);
    const s = src.indexOf('covers the **Q3');
    const e = src.indexOf('launch** of') + 'launch**'.length;
    const range = index.toRange(s, e)!;
    expect(range.toString()).toBe('covers the Q3 launch');
    const back = [
      domPointToSource(r.ctx, r.root, range.startContainer, range.startOffset, 'start'),
      domPointToSource(r.ctx, r.root, range.endContainer, range.endOffset, 'end'),
    ];
    expect(src.slice(back[0]!, back[1]!)).toBe('covers the **Q3 launch');
  });
});
