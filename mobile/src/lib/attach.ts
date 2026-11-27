// Ask → attach a file. On the phone: a photo (the library or the camera, shrunk like the 86 List's), since the app
// has no document picker yet; in the browser version (/app): any file the website takes (PDF, Word, Excel, CSV, a
// picture), sent as its text or its bytes for the server to read (core/import-detect.js). Files never stay on the server.
import { Platform } from 'react-native';

import type { AskFilePayload } from './assistant';
import { pickPhotos, shrink } from './photos';

export const MAX_FILE_BYTES = 1_400_000; // the server takes about 2 MB per request (base64 adds a third)
export type Attached = { file: AskFilePayload } | { denied: true } | { error: 'type' | 'tooBig' | 'unreadable' } | null;
type Words = { title: string; why: string; allow: string; cancel: string };
const TEXT = /\.(csv|tsv|txt)$/i;
const DOCS = /\.(xlsx|docx|pdf)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

const photoPayload = (name: string, p: { dataUrl: string; w: number; h: number }): AskFilePayload => {
  const data = p.dataUrl.replace(/^data:[^,]*,/, '');
  return { name, type: 'image/jpeg', mediaType: 'image/jpeg', size: Math.floor((data.length * 3) / 4), data, width: p.w, height: p.h };
};

/** A photo from the library or the camera. */
export async function attachPhoto(source: 'camera' | 'library', words: Words): Promise<Attached> {
  const r = await pickPhotos(source, 1, words);
  if ('denied' in r) return { denied: true };
  if ('failed' in r) return { error: 'unreadable' };
  const p = r.photos[0];
  return p ? { file: photoPayload(source === 'camera' ? 'photo.jpg' : 'picture.jpg', p) } : null;
}

/** Whether this is the browser version, where any file can be attached. */
export const canAttachFiles = Platform.OS === 'web';

/** In the browser version: any file, through the browser's own file picker. */
export function attachWebFile(): Promise<Attached> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.xlsx,.csv,.tsv,.txt,image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) { resolve(null); return; }
      try {
        if (IMAGE.test(f.name) || f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          const size = await new Promise<{ w: number; h: number }>((ok, bad) => { const i = new Image(); i.onload = () => ok({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = bad; i.src = url; });
          const p = await shrink(url, size.w, size.h);
          URL.revokeObjectURL(url);
          resolve(p ? { file: photoPayload(f.name, p) } : { error: 'unreadable' });
          return;
        }
        if (!TEXT.test(f.name) && !DOCS.test(f.name)) { resolve({ error: 'type' }); return; }
        if (f.size > MAX_FILE_BYTES) { resolve({ error: 'tooBig' }); return; }
        if (TEXT.test(f.name)) { resolve({ file: { name: f.name, type: f.type, size: f.size, text: await f.text() } }); return; }
        const bytes = new Uint8Array(await f.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        resolve({ file: { name: f.name, type: f.type, size: f.size, data: btoa(s) } });
      } catch {
        resolve({ error: 'unreadable' });
      }
    };
    input.click();
  });
}
