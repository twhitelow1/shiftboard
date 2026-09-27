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
