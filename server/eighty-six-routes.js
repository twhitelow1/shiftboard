// 86 List photos (the empty bottle, the low shelf). Each is one document (eightySixPhotos/<id>), uploaded one per
// request through the eightySix.addPhoto RPC. Only for signed-in people who can see the item's list: a photo on a
// hidden list answers 404, like a photo that doesn't exist. The cache holds no bytes (db.js LAZY_DATA).
import { eightySixPhotoFor } from '../core/eighty-six.js';

const SERVABLE = /^image\/(jpeg|png|webp)$/;

/**
 * @param app express app
 * @param {{ db: import('./db.js').DocDb, signedIn: (req) => object|null }} deps signedIn: the caller (cookie or bearer), or null
 */
export function eightySixRoutes(app, { db, signedIn }) {
  app.get('/api/eighty-six/photos/:id', async (req, res) => {
    await db.sync();
    const actor = signedIn(req);
    if (!actor) return res.status(401).json({ error: 'Please sign in' });
    const photo = eightySixPhotoFor(db.store, actor, req.params.id);
    if (!photo || !SERVABLE.test(photo.mime)) return res.status(404).json({ error: 'Photo not found' });
    const data = photo.data ?? (await db.lazyData('eightySixPhotos', photo.id));
    if (!data) return res.status(404).json({ error: 'Photo not found' });
    res.set('Content-Type', photo.mime);
    // Private: who may see a list can change, so browsers keep it a day and shared caches never.
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Security-Policy', "default-src 'none'");
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
    res.send(Buffer.from(data, 'base64'));
  });
}
