// Picking a profile photo: choose a picture (or take one), drag and zoom it in a square, and it's saved as a
// small square JPEG (web/src/photo.js). Used by the welcome wizard and My settings.
import React, { useRef, useState } from 'react';
import { Avatar, Icon } from '../ui.jsx';
import { imageSize, squarePhoto } from '../photo.js';
import { useT } from '../i18n/index.js';

const VIEW = 240; // the crop square on screen, in CSS pixels

/** src: a photo to show instead of the saved one (the wizard shows what was just picked: it can't load /api/photos yet). */
export function PhotoPicker({ user, src, onSave, onRemove, busy }) {
  const t = useT();
  const input = useRef(null);
  const [img, setImg] = useState(null); // { file, url, w, h }
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef(null);
  const [err, setErr] = useState('');

  const scale = img ? (VIEW * zoom) / Math.min(img.w, img.h) : 1;
  const clamp = (o, s = scale) => img ? { x: Math.min(0, Math.max(VIEW - img.w * s, o.x)), y: Math.min(0, Math.max(VIEW - img.h * s, o.y)) } : o;
  const pick = async (file) => {
    if (!file) return;
    setErr('');
    try {
      const size = await imageSize(file);
      const s = VIEW / Math.min(size.w, size.h);
      setImg({ file, ...size });
      setZoom(1);
      setOff({ x: (VIEW - size.w * s) / 2, y: (VIEW - size.h * s) / 2 });
    } catch (e) { setErr(e.message); }
  };
  const setZoomKeepCenter = (z) => {
    const s2 = (VIEW * z) / Math.min(img.w, img.h);
    const cx = (VIEW / 2 - off.x) / scale, cy = (VIEW / 2 - off.y) / scale;
    setZoom(z);
    setOff(clamp({ x: VIEW / 2 - cx * s2, y: VIEW / 2 - cy * s2 }, s2));
  };
  const save = async () => {
    try {
      const dataUrl = await squarePhoto(img.file, { crop: { x: -off.x / scale, y: -off.y / scale, size: VIEW / scale } });
      await onSave(dataUrl);
      URL.revokeObjectURL(img.url);
      setImg(null);
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="col" style={{ gap: 10 }}>
      {!img && (
        <div className="row" style={{ gap: 12 }}>
          {src ? <img className="avatar avatar-photo xl" src={src} alt="" /> : <Avatar user={user} size="xl" />}
          <div className="col" style={{ gap: 6, alignItems: 'flex-start' }}>
            <button type="button" className="btn sm" disabled={busy} onClick={() => input.current?.click()}><Icon name="camera" />{user?.photoId || src ? t('security.changePhoto') : t('security.addPhoto')}</button>
            {(user?.photoId || src) && onRemove &&<button type="button" className="btn sm ghost" disabled={busy} onClick={onRemove}>{t('security.removePhoto')}</button>}
          </div>
        </div>
      )}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {img && (
        <div className="col" style={{ gap: 10, alignItems: 'center' }}>
          <div className="crop-view" style={{ width: VIEW, height: VIEW }}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, off }; }}
            onPointerMove={(e) => { if (drag.current) setOff(clamp({ x: drag.current.off.x + e.clientX - drag.current.x, y: drag.current.off.y + e.clientY - drag.current.y })); }}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
            <img src={img.url} alt="" draggable={false} style={{ width: img.w * scale, height: img.h * scale, transform: `translate(${off.x}px, ${off.y}px)` }} />
          </div>
          <label className="row small" style={{ gap: 8, width: VIEW }}>{t('security.zoom')}
            <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(e) => setZoomKeepCenter(Number(e.target.value))} style={{ flex: 1 }} aria-label={t('security.zoom')} />
          </label>
          <div className="small muted">{t('security.dragToFit')}</div>
          <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
            <button type="button" className="btn primary" disabled={busy} onClick={save}><Icon name="check" />{t('security.usePhoto')}</button>
            <button type="button" className="btn ghost" onClick={() => { URL.revokeObjectURL(img.url); setImg(null); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
      {err && <div className="alert bad">{err}</div>}
    </div>
  );
}
