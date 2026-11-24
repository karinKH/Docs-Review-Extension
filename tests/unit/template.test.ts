import { describe, expect, test } from 'vitest';
import { fence, renderTemplate, TemplateError } from '../../src/core/compile/template';

describe('template engine', () => {
  test('variables, loops, conditionals', () => {
    const out = renderTemplate('{{title}}:{{#each items}} {{@number}}={{name}}{{#if flag}}!{{else}}?{{/if}}{{/each}}', {
      title: 'T',
      items: [{ name: 'a', flag: true }, { name: 'b' }],
    });
    expect(out).toBe('T: 1=a! 2=b?');
  });

  test('outer scope is visible inside loops', () => {
    expect(renderTemplate('{{#each xs}}{{doc}}{{this}}{{/each}}', { doc: 'D', xs: [1, 2] })).toBe('D1D2');
  });

  test('unless, join, comments', () => {
    expect(renderTemplate('{{! hi }}{{#unless empty}}x{{/unless}} {{join xs "|"}}', { empty: [], xs: ['a', 'b'] })).toBe('x a|b');
  });

  test('fence never breaks on backticks', () => {
    expect(fence('a ``` b')).toBe('````\na ``` b\n````');
    expect(renderTemplate('{{fence code}}', { code: 'x' })).toBe('```text\nx\n```');
  });

  test('errors are reported, not executed', () => {
    expect(() => renderTemplate('{{#each x}}', {})).toThrow(TemplateError);
    expect(() => renderTemplate('{{constructor.constructor("alert(1)")()}}', {})).toThrow(TemplateError);
    expect(renderTemplate('{{constructor}}', {})).toBe('');
  });
});
