import { describe, expect, test } from 'vitest';
import { fixture } from './helpers';
import { createDocContext } from '../../src/core/anchor/context';
import { createAnchor, countOccurrences, trimRange } from '../../src/core/anchor/anchor';
import { expandScope, scopeLadder } from '../../src/core/anchor/scope';

const src = fixture('sample.md');
const ctx = createDocContext(src);

describe('anchors', () => {
  test('captures quote, context, lines, heading path and block', () => {
    const s = src.indexOf('500 weekly active teams');
    const a = createAnchor(ctx, s, s + '500 weekly active teams'.length, 'selection', '500 weekly active teams');
    expect(a.exact).toBe('500 weekly active teams');
    expect(a.prefix.endsWith('We want to reach ')).toBe(true);
    expect(a.prefix.length).toBeLessThanOrEqual(48);
    expect(src[a.start - a.prefix.length - 1]).toMatch(/\s/);
    expect(a.suffix.startsWith(' by the end')).toBe(true);
    expect(a.startLine).toBe(src.slice(0, s).split('\n').length);
    expect(a.endLine).toBe(a.startLine);
    expect(a.headingPath).toEqual(['Launch plan', 'Goals']);
    expect(a.blockKind).toBe('paragraph');
    expect(a.blockOrdinal).toBe(1);
  });

  test('trims whitespace at the edges', () => {
    const s = src.indexOf(' 500 weekly');
    expect(trimRange(src, s, s + 5)).toEqual({ start: s + 1, end: s + 4 });
  });

  test('repeated text is detected', () => {
    expect(countOccurrences(src, 'We want to keep support tickets low.')).toBe(2);
  });

  test('right-to-left text anchors like any other', () => {
    const q = 'יש בה שני משפטים';
    const s = src.indexOf(q);
    const a = createAnchor(ctx, s, s + q.length, 'selection', q);
    expect(a.exact).toBe(q);
    expect(a.headingPath).toEqual(['Launch plan', 'סיכום בעברית']);
  });
});

describe('scope stepping', () => {
  test('word -> sentence -> paragraph -> section -> parent section -> document', () => {
    const s = src.indexOf('weekly') + 2;
    let r = expandScope(ctx, s, s)!;
    expect(src.slice(r.start, r.end)).toBe('weekly');
    expect(r.scope).toBe('word');
    r = expandScope(ctx, r.start, r.end)!;
    expect(src.slice(r.start, r.end)).toBe('We want to reach 500 weekly active teams by the end of the quarter.');
    expect(r.scope).toBe('sentence');
    r = expandScope(ctx, r.start, r.end)!;
    expect(r.label).toBe('Paragraph');
    r = expandScope(ctx, r.start, r.end)!;
    expect(r.label).toBe('Section: Goals');
    r = expandScope(ctx, r.start, r.end)!;
    expect(r.label).toBe('Section: Launch plan');
    r = expandScope(ctx, r.start, r.end)!;
    expect(r.scope).toBe('document');
    expect(expandScope(ctx, r.start, r.end)).toBeNull();
  });

  test('list item -> list', () => {
    const s = src.indexOf('prompt compiler');
    const ladder = scopeLadder(ctx, s, s + 6).map((r) => r.label);
    expect(ladder.indexOf('List item')).toBeLessThan(ladder.indexOf('List'));
  });

  test('table cell -> row -> table', () => {
    const s = src.indexOf('July 20');
    const labels = scopeLadder(ctx, s, s + 7).map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(['Table cell', 'Table row', 'Table']));
    expect(labels.indexOf('Table cell')).toBeLessThan(labels.indexOf('Table row'));
    expect(labels.indexOf('Table row')).toBeLessThan(labels.indexOf('Table'));
  });

  test('Hebrew sentences split correctly', () => {
    const s = src.indexOf('זהו');
    const r = scopeLadder(ctx, s, s + 1).find((x) => x.scope === 'sentence')!;
    expect(src.slice(r.start, r.end)).toBe('זהו פסקה בעברית.');
  });
});
