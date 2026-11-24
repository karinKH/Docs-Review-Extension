import { describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile, DEFAULT_OPTIONS, type CompileOptions, type PresetId } from '../../src/core/compile/compile';
import { setStatus } from '../../src/core/session';
import { sampleSession } from './session-fixture';

const goldenDir = fileURLToPath(new URL('../golden/', import.meta.url));

function golden(name: string, actual: string) {
  const file = goldenDir + name;
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, 'utf8'));
}

const presets: PresetId[] = ['agent', 'chat', 'json', 'yaml', 'custom'];

describe('prompt compiler', () => {
  for (const preset of presets) {
    test(`${preset} preset matches its golden file`, () => {
      const out = compile(sampleSession(), { ...DEFAULT_OPTIONS, preset });
      expect(out.parts).toHaveLength(1);
      golden(`${preset}.txt`, out.parts[0]!.text);
    });
  }

  test('output is deterministic across fresh sessions', () => {
    for (const preset of presets) {
      const a = compile(sampleSession(), { ...DEFAULT_OPTIONS, preset }).parts[0]!.text;
      const b = compile(sampleSession(), { ...DEFAULT_OPTIONS, preset }).parts[0]!.text;
      expect(a).toBe(b);
    }
  });

  test('JSON output parses and keeps document order', () => {
    const json = JSON.parse(compile(sampleSession(), { ...DEFAULT_OPTIONS, preset: 'json' }).parts[0]!.text);
    const lines = json.items.map((i: { location: { startLine: number } }) => i.location.startLine);
    expect([...lines].sort((a: number, b: number) => a - b)).toEqual(lines);
    expect(json.items[0].target.type).toBe('TextQuoteSelector');
  });

  test('ambiguous quotes get surrounding text', () => {
    const text = compile(sampleSession(), DEFAULT_OPTIONS).parts[0]!.text;
    expect(text).toContain('This text appears 2 times.');
  });

  test('priority order and filters', () => {
    const opts: CompileOptions = { ...DEFAULT_OPTIONS, preset: 'json', order: 'priority', priorities: ['must', 'suggestion'] };
    const json = JSON.parse(compile(sampleSession(), opts).parts[0]!.text);
    expect(json.items.map((i: { priority: string }) => i.priority)).toEqual(['must', 'must', 'suggestion', 'suggestion']);
  });

  test('resolved items are excluded by default', () => {
    let s = sampleSession();
    s = setStatus(s, s.annotations[0]!.id, 'resolved', 0);
    expect(compile(s, DEFAULT_OPTIONS).itemCount).toBe(5);
  });

  test('section filter', () => {
    const r = compile(sampleSession(), { ...DEFAULT_OPTIONS, preset: 'json', sections: ['Launch plan'] });
    expect(r.itemCount).toBe(6);
    expect(compile(sampleSession(), { ...DEFAULT_OPTIONS, sections: ['Nope'] }).itemCount).toBe(0);
  });

  test('long sessions split into ordered parts', () => {
    const r = compile(sampleSession(), { ...DEFAULT_OPTIONS, maxTokensPerPart: 700 });
    expect(r.parts.length).toBeGreaterThan(1);
    expect(r.parts.reduce((n, p) => n + p.itemCount, 0)).toBe(6);
    expect(r.parts[0]!.text).toContain(`This is part 1 of ${r.parts.length}.`);
    for (const p of r.parts) expect(p.text).toContain('## Rules');
  });

  test('chat preset can include the document', () => {
    const t = compile(sampleSession(), { ...DEFAULT_OPTIONS, preset: 'chat', includeDocument: true }).parts[0]!.text;
    expect(t).toContain('<document title="launch.md"');
    expect(t).toContain('# Launch plan');
  });
});
