// Product photos (Stock lists' catalog, shared with the 86 List: core/products.js). Each is one document
// (productPhotos/<id>), uploaded one per request through the products.addPhoto RPC. For anyone signed in: the catalog
// is the whole team's. The cache holds no bytes (db.js LAZY_DATA). SVG only comes from the demo's placeholder tiles
// (uploads are JPG, PNG or WebP: core/training.js checkPhoto), served with a policy that runs nothing.
import { productPhotoFor } from '../core/stock.js';

const SERVABLE = /^image\/(jpeg|png|webp|svg\+xml)$/;

/**
 * @param app express app
 * @param {{ db: import('./db.js').DocDb, signedIn: (req) => object|null }} deps signedIn: the caller (cookie or bearer), or null
 */
export function stockRoutes(app, { db, signedIn }) {
  app.get('/api/stock/photos/:id', async (req, res) => {
    await db.sync();
    const actor = signedIn(req);
    if (!actor) return res.status(401).json({ error: 'Please sign in' });
    const photo = productPhotoFor(db.store, actor, req.params.id);
    if (!photo || !SERVABLE.test(photo.mime)) return res.status(404).json({ error: 'Photo not found' });
    const data = photo.data ?? (await db.lazyData('productPhotos', photo.id));
    if (!data) return res.status(404).json({ error: 'Photo not found' });
    res.set('Content-Type', photo.mime);
    // Private: browsers keep it a day, shared caches never.
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Security-Policy', "default-src 'none'");
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
    res.send(Buffer.from(data, 'base64'));
  });
}
