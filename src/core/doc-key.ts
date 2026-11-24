// Stable identity for a document, used to find its saved review session.
// Query strings and fragments are removed: they can hold access tokens
// (for example ?token=... on raw GitHub links), which must never be stored.

export interface DocIdentity {
  docKey: string;
  title: string;
  /** Best guess at the path a coding agent would use. */
  filePath: string;
  baseUrl?: string;
}

function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? 'document.md');
}

export function identityFromUrl(raw: string): DocIdentity {
  const u = new URL(raw);
  u.search = '';
  u.hash = '';
  const clean = u.href;
  if (u.protocol === 'file:') {
    const path = decodeURIComponent(u.pathname);
    return { docKey: clean, title: lastSegment(u.pathname), filePath: path, baseUrl: clean };
  }
  const segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  let filePath = segs.join('/');
  if (u.hostname === 'raw.githubusercontent.com' && segs.length >= 4) {
    // /owner/repo/branch/path... (branch names with slashes cannot be told apart; best effort)
    filePath = segs.slice(3).join('/');
  } else if (u.hostname === 'gitlab.com') {
    const i = segs.indexOf('raw');
    if (i > 0 && segs[i - 1] === '-' && segs.length > i + 2) filePath = segs.slice(i + 2).join('/');
  } else if (u.hostname === 'gist.githubusercontent.com') {
    filePath = segs[segs.length - 1] ?? filePath;
  }
  return { docKey: clean, title: lastSegment(u.pathname), filePath, baseUrl: clean };
}

export function identityFromPickedFile(name: string, handleId: string): DocIdentity {
  return { docKey: `picked:${handleId}`, title: name, filePath: name };
}

export function isMarkdownPath(pathname: string): boolean {
  return /\.(md|markdown|mdown|mkd|mkdn)$/i.test(pathname);
}
