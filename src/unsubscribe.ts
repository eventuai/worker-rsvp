// ============================================================
// EDM unsubscribe — /unsubscribe/:listId/:guestId/:sig
//
// The link is minted per recipient by cms-plugin-events (signature over
// `unsub:listId:guestId` with its PLUGIN_SECRET, verified here with the
// EVENTS_PLUGIN_SECRET copy). GET shows a confirm page; POST sets the guest's
// `not_send` flag over F1 (the events plugin's send flows already skip
// not_send guests). The guest is read from the published DB — same visibility
// rule as the RSVP form.
// ============================================================

import { CmsClient, attr, type CmsPage } from './cms';
import { verifyPayload } from './crypto';
import { getPublishedPage } from './published';
import { renderLiquid } from './templates/liquid';
import type { RsvpEnv } from './rsvp';

const EVENTS_PLUGIN_ID = 'events';

export async function handleUnsubscribe(request: Request, env: RsvpEnv, url: URL): Promise<Response | null> {
  const path = url.pathname.split('/').filter(Boolean);
  if (path[0] !== 'unsubscribe') return null;

  const listId = pageId(path[1]);
  const guestId = pageId(path[2]);
  const signature = path[3] ?? '';
  if (!listId || !guestId || !signature || !env.EVENTS_PLUGIN_SECRET) return new Response('not found', { status: 404 });
  if (!(await verifyPayload(env.EVENTS_PLUGIN_SECRET, `unsub:${listId}:${guestId}`, signature))) {
    return new Response('not found', { status: 404 });
  }

  if (!env.PUBLISHED_DB) return new Response('server misconfigured', { status: 500 });
  const guest = await getPublishedPage(env.PUBLISHED_DB, guestId);
  if (!guest || guest.page_type !== 'guest' || guest.page_id !== listId) {
    return new Response('not found', { status: 404 });
  }

  const alreadyOff = truthy(attr(guest.lect, 'not_send'));

  if (request.method === 'POST' && !alreadyOff) {
    const cms = new CmsClient({
      cmsUrl: env.CMS_URL,
      pluginSecret: env.EVENTS_PLUGIN_SECRET,
      pluginId: EVENTS_PLUGIN_ID,
      fetcher: (input, init) => globalThis.fetch(input, init),
    });
    await cms.update(guest.id, { lect: { not_send: '1' } });
    return page(env.VIEWS, guest, { done: true });
  }

  return page(env.VIEWS, guest, { done: alreadyOff, action: url.pathname });
}

async function page(views: Fetcher, guest: CmsPage, state: { done: boolean; action?: string }): Promise<Response> {
  const html = await renderLiquid(views, '/templates/public-unsubscribe.liquid', {
    email: maskEmail(attr(guest.lect, 'email')),
    done: state.done,
    action: state.action ?? '',
  });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/** a***@example.com — enough to reassure without exposing the address. */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '';
  return `${email[0]}***${email.slice(at)}`;
}

function truthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'yes' || normalized === 'true';
}

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}
