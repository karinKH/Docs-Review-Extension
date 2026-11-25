// Crops a screenshot of the visible tab to the commented area and outlines it.
// Runs in the extension's background worker; the image never leaves the browser.

import { cropArea, type CaptureRect } from '../../core/google/page-protocol';

const MAX_SIDE = 1600;

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

export async function cropScreenshot(dataUrl: string, rect: CaptureRect): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  const scale = bitmap.width / rect.viewportW;
  const area = cropArea(rect);
  const sx = Math.round(area.x * scale);
  const sy = Math.round(area.y * scale);
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(area.w * scale)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(area.h * scale)));
  const fit = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * fit));
  const height = Math.max(1, Math.round(sh * fit));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  bitmap.close();
  // Outline what was commented: the box, or a ring around the pin.
  const k = scale * fit;
  const bx = (rect.x - area.x) * k;
  const by = (rect.y - area.y) * k;
  ctx.lineWidth = Math.max(2, 3 * k);
  ctx.strokeStyle = '#e5484d';
  if (rect.w < 4 && rect.h < 4) {
    ctx.beginPath();
    ctx.arc(bx, by, 14 * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bx, by, 3 * k, 0, Math.PI * 2);
    ctx.fillStyle = '#e5484d';
    ctx.fill();
  } else {
    ctx.strokeRect(bx, by, rect.w * k, rect.h * k);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, width, height };
}
