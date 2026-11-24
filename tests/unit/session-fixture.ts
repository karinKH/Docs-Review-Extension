import { fixture } from './helpers';
import { createDocContext } from '../../src/core/anchor/context';
import { createAnchor } from '../../src/core/anchor/anchor';
import { scopeLadder } from '../../src/core/anchor/scope';
import { addAnnotation, createSession, setDirectives, type NewAnnotation } from '../../src/core/session';
import type { Session } from '../../src/core/types';

export function sampleSession(): Session {
  const src = fixture('sample.md');
  const ctx = createDocContext(src);
  let s = createSession({ docKey: 'file:///repo/docs/launch.md', title: 'launch.md', filePath: 'docs/launch.md', source: src, now: 0 });
  s = setDirectives(s, ['Use a confident, executive tone.', 'Keep the whole document under 800 words.'], 0);
  const at = (q: string, nth = 0) => {
    let i = -1;
    for (let k = 0; k <= nth; k++) i = src.indexOf(q, i + 1);
    return [i, i + q.length] as const;
  };
  const add = (range: readonly [number, number], scope: Parameters<typeof createAnchor>[3], rest: Omit<NewAnnotation, 'anchor'>) => {
    const anchor = createAnchor(ctx, range[0], range[1], scope, src.slice(range[0], range[1]));
    s = addAnnotation(s, { anchor, ...rest }, 0).session;
  };
  add(at('500 weekly active teams'), 'selection', { intent: 'rewrite', priority: 'must', mode: 'instruction', body: 'Say 750 and explain why the target went up.', replacement: '' });
  add(at('We want to keep support tickets low.', 1), 'sentence', { intent: 'delete', priority: 'suggestion', mode: 'instruction', body: '', replacement: '' });
  add(at('It is a draft and will change.'), 'sentence', { intent: 'rewrite', priority: 'nit', mode: 'replace', body: 'Drop the hedge.', replacement: 'It is final.' });
  const sec = scopeLadder(ctx, src.indexOf('Escaped'), src.indexOf('Escaped') + 1).find((r) => r.label === 'Section: Risks')!;
  add([sec.start, sec.end], 'section', { intent: 'expand', priority: 'must', mode: 'instruction', body: 'Add two real risks with owners. Merge with #2 if it helps.', replacement: '' });
  add(at('יש בה שני משפטים'), 'selection', { intent: 'question', priority: 'suggestion', mode: 'instruction', body: 'האם זה נכון?', replacement: '' });
  add(at('return `Hello, ${name}`;'), 'selection', { intent: 'format', priority: 'nit', mode: 'replace', body: '', replacement: "return 'Hello, ' + name;" });
  return s;
}
