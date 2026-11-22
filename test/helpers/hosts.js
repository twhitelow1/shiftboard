// HTTP requests with any Host header (fetch can't set it), and a cookie jar per client, for testing
// the platform's routing by host against one local server.
import http from 'node:http';

export function request(port, { host, method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { Host: host, ...(data != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, body: json });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

/** A browser-like client for one host: keeps its cookies. */
export function hostClient(port, host) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function send(method, path, body, headers = {}) {
    const r = await request(port, { host, method, path, body, headers: { ...(jar.size ? { Cookie: cookie() } : {}), ...headers } });
    for (const c of [].concat(r.headers['set-cookie'] || [])) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*expires=Thu, 01 Jan 1970/i.test(a)) || !value;
      if (expired) jar.delete(name); else jar.set(name, value);
    }
    return r;
  }
  return {
    host,
    send,
    get: (path, headers) => send('GET', path, undefined, headers),
    post: (path, body = {}, headers) => send('POST', path, body, headers),
    patch: (path, body = {}, headers) => send('PATCH', path, body, headers),
    put: (path, body = {}, headers) => send('PUT', path, body, headers),
    rpc: (method, args = {}, headers) => send('POST', `/api/rpc/${method}`, args, headers),
    cookies: () => cookie(),
    setCookies(str) { jar.clear(); for (const p of String(str || '').split(/;\s*/).filter(Boolean)) { const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1)); } },
    async login(email, password = 'demo1234') {
      const r = await send('POST', '/api/auth/login', { email, password });
      if (r.status !== 200) throw new Error(`login ${email} on ${host}: ${r.status} ${r.text}`);
      return this;
    },
  };
}
