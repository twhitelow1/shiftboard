// Training photos (menu study guide and quizzes). Unlike the logo, these are only for signed-in staff.
// Each photo is one document (menuPhotos/<id>) uploaded one per request through the menu.addPhoto RPC, so
// an upload stays far below Vercel's 4.5 MB request limit; a photo's bytes never change for its id.
import { quizPhotoFor } from '../core/training.js';

// Uploads are JPEG, PNG or WebP; the demo seed uses small SVG placeholders (served with scripts blocked).
const SERVABLE = /^image\/(jpeg|png|webp|svg\+xml)$/;

function send(res, photo, cache) {
  if (!photo || !SERVABLE.test(photo.mime)) return res.status(404).json({ error: 'Photo not found' });
  res.set('Content-Type', photo.mime);
  res.set('Cache-Control', cache);
  res.set('Content-Security-Policy', "default-src 'none'");
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.send(Buffer.from(photo.data, 'base64'));
}

/**
 * @param app express app
 * @param {{ db: import('./db.js').DocDb, signedIn: (req) => object|null }} deps signedIn returns the caller or null
 */
export function trainingRoutes(app, { db, signedIn }) {
  // A menu photo by id. Private (the browser may keep it, shared caches may not) and immutable.
  app.get('/api/training/photos/:id', async (req, res) => {
    await db.sync();
    if (!signedIn(req)) return res.status(401).json({ error: 'Please sign in' });
    send(res, db.store.get('menuPhotos', req.params.id), 'private, max-age=31536000, immutable');
  });

  // The photo for one question of one quiz attempt, without saying which item it shows.
  app.get('/api/training/quiz-photo/:attemptId/:key', async (req, res) => {
    await db.sync();
    const actor = signedIn(req);
    if (!actor) return res.status(401).json({ error: 'Please sign in' });
    send(res, quizPhotoFor(db.store, actor, req.params.attemptId, req.params.key), 'private, max-age=3600');
  });
}
