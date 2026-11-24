import { describe, expect, test } from 'vitest';
import { createDocContext } from '../../src/core/anchor/context';
import { isAnchored, relocateAll } from '../../src/core/anchor/relocate';
import { sampleSession } from './session-fixture';

describe('relocation after edits (exact matching)', () => {
  test('unchanged text keeps every anchor', () => {
    const s = sampleSession();
    const r = relocateAll(createDocContext(s.source), s.annotations);
    expect(r.lost).toEqual([]);
    expect(r.moved).toEqual([]);
  });

  test('text inserted above shifts anchors; deleted text is reported lost', () => {
    const s = sampleSession();
    const edited = s.source.replace('# Launch plan\n', '# Launch plan\n\nA new intro paragraph.\n').replace('יש בה שני משפטים', 'שונה לגמרי');
    const ctx = createDocContext(edited);
    const r = relocateAll(ctx, s.annotations);
    expect(r.lost).toEqual([5]);
    expect(r.moved.length).toBe(5);
    for (const a of r.annotations.filter((x) => x.number !== 5)) expect(isAnchored(edited, a)).toBe(true);
    const first = r.annotations.find((a) => a.number === 1)!;
    expect(first.anchor.startLine).toBe(s.annotations[0]!.anchor.startLine + 2);
  });

  test('repeated quote is disambiguated by its context', () => {
    const s = sampleSession();
    const edited = 'Intro line.\n' + s.source;
    const r = relocateAll(createDocContext(edited), s.annotations);
    const two = r.annotations.find((a) => a.number === 2)!;
    expect(edited.slice(two.anchor.start - 30, two.anchor.start)).toContain('The launch date is fixed.');
  });
});
