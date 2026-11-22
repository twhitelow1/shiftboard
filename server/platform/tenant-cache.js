// The restaurants this instance has open: each one's DocDb (its in-memory copy of the restaurant's
// documents) and its Express app. Opened on a restaurant's first request, and only the most recently
// used ones are kept (TENANT_CACHE_MAX, default 25), so memory doesn't grow with every restaurant on the
// platform. An entry with a request in flight is never evicted; the cache may run over its size until
// those finish, then the least recently used idle ones go.

export class TenantCache {
  constructor({ max = 25, onEvict = null } = {}) {
    this.max = Math.max(1, Number(max) || 25);
    this.map = new Map(); // id -> entry; Map keeps insertion order, so the first key is the least recently used
    this.onEvict = onEvict;
  }

  get size() { return this.map.size; }
  keys() { return [...this.map.keys()]; }
  peek(id) { return this.map.get(id) || null; }

  /** The entry, marked as most recently used. */
  get(id) {
    const e = this.map.get(id);
    if (!e) return null;
    this.map.delete(id);
    this.map.set(id, e);
    e.lastUsed = Date.now();
    return e;
  }

  set(id, entry) {
    entry.inflight ??= 0;
    entry.lastUsed = Date.now();
    this.map.delete(id);
    this.map.set(id, entry);
    this.trim();
    return entry;
  }

  delete(id) {
    const e = this.map.get(id);
    this.map.delete(id);
    return e || null;
  }

  /** Evict least recently used idle entries until the cache fits. */
  trim() {
    for (const [id, e] of this.map) {
      if (this.map.size <= this.max) break;
      if (e.inflight > 0) continue;
      this.map.delete(id);
      try { this.onEvict?.(id, e); } catch { /* eviction never fails a request */ }
    }
  }

  /** Track a request on an entry; call the returned function when it ends (then the cache trims). */
  hold(entry) {
    entry.inflight++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      entry.inflight--;
      if (entry.inflight === 0) this.trim();
    };
  }
}
