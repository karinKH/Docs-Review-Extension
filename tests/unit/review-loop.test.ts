import { describe, expect, test } from 'vitest';
import { createDocContext } from '../../src/core/anchor/context';
import { createAnchor } from '../../src/core/anchor/anchor';
import { isAnchored, relocateAll } from '../../src/core/anchor/relocate';
import { diffSegments, hunksOf, mapRange } from '../../src/core/text/diff';
import { similarity } from '../../src/core/text/similarity';
import { changesBetween, confirmMatch, describeRound, startRound } from '../../src/core/rounds';
import { applyReply, parseReply } from '../../src/core/reply';
import { planReplacements, unifiedPatch } from '../../src/core/apply';
import { parseReviewFile, ReviewFileError, toReviewFile, toWebAnnotations } from '../../src/core/review-file';
import { addAnnotation, createSession, migrateSession, setStatus } from '../../src/core/session';
import { compile, DEFAULT_OPTIONS } from '../../src/core/compile/compile';
import { sampleSession } from './session-fixture';

describe('word diff and offset mapping', () => {
  test('maps a range across insertions before it and a rewrite inside it', () => {
    const a = 'Intro. The quick brown fox jumps. End.';
    const b = 'New first line. Intro. The slow red fox jumps. End.';
    const segs = diffSegments(a, b)!;
    const s = a.indexOf('quick');
    const e = a.indexOf(' fox') ;
    const r = mapRange(segs, s, e);
    expect(b.slice(r.start, r.end)).toBe('slow red');
    const whole = mapRange(segs, a.indexOf('The'), a.indexOf(' End'));
    expect(b.slice(whole.start, whole.end)).toBe('The slow red fox jumps.');
  });

  test('text inserted right after a range stays outside it', () => {
    const a = 'alpha beta gamma';
    const b = 'alpha beta NEW gamma';
    const r = mapRange(diffSegments(a, b)!, 6, 10);
    expect(b.slice(r.start, r.end)).toBe('beta');
  });

  test('a deleted range maps to an empty point', () => {
    const a = 'keep this. remove this sentence. keep that.';
    const b = 'keep this. keep that.';
    const s = a.indexOf('remove');
    const r = mapRange(diffSegments(a, b)!, s, s + 'remove this sentence.'.length);
    expect(r.end - r.start).toBe(0);
  });

  test('hunks merge a deletion with its replacement', () => {
    const h = hunksOf(diffSegments('one two three', 'one 2 three')!);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ oldStart: 4, oldEnd: 7, newStart: 4, newEnd: 5 });
  });
});

describe('similarity', () => {
  test('is 1 for the same text, 0 for unrelated, symmetric, and works for Hebrew', () => {
    expect(similarity('Hello world', 'hello   world')).toBe(1);
    expect(similarity('abc', 'xyz')).toBe(0);
    expect(similarity('the launch is in June', 'the launch is in July')).toBeGreaterThan(0.7);
    expect(similarity('a b c d', 'd c b a')).toBe(similarity('d c b a', 'a b c d'));
    expect(similarity('השקה רשמית ביוני', 'השקה רשמית ביולי')).toBeGreaterThan(0.6);
  });
});

describe('relocation after an AI round (fuzzy)', () => {
  test('rewritten passage with intact surroundings is "changed", not lost', () => {
    const s = sampleSession();
    const edited = s.source.replace('500 weekly active teams', '750 weekly active teams, because pilots converted');
    const r = relocateAll(createDocContext(edited), s.annotations, s.source, 2);
    const one = r.annotations.find((a) => a.number === 1)!;
    expect(one.match?.state).toBe('changed');
    expect(one.match?.previousExact).toBe('500 weekly active teams');
    expect(one.anchor.exact).toContain('750 weekly active teams');
    expect(r.changed).toEqual([1]);
    for (const a of r.annotations.filter((x) => x.number !== 1)) {
      expect(['unchanged', 'moved']).toContain(a.match?.state);
      expect(a.anchor.exact).toBe(s.annotations.find((x) => x.number === a.number)!.anchor.exact);
    }
  });

  test('a fully rewritten sentence is still found by its context', () => {
    const src = '# Plan\n\nFirst paragraph stays.\n\nHere is a sentence that is far too long and repeats itself again and again. Then it ends.\n\nLast paragraph stays.\n';
    const ctx = createDocContext(src);
    const q = 'far too long and repeats itself again and again';
    const i = src.indexOf(q);
    let s = createSession({ docKey: 'k', title: 't', filePath: 'p', source: src, now: 0 });
    s = addAnnotation(s, { anchor: createAnchor(ctx, i, i + q.length, 'selection', q), intent: 'shorten', priority: 'must', mode: 'instruction', body: 'Shorter', replacement: '' }, 0).session;
    const edited = src.replace(q, 'short');
    const r = relocateAll(createDocContext(edited), s.annotations, src, 2);
    expect(r.annotations[0]!.match?.state).toBe('changed');
    expect(r.annotations[0]!.anchor.exact).toBe('short');
  });

  test('a deleted sentence is lost; never silently placed on the wrong text', () => {
    const s = sampleSession();
    const target = s.annotations.find((a) => a.number === 2)!;
    const edited = s.source.slice(0, target.anchor.start) + s.source.slice(target.anchor.end);
    const r = relocateAll(createDocContext(edited), s.annotations, s.source, 2);
    const two = r.annotations.find((a) => a.number === 2)!;
    expect(two.match?.state).toBe('lost');
    // The identical sentence earlier in the document must not inherit the comment.
    expect(two.anchor.start).not.toBe(edited.indexOf('We want to keep support tickets low.'));
    if (two.match?.state === 'lost') expect(isAnchored(edited, two)).toBe(false);
  });

  test('randomised edits elsewhere never move a comment onto different text', () => {
    const s = sampleSession();
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const words = ['alpha', 'beta', 'gamma', 'delta', 'שלום', 'עולם'];
    for (let round = 0; round < 40; round++) {
      // Insert random words at random places outside every commented range.
      let text = s.source;
      const ranges = s.annotations.map((a) => [a.anchor.start, a.anchor.end] as const);
      const spots: number[] = [];
      for (let k = 0; k < 5; k++) {
        const at = Math.floor(rand() * text.length);
        if (ranges.some(([a, b]) => at > a && at < b)) continue;
        spots.push(at);
      }
      for (const at of spots.sort((x, y) => y - x)) text = text.slice(0, at) + ` ${words[Math.floor(rand() * words.length)]} ` + text.slice(at);
      const r = relocateAll(createDocContext(text), s.annotations, s.source, 2);
      for (const a of r.annotations) {
        const orig = s.annotations.find((x) => x.number === a.number)!;
        if (a.match?.state === 'unchanged' || a.match?.state === 'moved') expect(a.anchor.exact).toBe(orig.anchor.exact);
        else if (a.match?.state === 'changed' || a.match?.state === 'uncertain') expect(similarity(a.anchor.exact, orig.anchor.exact)).toBeGreaterThan(0.3);
        expect(isAnchored(text, a) || a.match?.state === 'lost').toBe(true);
      }
    }
  });

  test('whole-section comments keep covering the whole section after it grows', () => {
    const s = sampleSession();
    const four = s.annotations.find((a) => a.number === 4)!;
    const edited = s.source.replace('## Risks\n', '## Risks\n\nA brand new opening paragraph for the risks section.\n');
    const r = relocateAll(createDocContext(edited), s.annotations, s.source, 2);
    const moved = r.annotations.find((a) => a.number === 4)!;
    expect(moved.anchor.exact.startsWith('### Risks')).toBe(true);
    expect(moved.anchor.exact).toContain('A brand new opening paragraph');
    expect(moved.anchor.exact.length).toBeGreaterThan(four.anchor.exact.length);
  });
});

describe('rounds', () => {
  test('a new version becomes round 2, with a report and the scope guard', () => {
    const s = sampleSession();
    const edited = s.source.replace('500 weekly active teams', '750 weekly active teams').replace('# Launch plan', '# Launch plan (v2)');
    const { session, report } = startRound(s, edited, createDocContext(edited), 1000);
    expect(session.rounds.map((r) => r.number)).toEqual([1, 2]);
    expect(session.source).toBe(edited);
    expect(report.changed).toEqual([1]);
    expect(report.unrequested).toBe(1); // the title change nobody asked for
    expect(report.hunks.filter((h) => !h.unrequested)).toHaveLength(1);
    expect(describeRound(report)).toMatch(/Round 2.*1 changed \(#1\).*1 change outside your comments/);
  });

  test('a comment asking for a deletion that disappeared counts as deleted as asked', () => {
    const s = sampleSession();
    const two = s.annotations.find((a) => a.number === 2)!;
    const edited = s.source.slice(0, two.anchor.start) + s.source.slice(two.anchor.end);
    const { report } = startRound(s, edited, createDocContext(edited));
    expect(report.lost).toEqual([2]);
    expect(report.deletedAsAsked).toEqual([2]);
    expect(describeRound(report)).toContain('1 deleted as asked');
  });

  test('changes inside resolved comments count as unrequested', () => {
    let s = sampleSession();
    s = setStatus(s, s.annotations[0]!.id, 'resolved', 0);
    const edited = s.source.replace('500 weekly active teams', '900 weekly active teams');
    expect(changesBetween(s.source, edited, s.annotations).hunks.every((h) => h.unrequested)).toBe(true);
  });

  test('confirming an uncertain match keeps it; rejecting marks it lost', () => {
    const s = sampleSession();
    const a = s.annotations[0]!;
    const withMatch = { ...s, annotations: s.annotations.map((x) => (x.id === a.id ? { ...x, match: { state: 'uncertain' as const, confidence: 0.4, round: 2 } } : x)) };
    expect(confirmMatch(withMatch, a.id, true).annotations[0]!.match?.state).toBe('changed');
    expect(confirmMatch(withMatch, a.id, false).annotations[0]!.match?.state).toBe('lost');
  });

  test('old stored sessions gain a first round', () => {
    const s = sampleSession();
    const old = { ...s, schema: 'review-pen/session@1', rounds: undefined } as unknown;
    const m = migrateSession(old);
    expect(m.schema).toBe('review-pen/session@2');
    expect(m.rounds).toHaveLength(1);
    expect(m.rounds[0]!.source).toBe(s.source);
  });
});

describe('AI reply checklist', () => {
  test('reads common formats and applies them', () => {
    const reply = 'Here you go.\n\n- #1 done\n**#2** skipped: the sentence was already gone\n#5 answer: כן, זה נכון\n#9 done\n* #3 — Done.';
    const lines = parseReply(reply);
    expect(lines.map((l) => [l.number, l.kind])).toEqual([[1, 'done'], [2, 'skipped'], [3, 'done'], [5, 'answer'], [9, 'done']]);
    const s = sampleSession();
    const r = applyReply(s, lines, 5);
    expect(r.applied).toEqual([1, 2, 3, 5]);
    expect(r.unknown).toEqual([9]);
    expect(r.missing).toEqual([4, 6]);
    const by = (n: number) => r.session.annotations.find((a) => a.number === n)!;
    expect(by(1).status).toBe('open');
    expect(by(1).aiReply).toBe('done');
    expect(by(2).status).toBe('retry');
    expect(by(5).status).toBe('resolved');
    expect(by(5).aiReply).toBe('answer: כן, זה נכון');
  });

  test('retry items are marked as second attempts in the prompt', () => {
    let s = sampleSession();
    s = applyReply(s, parseReply('#2 skipped: not sure which one')).session;
    const text = compile(s, { ...DEFAULT_OPTIONS, statuses: ['retry'] }).parts[0]!.text;
    expect(text).toContain('### #2');
    expect(text).toContain('Second attempt');
    expect(text).toContain('not sure which one');
    expect(text).not.toContain('### #1 ');
  });
});

describe('applying exact replacements without AI', () => {
  test('applies non-overlapping replacements and reports the rest', () => {
    const s = sampleSession();
    const plan = planReplacements(s);
    expect(plan.applied).toEqual([3, 6]);
    expect(plan.text).toContain('It is final.');
    expect(plan.text).toContain("return 'Hello, ' + name;");
    expect(plan.text).not.toContain('It is a draft and will change.');
    const patch = unifiedPatch('docs/launch.md', s.source, plan.text);
    expect(patch).toContain('--- a/docs/launch.md');
    expect(patch.split('\n').some((l) => l.startsWith('+') && l.includes('It is final.'))).toBe(true);
  });
});

describe('review files', () => {
  test('round-trips a session', () => {
    const s = sampleSession();
    const back = parseReviewFile(toReviewFile(s));
    expect(back.annotations).toEqual(s.annotations);
    expect(back.source).toBe(s.source);
    expect(back.rounds).toHaveLength(1);
  });

  test('rejects files that are not review files, or have bad fields', () => {
    expect(() => parseReviewFile('not json')).toThrow(ReviewFileError);
    expect(() => parseReviewFile('{"format":"other"}')).toThrow(/not a Review Pen review file/);
    const s = sampleSession();
    const bad = JSON.parse(toReviewFile(s));
    bad.session.annotations[0].intent = 'hack';
    expect(() => parseReviewFile(JSON.stringify(bad))).toThrow(/unknown value/);
    const bad2 = JSON.parse(toReviewFile(s));
    bad2.session.annotations[0].anchor.end = -5;
    expect(() => parseReviewFile(JSON.stringify(bad2))).toThrow(ReviewFileError);
    const bad3 = JSON.parse(toReviewFile(s));
    bad3.session.annotations[1].number = 1;
    expect(() => parseReviewFile(JSON.stringify(bad3))).toThrow(/share a number/);
  });

  test('ignores unknown extra fields such as __proto__', () => {
    const s = sampleSession();
    const raw = JSON.parse(toReviewFile(s));
    raw.session.annotations[0].__proto__ = { polluted: true };
    raw.session.annotations[0].extra = '<script>';
    const back = parseReviewFile(JSON.stringify(raw));
    expect((back.annotations[0] as unknown as Record<string, unknown>).extra).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('exports W3C Web Annotations', () => {
    const w = JSON.parse(toWebAnnotations(sampleSession()));
    expect(w.type).toBe('AnnotationCollection');
    expect(w.first.items).toHaveLength(6);
    expect(w.first.items[0].target.selector[0]).toMatchObject({ type: 'TextQuoteSelector', exact: '500 weekly active teams' });
  });
});
