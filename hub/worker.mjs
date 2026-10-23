// agent-bridge hub on Cloudflare: one Durable Object (built-in SQLite) runs the shared hub core;
// the Worker routes /api, /admin and /health to it and serves the console app for everything else.

import { DurableObject } from 'cloudflare:workers';
import { createHub } from '../plugin/core/hub-core.mjs';

// The single hub instance. (Renamed from "main" when the self-restart below was added: the old
// instance kept running pre-deploy code while connections kept it busy.)
const HUB_NAME = 'hub';

// ---- Cloudflare Access sign-in for the console ----
// Access puts a signed JWT (Cf-Access-Jwt-Assertion) on every request it lets through. A valid one
// issued for the console's Access application stands in for the admin token on /admin, so the
// operator's Cloudflare login is enough. Config: ACCESS_TEAM_DOMAIN (e.g. "team.cloudflareaccess.com")
// and ACCESS_AUD (the application's audience tag); without both, only the admin token works.

let certCache = { at: 0, keys: new Map() };

async function accessKey(teamDomain, kid) {
  if (!certCache.keys.has(kid) || Date.now() - certCache.at > 3600_000) {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    const { keys = [] } = await res.json();
    const map = new Map();
    for (const jwk of keys) {
      map.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    certCache = { at: Date.now(), keys: map };
  }
  return certCache.keys.get(kid);
}

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// The verified claims of the request's Access JWT (signature, issuer, expiry), or null.
async function accessClaims(request, env) {
  const jwt = request.headers.get('cf-access-jwt-assertion');
  const team = env.ACCESS_TEAM_DOMAIN;
  if (!jwt || !team) return null;
  try {
    const [h, p, sig] = jwt.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
    if (header.alg !== 'RS256') return null;
    const key = await accessKey(team, header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    const now = Date.now() / 1000;
    if (!ok || claims.iss !== `https://${team}` || !(claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) return null;
    return claims;
  } catch {
    return null;
  }
}

const audiences = claims => (Array.isArray(claims.aud) ? claims.aud : [claims.aud]);

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    // SQL BLOB bindings must be ArrayBuffers here (the core passes Uint8Arrays).
    const bind = args => args.map(a => (a instanceof Uint8Array ? a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) : a));
    const db = {
      all: (query, ...args) => sql.exec(query, ...bind(args)).toArray(),
      get: (query, ...args) => sql.exec(query, ...bind(args)).toArray()[0],
      run: (query, ...args) => { sql.exec(query, ...bind(args)); },
    };
    this.version = env.VERSION?.id;
    this.deployedAt = Date.parse(env.VERSION?.timestamp || '') || 0;
    this.hub = createHub(db, {
      adminToken: env.ADMIN_TOKEN,
      maxAutoRounds: Number(env.MAX_AUTO_ROUNDS || 20),
      adminOnAgentApi: false, // admin token works only on /admin (behind the console login)
      // Push notifications to the operator's browsers (VAPID key pair: public var + private secret).
      push: env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK
        ? { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: env.VAPID_PRIVATE_JWK, subject: env.PUSH_SUBJECT || 'https://github.com/msmith297/agentbridge' }
        : null,
      defer: p => ctx.waitUntil(p.catch(() => {})),
    });
  }

  fetch(request) {
    // A busy instance can keep running old code after a deploy. When a request arrives from a
    // *newer* Worker version, restart; in-flight long-polls fail and their clients retry.
    // (Requests from older Workers still draining must not trigger restarts.)
    const workerDeployedAt = Number(request.headers.get('x-hub-deployed-at')) || 0;
    if (this.deployedAt && workerDeployedAt > this.deployedAt && !this.restarting) {
      this.restarting = true;
      setTimeout(() => this.ctx.abort('new code deployed'), 50);
    }
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, version: this.version ?? null });
    return this.hub.handle(request);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/admin/') || pathname.startsWith('/pair/')) {
      if (!env.ADMIN_TOKEN) {
        return Response.json({ error: 'hub not configured: run `npx wrangler secret put ADMIN_TOKEN`' }, { status: 503 });
      }
      let accessAdmin = false;
      let accessEmail = null;
      if (pathname.startsWith('/admin/')) {
        const claims = await accessClaims(request, env);
        accessAdmin = Boolean(claims && env.ACCESS_AUD && audiences(claims).includes(env.ACCESS_AUD));
        accessEmail = typeof claims?.email === 'string' ? claims.email.toLowerCase() : null;
        // Lets the console offer "continue as <you>" instead of asking for the admin token.
        if (pathname === '/admin/access') {
          if (!claims) return Response.json({ error: 'no Cloudflare Access login on this request' }, { status: 401 });
          return Response.json({
            admin: accessAdmin,
            email: claims.email ?? null,
            service_token: claims.common_name ?? null,
            aud: audiences(claims),
          }, { status: accessAdmin ? 200 : 403 });
        }
      }
      // A single hub instance: all agents and the console share one registry and queue.
      const forward = req => {
        const headers = new Headers(req.headers);
        // Who is signed in through Access (verified above): the console's operator identity follows it.
        headers.delete('x-operator-email');
        if (accessAdmin && accessEmail) headers.set('x-operator-email', accessEmail);
        // Signed in through Access (and no token sent): act with the admin token on its behalf.
        if (accessAdmin && !headers.has('authorization')) headers.set('authorization', `Bearer ${env.ADMIN_TOKEN}`);
        const deployedAt = Date.parse(env.VERSION?.timestamp || '');
        if (deployedAt) headers.set('x-hub-deployed-at', String(deployedAt));
        // Also understood by instances from before the timestamp check (they restart on any change).
        if (env.VERSION?.id) headers.set('x-hub-version', env.VERSION.id);
        return env.HUB.get(env.HUB.idFromName(HUB_NAME)).fetch(new Request(req, { headers }));
      };
      // Retry once if the instance was restarting (e.g. right after a deploy).
      const retry = request.clone();
      try {
        return await forward(request);
      } catch {
        return forward(retry);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
