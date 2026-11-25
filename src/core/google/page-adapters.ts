// Reads where you are on a Google Docs, Sheets or Slides page: which slide,
// page or cell, and where the slide or page sits on screen.
//
// Google does not publish its page structure, and it changes it from time to
// time. Everything Google-specific is kept in this one file, every lookup has
// a fallback, and when nothing is recognised a pin is placed relative to the
// visible screen and marked as approximate instead of failing.

export type App = 'doc' | 'sheet' | 'slides';

export interface Surface {
  /** The slide or page element, or null when only the visible screen is known. */
  el: Element | null;
  rect: { left: number; top: number; width: number; height: number };
  relativeTo: 'slide' | 'page' | 'viewport';
}

export interface PlaceInfo {
  slideId?: string | null;
  slideNumber?: number | null;
  page?: number | null;
  sheetGid?: string | null;
  sheetName?: string | null;
  cell?: string | null;
  nearText?: string | null;
}

export function appFromPath(pathname: string): App | null {
  if (/^\/document\//.test(pathname)) return 'doc';
  if (/^\/spreadsheets\//.test(pathname)) return 'sheet';
  if (/^\/presentation\//.test(pathname)) return 'slides';
  return null;
}

/** "#slide=id.g2a9f_0_12" -> "g2a9f_0_12". */
export function slideIdFromHash(hash: string): string | null {
  const m = /(?:^#|[&#])slide=id\.([\w.-]{1,120})/.exec(hash);
  return m ? m[1]! : null;
}

/** "#gid=123" -> "123". */
export function gidFromHash(hash: string): string | null {
  const m = /(?:^#|[&#])gid=(\d{1,12})/.exec(hash);
  return m ? m[1]! : null;
}

/** A Sheets name-box value that looks like a cell or range ("B7", "B7:D9"). */
export function cleanCellRef(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return /^\$?[A-Z]{1,3}\$?\d{1,7}(?::\$?[A-Z]{1,3}\$?\d{1,7})?$/i.test(t) ? t.toUpperCase().replace(/\$/g, '') : null;
}

function visibleRect(el: Element, win: Window): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) return null;
  if (r.bottom <= 0 || r.right <= 0 || r.top >= win.innerHeight || r.left >= win.innerWidth) return null;
  return r;
}

function largest(els: Iterable<Element>, win: Window, ownRoot?: Element | null): Element | null {
  let best: Element | null = null;
  let bestArea = 0;
  for (const el of els) {
    if (ownRoot && (el === ownRoot || ownRoot.contains(el))) continue;
    const r = visibleRect(el, win);
    if (!r) continue;
    const w = Math.min(r.right, win.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0);
    const area = w * h;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

function viewportSurface(win: Window): Surface {
  return { el: null, rect: { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight }, relativeTo: 'viewport' };
}

function toSurface(el: Element | null, relativeTo: 'slide' | 'page', win: Window): Surface {
  if (!el) return viewportSurface(win);
  const r = el.getBoundingClientRect();
  return { el, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, relativeTo };
}

// Candidate selectors, most specific first. Unverified against every Google
// release; the generic fallbacks below catch the rest.
const SLIDE_SELECTORS = ['.punch-viewer-svgpage-svgcontainer svg', '#editor svg.punch-viewer-svgpage', '.punch-page-container svg', '#pages svg'];
const PAGE_SELECTORS = ['.kix-page-paginated', '.kix-page', '.docs-page'];
const FILMSTRIP_SELECTED = ['.punch-filmstrip-thumbnail[aria-selected="true"]', '.punch-filmstrip-selected-thumbnail-pagenumber', '[role="listbox"] [role="option"][aria-selected="true"]'];

/** The slide being edited (Slides) or the page at a screen point (Docs). */
export function findSurface(app: App, doc: Document, win: Window, at?: { x: number; y: number }, ownRoot?: Element | null): Surface {
  if (app === 'slides') {
    for (const sel of SLIDE_SELECTORS) {
      const el = largest(doc.querySelectorAll(sel), win, ownRoot);
      if (el) return toSurface(el, 'slide', win);
    }
    // Fallback: the largest drawing on screen is the slide being edited.
    const el = largest(doc.querySelectorAll('svg, canvas'), win, ownRoot);
    return el && el.getBoundingClientRect().width > 300 ? toSurface(el, 'slide', win) : viewportSurface(win);
  }
  if (app === 'doc') {
    const pages = docPages(doc, ownRoot);
    if (at) {
      const hit = pages.find((p) => {
        const r = p.getBoundingClientRect();
        return at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom;
      });
      if (hit) return toSurface(hit, 'page', win);
    }
    const el = largest(pages, win, ownRoot);
    return el ? toSurface(el, 'page', win) : viewportSurface(win);
  }
  return viewportSurface(win);
}

export function docPages(doc: Document, ownRoot?: Element | null): Element[] {
  for (const sel of PAGE_SELECTORS) {
    const list = [...doc.querySelectorAll(sel)].filter((el) => !ownRoot || !ownRoot.contains(el));
    if (list.length) return list.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }
  return [];
}

/** The page element for a 1-based page number, if Google has it on the page. */
export function docPageElement(doc: Document, page: number, ownRoot?: Element | null): Element | null {
  return docPages(doc, ownRoot)[page - 1] ?? null;
}

/** Where you are right now: slide id and number, page number, or sheet tab and cell. */
export function readPlace(app: App, doc: Document, loc: Location, surface: Surface, ownRoot?: Element | null): PlaceInfo {
  if (app === 'slides') {
    let slideNumber: number | null = null;
    for (const sel of FILMSTRIP_SELECTED) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const n = Number((el.textContent ?? '').trim());
      if (Number.isInteger(n) && n > 0) {
        slideNumber = n;
        break;
      }
      const siblings = el.parentElement ? [...el.parentElement.children] : [];
      const i = siblings.indexOf(el);
      if (i >= 0) {
        slideNumber = i + 1;
        break;
      }
    }
    return { slideId: slideIdFromHash(loc.hash), slideNumber };
  }
  if (app === 'doc') {
    const pages = docPages(doc, ownRoot);
    const i = surface.el ? pages.indexOf(surface.el) : -1;
    return { page: i >= 0 ? i + 1 : null };
  }
  const nameBox = doc.querySelector<HTMLInputElement>('#t-name-box, input.waffle-name-box');
  const tabName = doc.querySelector('.docs-sheet-active-tab .docs-sheet-tab-name');
  const formula = doc.querySelector('#t-formula-bar-input .cell-input, #t-formula-bar-input');
  const near = (formula?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return {
    sheetGid: gidFromHash(loc.hash),
    sheetName: (tabName?.textContent ?? '').trim().slice(0, 200) || null,
    cell: cleanCellRef(nameBox?.value),
    nearText: near ? near.slice(0, 500) : null,
  };
}

/** Clamp to 0..1 and keep 4 decimals, so saved numbers stay small and stable. */
export function frac(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
}
