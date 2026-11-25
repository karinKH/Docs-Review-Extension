// Recognises Google Docs, Sheets and Slides links and builds the export
// addresses Review Pen reads them from. Only docs.google.com is accepted.

export type GoogleKind = 'doc' | 'sheet' | 'slides';

export interface GoogleRef {
  kind: GoogleKind;
  id: string;
  /** Sheets: the tab that was open (from #gid=…), if any. */
  gid: string | null;
  /** Which signed-in Google account the link was opened with (/u/1/ or ?authuser=1). */
  authuser: string | null;
}

const PATH = /^\/(document|spreadsheets|presentation)\/(?:u\/(\d{1,2})\/)?d\/([A-Za-z0-9_-]{20,128})(?:\/|$)/;
const KIND: Record<string, GoogleKind> = { document: 'doc', spreadsheets: 'sheet', presentation: 'slides' };

export function parseGoogleUrl(raw: string): GoogleRef | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
  const m = PATH.exec(u.pathname);
  if (!m) return null;
  const gid = /(?:^|[#&?])gid=(\d{1,12})/.exec(u.hash)?.[1] ?? u.searchParams.get('gid');
  const au = u.searchParams.get('authuser') ?? m[2] ?? null;
  return { kind: KIND[m[1]!]!, id: m[3]!, gid: gid && /^\d+$/.test(gid) ? gid : null, authuser: au && /^\d{1,2}$/.test(au) ? au : null };
}

export const KIND_TITLES: Record<GoogleKind, string> = { doc: 'Google Doc', sheet: 'Google Sheet', slides: 'Google Slides deck' };

export function isGoogleUrl(raw: string): boolean {
  return parseGoogleUrl(raw) !== null;
}

/** The stable key a review of this file is saved under (no account index, no tab). */
export function googleDocKey(ref: GoogleRef): string {
  return `google:${ref.kind}:${ref.id}`;
}

export function googleEditUrl(ref: GoogleRef): string {
  const path = { doc: 'document', sheet: 'spreadsheets', slides: 'presentation' }[ref.kind];
  return `https://docs.google.com/${path}/d/${ref.id}/edit`;
}

/** The Google address for a saved review key ("google:slides:<id>"), going to the slide or tab of a pin when known. */
export function googleUrlForKey(docKey: string, at?: { slideId?: string | null; sheetGid?: string | null }): string | null {
  const m = /^google:(doc|sheet|slides):([A-Za-z0-9_-]{20,128})$/.exec(docKey);
  if (!m) return null;
  const url = googleEditUrl({ kind: m[1] as GoogleKind, id: m[2]!, gid: null, authuser: null });
  if (at?.slideId && /^[\w.-]{1,120}$/.test(at.slideId)) return `${url}#slide=id.${at.slideId}`;
  if (at?.sheetGid && /^\d{1,12}$/.test(at.sheetGid)) return `${url}#gid=${at.sheetGid}`;
  return url;
}

export interface ExportCandidate {
  url: string;
  format: 'md' | 'txt' | 'xlsx' | 'csv' | 'pptx';
}

/** Export addresses to try, best first. */
export function exportCandidates(ref: GoogleRef): ExportCandidate[] {
  const base = `https://docs.google.com`;
  const au = ref.authuser ? `authuser=${ref.authuser}` : '';
  const q = (s: string) => (au ? (s.includes('?') ? `${s}&${au}` : `${s}?${au}`) : s);
  switch (ref.kind) {
    case 'doc':
      return [
        { url: q(`${base}/document/d/${ref.id}/export?format=md`), format: 'md' },
        { url: q(`${base}/document/d/${ref.id}/export?format=txt`), format: 'txt' },
      ];
    case 'sheet':
      return [
        { url: q(`${base}/spreadsheets/d/${ref.id}/export?format=xlsx`), format: 'xlsx' },
        { url: q(`${base}/spreadsheets/d/${ref.id}/gviz/tq?tqx=out:csv${ref.gid ? `&gid=${ref.gid}` : ''}`), format: 'csv' },
      ];
    case 'slides':
      return [
        { url: q(`${base}/presentation/d/${ref.id}/export/pptx`), format: 'pptx' },
        { url: q(`${base}/presentation/d/${ref.id}/export/txt`), format: 'txt' },
      ];
  }
}

/** File name from a Content-Disposition header (RFC 6266), without its extension. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  let name: string | null = null;
  if (star) {
    try {
      name = decodeURIComponent(star[1]!.trim());
    } catch {
      name = null;
    }
  }
  name ??= /filename\s*=\s*"([^"]*)"/.exec(header)?.[1] ?? /filename\s*=\s*([^;]+)/.exec(header)?.[1]?.trim() ?? null;
  if (!name) return null;
  return name.replace(/\.(md|txt|xlsx|csv|pptx)$/i, '').slice(0, 300) || null;
}

/** "Budget 2026 - Google Sheets" → "Budget 2026". */
export function titleFromTab(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = title.replace(/\s+[-–]\s+Google (Docs|Sheets|Slides)\s*$/i, '').trim();
  return t ? t.slice(0, 300) : null;
}
