// A software passkey for tests: an ES256 (P-256) key made with node:crypto that answers the browser's
// navigator.credentials.create() and .get() the way a phone would (user present and verified, discoverable).
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// Just enough CBOR for an attestation object and a COSE key: maps, ints, byte and text strings.
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (v && typeof v === 'object') return cbor(new Map(Object.entries(v)));
  throw new Error(`cbor: ${typeof v}`);
}

/**
 * A new passkey. register(options, origin) answers the registration options; sign(options, origin) answers
 * the sign-in options. options are what the server's /options route returned.
 */
export function softPasskey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = crypto.randomBytes(16);
  let counter = 0;
  let userHandle = null;
  const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const flags = (attested) => 0x01 | 0x04 | (attested ? 0x40 : 0); // user present, user verified, (credential data)

  return {
    id: b64u(id),
    register(options, origin) {
      userHandle = options.user.id;
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
      const authData = Buffer.concat([sha256(options.rp.id), Buffer.from([flags(true)]), Buffer.alloc(4), Buffer.alloc(16), len, id, cose]);
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64u(id), rawId: b64u(id), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData('webauthn.create', options.challenge, origin)), attestationObject: b64u(attestationObject), transports: ['internal', 'hybrid'] },
      };
    },
    sign(options, origin, { rpId = options.rpId, verified = true } = {}) {
      counter += 1;
      const count = Buffer.alloc(4); count.writeUInt32BE(counter);
      const authData = Buffer.concat([sha256(rpId), Buffer.from([verified ? flags(false) : 0x01]), count]);
      const cd = clientData('webauthn.get', options.challenge, origin);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(cd)]), privateKey); // DER, as authenticators send it
      return {
        id: b64u(id), rawId: b64u(id), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature), userHandle },
      };
    },
  };
}
