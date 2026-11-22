// My profile (name, mobile number, photo) and the one-time consent screen. Merged into core/service.js.
//
//   profilePhotos  one square JPEG per person (about 256px, made in the browser), base64 in `data`. Kept in
//                  Postgres only (server/db.js LAZY_DATA) and served to signed-in people by
//                  server/auth-routes.js (/api/photos/:id). users.photoId points at the current one; a new
//                  photo gets a new id, so a photo's bytes never change for its id.
import { uid } from './store.js';
import { checkPhoto } from './training.js';
import { normalizePhone, formatPhone } from './notify-prefs.js';
import { applyConsents, consentState, LEGAL_LINKS } from './consent.js';

export const PROFILE_PHOTO_MAX = 200 * 1024;

export function profileApi({ store, now, fail, needAuth, settings, langOf, request, channels, legal }) {
  const me = (actor) => store.get('users', actor.id);
  const view = (u) => ({ id: u.id, name: u.name, phone: u.phone || '', photoId: u.photoId || null });

  return {
    // Change my own name and mobile number (managers still edit people in Team).
    'profile.update': (actor, a = {}) => {
      needAuth(actor);
      const patch = {};
      if ('name' in a) {
        const name = String(a.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!name) fail(400, 'Name is required');
        patch.name = name;
      }
      if ('phone' in a) {
        const raw = String(a.phone ?? '').trim();
        if (raw && !normalizePhone(raw)) fail(400, 'Enter your mobile number, like (303) 555-0123');
        patch.phone = raw ? formatPhone(normalizePhone(raw)) : '';
      }
      return view(store.update('users', actor.id, patch));
    },
    // My photo: a data URL the browser already cropped to a square and shrank (JPEG, about 256px).
    'profile.setPhoto': (actor, { dataUrl } = {}) => {
      needAuth(actor);
      const { mime, data, bytes } = checkPhoto(dataUrl, fail);
      if (bytes > PROFILE_PHOTO_MAX) fail(413, 'That photo is too large. Try another one.');
      const cur = me(actor);
      const id = uid('pph');
      store.insert('profilePhotos', { id, userId: actor.id, mime, data, bytes, createdAt: now().toISOString() });
      if (cur.photoId) store.remove('profilePhotos', cur.photoId);
      return view(store.update('users', actor.id, { photoId: id }));
    },
    'profile.removePhoto': (actor) => {
      needAuth(actor);
      const cur = me(actor);
      if (cur.photoId) store.remove('profilePhotos', cur.photoId);
      return view(store.update('users', actor.id, { photoId: null }));
    },
    // A photo as a data URL, for the demo (the server serves /api/photos/:id instead; its cache has no bytes).
    'profile.photo.get': (actor, { id } = {}) => {
      needAuth(actor);
      const p = store.get('profilePhotos', id);
      if (!p?.data) fail(404, 'Photo not found');
      return { id: p.id, dataUrl: `data:${p.mime};base64,${p.data}` };
    },

    // The one-time consent screen at sign-in, for people who were here before consent records existed:
    // terms (required) plus texts and email for the channels they haven't agreed to. A box counts only
    // when it's exactly true.
    'consent.accept': (actor, a = {}) => {
      needAuth(actor);
      const sms = channels?.sms?.enabled && settings().smsNotifications !== false;
      try {
        applyConsents(store, actor.id, { terms: a.terms, sms: a.sms, email: a.email, phone: a.phone }, {
          lang: a.lang === 'en' || a.lang === 'es' ? a.lang : langOf(actor), ip: request?.ip, userAgent: request?.userAgent,
          source: 'onboarding', at: now().toISOString(), smsEnabled: !!sms, requireTerms: true, links: legal || LEGAL_LINKS,
        });
      } catch (e) {
        fail(e.status || 400, e.message);
      }
      return consentState(store, me(actor));
    },
  };
}
