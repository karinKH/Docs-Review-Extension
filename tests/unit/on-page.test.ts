import { describe, expect, test } from 'vitest';
import {
  addAnnotation,
  adoptFirstSource,
  createSession,
  inDocumentOrder,
  mergeVisual,
  visualLocation,
  visualPlaceholderAnchor,
} from '../../src/core/session';
import type { Annotation, Session, VisualAnchor } from '../../src/core/types';
import { compile, DEFAULT_OPTIONS } from '../../src/core/compile/compile';
import { preflight } from '../../src/core/preflight';
import { isAnchored, relocateAll } from '../../src/core/anchor/relocate';
import { createDocContext } from '../../src/core/anchor/context';
import { parseReviewFile, toReviewFile } from '../../src/core/review-file';
import { planReplacements } from '../../src/core/apply';
import { cropArea, parsePageRequest, PAGE_MSG } from '../../src/core/google/page-protocol';
import { appFromPath, cleanCellRef, gidFromHash, slideIdFromHash } from '../../src/core/google/page-adapters';
import { googleUrlForKey } from '../../src/core/google/urls';
import { sampleSession } from './session-fixture';

const slideBox: VisualAnchor = { app: 'slides', relativeTo: 'slide', box: { x: 0.7, y: 0.05, w: 0.25, h: 0.2 }, slideId: 'g12_0_3', slideNumber: 4, imageId: 'img-1' };
const sheetPin: VisualAnchor = { app: 'sheet', relativeTo: 'viewport', box: { x: 0.4, y: 0.5, w: 0, h: 0 }, sheetName: 'Budget', cell: 'B7', nearText: '=SUM(B2:B6)', imageId: null };

function addVisual(s: Session, v: VisualAnchor, body: string, now = 1): { session: Session; annotation: Annotation } {
  const r = addAnnotation(s, { anchor: visualPlaceholderAnchor(v), intent: 'design', priority: 'must', mode: 'instruction', body, replacement: '' }, now);
  const a = { ...r.annotation, visual: v };
  return { annotation: a, session: { ...r.session, annotations: r.session.annotations.map((x) => (x.id === a.id ? a : x)) } };
}

describe('where a pin or box is, in words', () => {
  test('slides, sheets and docs', () => {
    expect(visualLocation(slideBox)).toBe('Slide 4, top right area (x 70–95%, y 5–25% of the slide)');
    expect(visualLocation(sheetPin)).toBe('Sheet "Budget", cell B7');
    expect(visualLocation({ app: 'doc', relativeTo: 'page', page: 2, box: { x: 0.5, y: 0.5, w: 0, h: 0 } })).toBe('Page 2, centre area (x 50%, y 50% of the page)');
    expect(visualLocation({ app: 'doc', relativeTo: 'viewport', box: { x: 0.1, y: 0.9, w: 0, h: 0 } })).toBe('Page (unknown), bottom left area (x 10%, y 90% of the visible screen, approximate)');
  });

  test('a link back to the slide or sheet tab', () => {
    const id = '1SlidesSlidesSlidesSlidesSlides0000';
    expect(googleUrlForKey(`google:slides:${id}`, slideBox)).toBe(`https://docs.google.com/presentation/d/${id}/edit#slide=id.g12_0_3`);
    expect(googleUrlForKey(`google:sheet:${id}`, { sheetGid: '42' })).toBe(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=42`);
    expect(googleUrlForKey('file:///x.md')).toBeNull();
    expect(googleUrlForKey(`google:slides:${id}`, { slideId: 'a"b' })).toBe(`https://docs.google.com/presentation/d/${id}/edit`);
  });
});

describe('pins and boxes in a review', () => {
  test('come after text comments, and text tools leave them alone', () => {
    let s = sampleSession();
    s = addVisual(s, slideBox, 'Logo overlaps the title.').session;
    const v = s.annotations[s.annotations.length - 1]!;
    expect(inDocumentOrder(s.annotations).at(-1)!.id).toBe(v.id);
    expect(isAnchored(s.source, v)).toBe(false);
    const res = relocateAll(createDocContext(s.source + '\n\nMore.'), s.annotations, s.source, 2);
    expect(res.annotations.find((a) => a.id === v.id)).toEqual(v);
    expect(res.lost).not.toContain(v.number);
    expect(preflight(s).filter((i) => i.numbers.includes(v.number))).toEqual([]);
    expect(planReplacements(s).applied).not.toContain(v.number);
  });

  test('an empty pin comment is flagged, nothing else', () => {
    const s = addVisual(createSession({ docKey: 'k', title: 't', filePath: 't', source: '' }), slideBox, '  ').session;
    expect(preflight(s).map((i) => i.code)).toEqual(['empty-instruction']);
  });

  test('the prompt names the place and the screenshot, with no quote', () => {
    let s = sampleSession();
    s = addVisual(s, slideBox, 'Logo overlaps the title.').session;
    s = addVisual(s, sheetPin, 'Make the total bold.').session;
    const agent = compile(s, DEFAULT_OPTIONS).parts[0]!.text;
    expect(agent).toContain('9. Items under "On the Google page" were placed on the page');
    expect(agent).toContain('### #7 · Design/Layout · Must fix');
    expect(agent).toContain('Location: Slide 4, top right area (x 70–95%, y 5–25% of the slide)');
    expect(agent).toContain('Screenshot: review-pen-comment-7.png (attached; the commented area is outlined).');
    expect(agent).toContain('Location: Sheet "Budget", cell B7 · cell shows: "=SUM(B2:B6)"');
    const seven = agent.slice(agent.indexOf('### #7'), agent.indexOf('### #8'));
    expect(seven).not.toContain('Original text');
    expect(agent.indexOf('### #7')).toBeGreaterThan(agent.indexOf('### #6'));

    const chat = compile(s, { ...DEFAULT_OPTIONS, preset: 'chat' }).parts[0]!.text;
    expect(chat).toContain('<comment id="7" intent="design" priority="must" type="on-page">');
    expect(chat).toContain('<screenshot>review-pen-comment-7.png</screenshot>');
    expect(chat).not.toMatch(/<comment id="7"[^]*?<original_text>[^]*?<\/comment>\n<comment id="8"/);

    const json = JSON.parse(compile(s, { ...DEFAULT_OPTIONS, preset: 'json' }).parts[0]!.text);
    const item = json.items.find((i: { number: number }) => i.number === 7);
    expect(item.target).toEqual({ type: 'VisualSelector', app: 'slides', relativeTo: 'slide', box: slideBox.box, slideId: 'g12_0_3', slideNumber: 4, page: null, sheet: null, cell: null, screenshot: 'review-pen-comment-7.png' });
  });

  test('a prompt without pins has no extra rule', () => {
    expect(compile(sampleSession(), DEFAULT_OPTIONS).parts[0]!.text).not.toContain('On the Google page');
  });

  test('survive a review file round trip; bad values are rejected or clamped', () => {
    const s = addVisual(createSession({ docKey: 'google:slides:x', title: 'Deck', filePath: 'Deck', source: '' }), slideBox, 'Move the logo.').session;
    const back = parseReviewFile(toReviewFile(s));
    expect(back.annotations[0]!.visual).toEqual({ ...slideBox, page: null, sheetGid: null, sheetName: null, cell: null, nearText: null });
    const raw = JSON.parse(toReviewFile(s));
    raw.session.annotations[0].visual.box.x = 7;
    expect(parseReviewFile(JSON.stringify(raw)).annotations[0]!.visual!.box.x).toBe(1);
    raw.session.annotations[0].visual.app = 'excel';
    expect(() => parseReviewFile(JSON.stringify(raw))).toThrow();
  });
});

describe('a review started on the Google page', () => {
  test('the first text copy becomes version 1, not a new round', () => {
    const s = addVisual(createSession({ docKey: 'k', title: 't', filePath: 't', source: '', now: 0 }), slideBox, 'x').session;
    const adopted = adoptFirstSource(s, '# Deck\n', 5)!;
    expect(adopted.source).toBe('# Deck\n');
    expect(adopted.rounds).toHaveLength(1);
    expect(adopted.rounds[0]!.source).toBe('# Deck\n');
    expect(adopted.annotations).toEqual(s.annotations);
    expect(adoptFirstSource(adopted, '# Changed\n')).toBeNull();
  });
});

describe('merging pins placed on the page into an open review', () => {
  const base = () => sampleSession();
  const textComment = (body: string) => {
    const a = base().annotations[0]!;
    return { anchor: a.anchor, intent: a.intent, priority: a.priority, mode: a.mode, body, replacement: '' };
  };

  test('saving keeps a pin placed meanwhile, and gives it a free number', () => {
    const open = addAnnotation(base(), textComment('text comment added in the review'), 2).session; // #7 text
    const stored = addVisual(base(), slideBox, 'pin from the page').session; // #7 visual
    const merged = mergeVisual(open, stored, new Set(), 'save');
    const nums = merged.annotations.map((a) => a.number);
    expect(new Set(nums).size).toBe(nums.length);
    expect(merged.annotations.find((a) => a.visual)!.number).toBe(8);
    expect(merged.nextNumber).toBe(9);
  });

  test('saving does not bring back a pin deleted in the review', () => {
    const stored = addVisual(base(), slideBox, 'pin').session;
    const pinId = stored.annotations.at(-1)!.id;
    const open = { ...stored, annotations: stored.annotations.filter((a) => a.id !== pinId) };
    expect(mergeVisual(open, stored, new Set([pinId]), 'save')).toBe(open);
  });

  test('sync takes the page side for pins, and keeps text comments from the review', () => {
    const withPin = addVisual(base(), slideBox, 'pin');
    const open = addAnnotation(withPin.session, textComment('new text comment'), 3).session;
    const stored = { ...withPin.session, annotations: withPin.session.annotations.map((a) => (a.visual ? { ...a, status: 'resolved' as const } : a)) };
    const merged = mergeVisual(open, stored, new Set([withPin.annotation.id]), 'sync');
    expect(merged.annotations.find((a) => a.visual)!.status).toBe('resolved');
    expect(merged.annotations.some((a) => a.body === 'new text comment')).toBe(true);
    const deleted = mergeVisual(open, { ...stored, annotations: stored.annotations.filter((a) => !a.visual) }, new Set(), 'sync');
    expect(deleted.annotations.some((a) => a.visual)).toBe(false);
  });
});

describe('messages from the page layer are checked', () => {
  const msg = (req: unknown) => ({ type: PAGE_MSG, req });
  test('valid requests pass', () => {
    expect(parsePageRequest(msg({ op: 'list' }))).toEqual({ op: 'list' });
    expect(parsePageRequest(msg({ op: 'add', visual: slideBox, body: 'Hi', intent: 'design', priority: 'must' }))).toMatchObject({ op: 'add', body: 'Hi' });
    expect(parsePageRequest(msg({ op: 'update', id: 'a', status: 'resolved' }))).toEqual({ op: 'update', id: 'a', status: 'resolved' });
  });
  test('anything else is refused', () => {
    expect(parsePageRequest({ type: 'other', req: { op: 'list' } })).toBeNull();
    expect(parsePageRequest(msg({ op: 'eval' }))).toBeNull();
    expect(parsePageRequest(msg({ op: 'add', visual: { ...slideBox, app: 'x' }, body: 'Hi', intent: 'design', priority: 'must' }))).toBeNull();
    expect(parsePageRequest(msg({ op: 'add', visual: slideBox, body: 'x'.repeat(20_001), intent: 'design', priority: 'must' }))).toBeNull();
    expect(parsePageRequest(msg({ op: 'update', id: 'a', status: 'gone' }))).toBeNull();
    expect(parsePageRequest(msg({ op: 'capture', rect: { x: 1, y: 1, w: 1, h: 1, viewportW: 0, viewportH: 10 } }))).toBeNull();
    // A docKey in the message is ignored: the background uses the tab's address.
    expect(parsePageRequest(msg({ op: 'list', docKey: 'google:doc:other' }))).toEqual({ op: 'list' });
  });
});

describe('screenshot crop', () => {
  test('a box gets a margin, a pin a fixed area, both kept on screen', () => {
    expect(cropArea({ x: 100, y: 100, w: 400, h: 300, viewportW: 1200, viewportH: 800 })).toEqual({ x: 68, y: 68, w: 464, h: 364 });
    expect(cropArea({ x: 10, y: 10, w: 0, h: 0, viewportW: 1200, viewportH: 800 })).toEqual({ x: 0, y: 0, w: 250, h: 170 });
    expect(cropArea({ x: 600, y: 400, w: 0, h: 0, viewportW: 1200, viewportH: 800 })).toEqual({ x: 360, y: 240, w: 480, h: 320 });
  });
});

describe('reading the Google page', () => {
  test('addresses', () => {
    expect(appFromPath('/presentation/d/abc/edit')).toBe('slides');
    expect(appFromPath('/spreadsheets/u/1/d/abc/edit')).toBe('sheet');
    expect(appFromPath('/drive/my-drive')).toBeNull();
    expect(slideIdFromHash('#slide=id.g2a9f_0_12')).toBe('g2a9f_0_12');
    expect(slideIdFromHash('#slide=id.p')).toBe('p');
    expect(slideIdFromHash('#heading=h.1')).toBeNull();
    expect(gidFromHash('#gid=123&range=A1')).toBe('123');
    expect(cleanCellRef(' $b$7 ')).toBe('B7');
    expect(cleanCellRef('A1:C3')).toBe('A1:C3');
    expect(cleanCellRef('MyNamedRange')).toBeNull();
  });
});
