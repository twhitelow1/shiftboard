// Minimal document store. The same class runs in the browser (demo mode, in-memory)
// and on the server (in-memory cache with write-through persistence via onChange).

export function uid(prefix = 'id') {
  const rnd = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  return `${prefix}_${rnd}`;
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export class MemoryStore {
  constructor({ onChange } = {}) {
    this.cols = new Map();
    this.onChange = onChange || null;
  }

  col(name) {
    if (!this.cols.has(name)) this.cols.set(name, new Map());
    return this.cols.get(name);
  }

  /** Load raw rows without triggering persistence (used at boot). */
  hydrate(name, rows) {
    const c = this.col(name);
    for (const r of rows) c.set(r.id, r);
  }

  list(name, filter) {
    const out = [];
    for (const v of this.col(name).values()) if (!filter || filter(v)) out.push(clone(v));
    return out;
  }

  get(name, id) {
    return clone(this.col(name).get(id)) || null;
  }

  insert(name, doc) {
    const d = { ...clone(doc) };
    if (!d.id) d.id = uid(name.slice(0, 3));
    this.col(name).set(d.id, d);
    this.onChange?.(name, 'put', d);
    return clone(d);
  }

  update(name, id, patch) {
    const cur = this.col(name).get(id);
    if (!cur) return null;
    const d = { ...cur, ...clone(patch), id };
    this.col(name).set(id, d);
    this.onChange?.(name, 'put', d);
    return clone(d);
  }

  remove(name, id) {
    const had = this.col(name).delete(id);
    if (had) this.onChange?.(name, 'del', { id });
    return had;
  }

  /** Run fn as a unit; persistence layer may batch writes in a transaction. */
  transaction(fn) {
    if (this.beginTx) return this.beginTx(fn);
    return fn();
  }
}

/**
 * Copy-on-write view over a MemoryStore. Reads fall through to the base store;
 * writes stay in the overlay until the caller persists them and applies them.
 * The server runs each request against one of these, so a request that fails
 * (or loses a race) leaves the shared cache untouched.
 */
export class OverlayStore {
  constructor(base) {
    this.base = base;
    this.changes = new Map(); // col -> Map(id -> doc | null (deleted))
  }

  get dirty() {
    return this.changes.size > 0;
  }

  /** Every pending write as { col, id, doc } (doc is null for a delete). */
  changeList() {
    const out = [];
    for (const [col, m] of this.changes) for (const [id, doc] of m) out.push({ col, id, doc });
    return out;
  }

  _pending(name) {
    let m = this.changes.get(name);
    if (!m) this.changes.set(name, (m = new Map()));
    return m;
  }

  _raw(name, id) {
    const m = this.changes.get(name);
    if (m?.has(id)) return m.get(id);
    return this.base.col(name).get(id) ?? null;
  }

  list(name, filter) {
    const out = [];
    const m = this.changes.get(name);
    const baseCol = this.base.col(name);
    for (const [id, v] of baseCol) {
      const cur = m?.has(id) ? m.get(id) : v;
      if (cur && (!filter || filter(cur))) out.push(clone(cur));
    }
    if (m) for (const [id, v] of m) if (v && !baseCol.has(id) && (!filter || filter(v))) out.push(clone(v));
    return out;
  }

  get(name, id) {
    return clone(this._raw(name, id)) || null;
  }

  insert(name, doc) {
    const d = { ...clone(doc) };
    if (!d.id) d.id = uid(name.slice(0, 3));
    this._pending(name).set(d.id, d);
    return clone(d);
  }

  update(name, id, patch) {
    const cur = this._raw(name, id);
    if (!cur) return null;
    const d = { ...cur, ...clone(patch), id };
    this._pending(name).set(id, d);
    return clone(d);
  }

  remove(name, id) {
    if (!this._raw(name, id)) return false;
    this._pending(name).set(id, null);
    return true;
  }

  transaction(fn) {
    return fn();
  }
}
