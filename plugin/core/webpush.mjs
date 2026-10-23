// Web Push sender (RFC 8030 delivery, RFC 8291 aes128gcm encryption, RFC 8292 VAPID), using only
// WebCrypto so it runs in Cloudflare Workers and Node alike.
//
// Keys: `publicKey` is the VAPID public key (base64url, 65-byte uncompressed P-256 point, which the
// browser gets as applicationServerKey); `privateJwk` is the matching private key as a JWK.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export const b64url = bytes => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64url = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, bytes) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// RFC 8291: encrypt `payload` for a subscription's keys (p256dh, auth), as one aes128gcm record.
export async function encryptPayload(payload, p256dh, auth) {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const local = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await subtle.exportKey('raw', local.publicKey));
  const uaKey = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const plaintext = concat(enc.encode(payload), new Uint8Array([2])); // 0x02: last (only) record
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); // record size
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

// RFC 8292: the VAPID JWT identifying this sender to the push service.
async function vapidToken(endpoint, privateJwk, subject) {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await subtle.importKey('jwk', { ...privateJwk, key_ops: ['sign'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

export function createPusher({ publicKey, privateJwk, subject }) {
  const jwk = typeof privateJwk === 'string' ? JSON.parse(privateJwk) : privateJwk;
  // Returns the push service's HTTP status (404/410: the subscription is gone).
  return async function push(subscription, data, { ttl = 86_400, urgency = 'high', topic } = {}) {
    const body = await encryptPayload(JSON.stringify(data), subscription.p256dh, subscription.auth);
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttl),
        urgency,
        ...(topic ? { topic } : {}),
        authorization: `vapid t=${await vapidToken(subscription.endpoint, jwk, subject)}, k=${publicKey}`,
      },
      body,
    });
    return res.status;
  };
}

// A new VAPID key pair: { publicKey (base64url), privateJwk }.
export async function generateVapidKeys() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64url(await subtle.exportKey('raw', pair.publicKey));
  const { kty, crv, d, x, y } = await subtle.exportKey('jwk', pair.privateKey);
  return { publicKey, privateJwk: { kty, crv, d, x, y } };
}
