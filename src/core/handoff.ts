/** Hand-off of raw Markdown from the content script to the viewer (extension session storage). */
export interface Handoff {
  text: string;
  at: number;
}

/** Session storage holds 10 MB in total; keep each hand-off well below that. */
export const MAX_HANDOFF_CHARS = 4 * 1024 * 1024;

export function handoffKey(url: string): string {
  return `handoff:${url}`;
}
