import { describe, expect, test } from 'vitest';
import { preflight } from '../../src/core/preflight';
import { addAnnotation, deleteAnnotation, updateAnnotation } from '../../src/core/session';
import { sampleSession } from './session-fixture';

describe('pre-flight checks', () => {
  test('a clean session has no errors', () => {
    expect(preflight(sampleSession()).filter((i) => i.level === 'error')).toEqual([]);
  });

  test('flags empty instructions, no-op replacements, broken references, conflicts, moves', () => {
    let s = sampleSession();
    const [a1, a2, a3, a4] = s.annotations;
    s = updateAnnotation(s, a1!.id, { body: '  ' }, 0);
    s = updateAnnotation(s, a3!.id, { replacement: a3!.anchor.exact }, 0);
    s = deleteAnnotation(s, a2!.id, 0); // #4 refers to #2
    const anchor = { ...a4!.anchor };
    s = addAnnotation(s, { anchor, intent: 'delete', priority: 'must', mode: 'instruction', body: '', replacement: '' }, 0).session;
    s = addAnnotation(s, { anchor: a1!.anchor, intent: 'move', priority: 'nit', mode: 'instruction', body: 'somewhere better', replacement: '' }, 0).session;
    const codes = preflight(s).map((i) => `${i.code}:${i.numbers.join(',')}`);
    expect(codes).toContain('empty-instruction:1');
    expect(codes).toContain('no-op-replacement:3');
    expect(codes).toContain('broken-reference:4,2');
    expect(codes).toContain('conflict:4,7');
    expect(codes).toContain('move-target:8');
  });
});
