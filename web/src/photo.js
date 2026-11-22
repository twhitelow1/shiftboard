// Profile photos: cropped to a square and shrunk to about 256px JPEG in the browser, so uploads stay tiny.
// Shown in Team, My Shifts and the header avatar (ui.jsx Avatar), with initials when there's no photo.
import { IS_DEMO, call } from './api.js';

export const PHOTO_SIZE = 256;

/**
 * A square JPEG data URL from an image file. crop: { x, y, size } in the image's own pixels (default: the
 * centered square), zoom from the cropper.
 */
export function squarePhoto(file, { crop, size = PHOTO_SIZE, quality = 0.85 } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const side = Math.min(w, h);
        const c = crop || { x: (w - side) / 2, y: (h - side) / 2, size: side };
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, c.x, c.y, c.size, c.size, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file isn’t an image')); };
    img.src = url;
  });
}

/** Read an image file's size (for the cropper). */
export function imageSize(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ url, w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file isn’t an image')); };
    img.src = url;
  });
}

// The demo has no server: photos come from the in-browser store as data URLs.
const demoCache = new Map();
/** The address of someone's photo, or '' (initials then). In the demo, a data URL once it's loaded. */
export function photoSrc(user, onDemoLoad) {
  const id = user?.photoId;
  if (!id) return '';
  if (!IS_DEMO) return `/api/photos/${encodeURIComponent(id)}`;
  if (demoCache.has(id)) return demoCache.get(id);
  call('profile.photo.get', { id }).then((r) => { demoCache.set(id, r.dataUrl); onDemoLoad?.(); }).catch(() => demoCache.set(id, ''));
  return '';
}
/** Remember a photo the demo just made, so it shows right away. */
export const rememberDemoPhoto = (id, dataUrl) => { if (IS_DEMO && id) demoCache.set(id, dataUrl); };
