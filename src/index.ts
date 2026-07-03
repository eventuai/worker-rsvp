// ============================================================
// worker-rsvp — the public RSVP website backed by 0xCMS.
//
// A standalone Worker on its own domain (the events plugin's PUBLIC_BASE_URL
// points here) that renders the EDM-driven, multilingual RSVP form from the
// CMS's published database. See src/rsvp.ts for the routes and the interim
// submit write-back.
//
// Follows the worker-web posture: published-D1 reads only on GET, strict
// security headers on every response, no cookies or sessions — guest identity
// comes solely from the HMAC-signed link.
// ============================================================

import { handleHome } from './home';
import { handleRsvp, type RsvpEnv } from './rsvp';
import { handleUnsubscribe } from './unsubscribe';

interface Env extends RsvpEnv {
  CF_VERSION_METADATA?: { id?: string };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await route(request, env).catch((error) => {
      console.error('worker-rsvp error', error);
      return new Response('internal error', { status: 500 });
    });
    return withSecurityHeaders(response);
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  // The form is GET (render) + POST (submit); nothing else is accepted.
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
    return new Response('method not allowed', { status: 405 });
  }
  const url = new URL(request.url);

  if (url.pathname === '/healthz') {
    return Response.json({ ok: true, version: env.CF_VERSION_METADATA?.id ?? 'dev' });
  }

  const home = await handleHome(env, url);
  if (home) return home;

  const rsvp = await handleRsvp(request, env, url);
  if (rsvp) return rsvp;

  const unsubscribe = await handleUnsubscribe(request, env, url);
  if (unsubscribe) return unsubscribe;

  return new Response('not found', { status: 404 });
}

function withSecurityHeaders(response: Response): Response {
  const wrapped = new Response(response.body, response);
  const headers = wrapped.headers;
  // Inline <style> is part of the rendered form; everything else stays same-origin.
  headers.set('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return wrapped;
}
