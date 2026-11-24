// Saving text to a file on this computer. Uses Chrome's "Save as" dialog when
// available, otherwise a normal download. Nothing is uploaded anywhere.

declare global {
  interface Window {
    showSaveFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle>;
  }
}

/** Removes characters Windows and macOS do not allow in file names. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^\.+/, '').trim();
  return (cleaned || 'review').slice(0, 120);
}

export function download(name: string, text: string, mime = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(name);
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Asks where to save, then writes the file. Returns false when the person
 * cancelled. Falls back to a download when the dialog is not available.
 */
export async function saveText(name: string, text: string, mime = 'text/plain', ext = '.txt'): Promise<boolean> {
  const fileName = safeFileName(name);
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: 'Text', accept: { [mime]: [ext] } }] });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return true;
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return false;
      // The dialog is blocked or failed: a plain download still works.
    }
  }
  download(fileName, text, mime);
  return true;
}

/** Lets the person pick a text file and returns its contents (or null when cancelled). */
export function pickTextFile(accept: string, maxBytes: number): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      if (f.size > maxBytes) return reject(new Error('This file is too large.'));
      f.text().then((text) => resolve({ name: f.name, text }), reject);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}
