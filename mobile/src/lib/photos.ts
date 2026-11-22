// Photos for the 86 List: take one or pick from the library (asking first, with our own reason, then the
// phone's permission prompt), then shrink it on the phone before upload: about 1200 px on the long side, JPEG,
// under ~480 KB, like the website does (web/src/pages/TrainingShared.jsx photoFromFile). One photo per request.
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';

import { confirm } from './confirm';

export const MAX_SIDE = 1200;
export const MAX_BYTES = 480 * 1024;
export interface ShrunkPhoto { uri: string; dataUrl: string; w: number; h: number }
export type PickResult = { photos: ShrunkPhoto[] } | { denied: true } | { failed: true };

const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4);

/** Resize and compress until it's small enough; null if it can't be read. */
export async function shrink(uri: string, width: number, height: number): Promise<ShrunkPhoto | null> {
  let side = Math.min(MAX_SIDE, Math.max(width, height) || MAX_SIDE);
  for (let tries = 0; tries < 5; tries++) {
    const size = width >= height ? { width: Math.min(side, width || side) } : { height: Math.min(side, height || side) };
    const img = await ImageManipulator.manipulate(uri).resize(size).renderAsync();
    for (const compress of [0.8, 0.65, 0.5]) {
      const out = await img.saveAsync({ compress, format: SaveFormat.JPEG, base64: true });
      const b64 = (out.base64 || '').replace(/^data:[^,]*,/, '');
      if (b64 && base64Bytes(b64) <= MAX_BYTES) return { uri: out.uri, dataUrl: `data:image/jpeg;base64,${b64}`, w: out.width, h: out.height };
    }
    side = Math.round(side * 0.75);
  }
  return null;
}

/**
 * Take a photo ('camera') or choose up to `limit` ('library'). Explains why first (the phone's own prompt
 * follows), then shrinks each one. Words come from the caller so they're in the person's language.
 */
export async function pickPhotos(source: 'camera' | 'library', limit: number, words: { title: string; why: string; allow: string; cancel: string }): Promise<PickResult> {
  if (Platform.OS !== 'web') {
    const current = source === 'camera' ? await ImagePicker.getCameraPermissionsAsync() : await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!current.granted) {
      if (!current.canAskAgain) return { denied: true };
      if (!(await confirm(words.title, words.why, words.allow, words.cancel))) return { photos: [] };
      const asked = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!asked.granted) return { denied: true };
    }
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: false };
  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync(options)
    : await ImagePicker.launchImageLibraryAsync({ ...options, allowsMultipleSelection: limit > 1, selectionLimit: limit });
  if (result.canceled) return { photos: [] };
  const photos: ShrunkPhoto[] = [];
  for (const a of result.assets.slice(0, limit)) {
    try {
      const p = await shrink(a.uri, a.width, a.height);
      if (!p) return photos.length ? { photos } : { failed: true };
      photos.push(p);
    } catch {
      return photos.length ? { photos } : { failed: true };
    }
  }
  return { photos };
}
