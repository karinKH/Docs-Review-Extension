// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { findSurface, readPlace } from '../../src/core/google/page-adapters';

describe('reading the Google page (DOM)', () => {
  test('Sheets: tab name, cell and what the cell shows', () => {
    document.body.innerHTML = `
      <input id="t-name-box" value="C4">
      <div class="docs-sheet-tab docs-sheet-active-tab"><span class="docs-sheet-tab-name">תקציב</span></div>
      <div id="t-formula-bar-input"><div class="cell-input">=SUM(C1:C3)</div></div>`;
    const loc = { hash: '#gid=77' } as Location;
    const s = findSurface('sheet', document, window);
    expect(s.relativeTo).toBe('viewport');
    expect(readPlace('sheet', document, loc, s)).toEqual({ sheetGid: '77', sheetName: 'תקציב', cell: 'C4', nearText: '=SUM(C1:C3)' });
  });

  test('when nothing is recognised, the visible screen is used', () => {
    document.body.innerHTML = '<div>nothing google here</div>';
    expect(findSurface('slides', document, window).relativeTo).toBe('viewport');
    expect(findSurface('doc', document, window).relativeTo).toBe('viewport');
    expect(readPlace('slides', document, { hash: '' } as Location, findSurface('slides', document, window))).toEqual({ slideId: null, slideNumber: null });
  });
});
