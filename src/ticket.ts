// ============================================================
// Public ticket purchase pages — checkout form and order/e-ticket page.
//
// The ticket data and all payment logic live in cms-plugin-ticket; this module
// only renders. Every request to the plugin's /api/* relays the HMAC signature
// embedded in the visitor's URL (minted by the plugin, verified by the plugin),
// so this Worker holds no ticket-plugin credentials at all — TICKET_PLUGIN_URL
// is its single piece of configuration.
//
//   GET  /ticket/buy/:eventId/:listId/:guestId/:sig   checkout form
//   POST /ticket/buy/...                              place order → Stripe or order page
//   GET  /ticket/order/:code/:sig                     status / offline instructions / e-ticket QR
// ============================================================

import { qrSvg } from './qr';
import { renderLiquid } from './templates/liquid';

export interface TicketEnv {
  /** Base URL of the cms-plugin-ticket Worker, e.g. https://ticket.example.com */
  TICKET_PLUGIN_URL?: string;
  VIEWS: Fetcher;
}

interface CheckoutContext {
  event: { id: number; name: string; description: string };
  guest: { id: number; name: string; email: string };
  stripe_enabled: boolean;
  offline_enabled: boolean;
  types: Array<{
    id: number;
    name: string;
    description: string;
    price: number;
    price_label: string;
    currency: string;
    remaining: number | null;
  }>;
}

interface OrderStatus {
  order_code: string;
  status: string;
  payment_method: string;
  quantity: number;
  total_label: string;
  email: string;
  event: { id: number; name: string } | null;
  offline_instructions: string;
}

export async function handleTicket(request: Request, env: TicketEnv, url: URL): Promise<Response | null> {
  const path = url.pathname.split('/').filter(Boolean);
  if (path[0] !== 'ticket') return null;
  if (!env.TICKET_PLUGIN_URL) return new Response('server misconfigured', { status: 500 });

  if (path[1] === 'buy' && path.length === 6) {
    const [, , eventId, listId, guestId, signature] = path;
    if (request.method === 'POST') return submitOrder(request, env, { eventId, listId, guestId, signature });
    return buyForm(env, { eventId, listId, guestId, signature });
  }

  if (path[1] === 'order' && path.length === 4 && request.method === 'GET') {
    return orderPage(env, path[2], path[3], url.searchParams.get('cancelled') === '1');
  }

  return new Response('not found', { status: 404 });
}

interface BuyParams {
  eventId: string;
  listId: string;
  guestId: string;
  signature: string;
}

async function fetchContext(env: TicketEnv, params: BuyParams): Promise<CheckoutContext | null> {
  const base = env.TICKET_PLUGIN_URL!.replace(/\/+$/, '');
  const response = await fetch(
    `${base}/api/checkout/${params.eventId}/${params.listId}/${params.guestId}/${params.signature}`,
  );
  if (!response.ok) return null;
  return response.json() as Promise<CheckoutContext>;
}

async function buyForm(env: TicketEnv, params: BuyParams, error = '', form: Record<string, string> = {}): Promise<Response> {
  const context = await fetchContext(env, params);
  if (!context) return new Response('not found', { status: 404 });

  const html = await renderLiquid(env.VIEWS, '/templates/public-ticket-buy.liquid', {
    error,
    eventName: context.event.name,
    eventDescription: context.event.description,
    guestName: context.guest.name,
    email: form.email ?? context.guest.email,
    promoCode: form.promo_code ?? '',
    stripeEnabled: context.stripe_enabled,
    offlineEnabled: context.offline_enabled,
    canPay: context.stripe_enabled || context.offline_enabled,
    hasTypes: context.types.length > 0,
    types: context.types.map((type, index) => ({
      id: type.id,
      name: type.name,
      description: type.description,
      priceLabel: type.price_label,
      remaining: type.remaining,
      limited: type.remaining != null,
      checked: form.ticket_type_id ? String(type.id) === form.ticket_type_id : index === 0,
    })),
    quantities: Array.from({ length: 10 }, (_, index) => ({
      value: index + 1,
      selected: (form.quantity ?? '1') === String(index + 1),
    })),
  });
  return new Response(html, {
    status: error ? 400 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function submitOrder(request: Request, env: TicketEnv, params: BuyParams): Promise<Response> {
  const data = await request.formData();
  const form = {
    ticket_type_id: text(data, 'ticket_type_id'),
    quantity: text(data, 'quantity') || '1',
    promo_code: text(data, 'promo_code'),
    payment_method: text(data, 'payment_method') === 'offline' ? 'offline' : 'stripe',
    email: text(data, 'email'),
  };

  const base = env.TICKET_PLUGIN_URL!.replace(/\/+$/, '');
  const response = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: Number(params.eventId),
      list_id: Number(params.listId),
      guest_id: Number(params.guestId),
      sig: params.signature,
      ticket_type_id: Number(form.ticket_type_id),
      quantity: Number(form.quantity),
      promo_code: form.promo_code,
      payment_method: form.payment_method,
      email: form.email,
    }),
  });

  const payload = await response.json().catch(() => ({})) as {
    error?: string;
    order_url?: string;
    checkout_url?: string;
  };
  if (!response.ok) {
    return buyForm(env, params, payload.error ?? 'Something went wrong — please try again.', form);
  }
  const target = payload.checkout_url || payload.order_url;
  if (!target) return buyForm(env, params, 'Something went wrong — please try again.', form);
  return new Response(null, { status: 303, headers: { location: target } });
}

async function orderPage(env: TicketEnv, code: string, signature: string, cancelled: boolean): Promise<Response> {
  const base = env.TICKET_PLUGIN_URL!.replace(/\/+$/, '');
  const response = await fetch(`${base}/api/orders/${encodeURIComponent(code)}/${encodeURIComponent(signature)}`);
  if (!response.ok) return new Response('not found', { status: 404 });
  const order = await response.json() as OrderStatus;

  const paid = order.status === 'paid';
  // A Stripe payment settles via webhook moments after the redirect back, so
  // the still-pending page refreshes itself until the status flips.
  const refreshing = order.status === 'pending' && !cancelled;
  const html = await renderLiquid(env.VIEWS, '/templates/public-ticket-order.liquid', {
    code: order.order_code,
    status: order.status,
    statusLabel: order.status.replace(/_/g, ' '),
    cancelled,
    paid,
    refreshing,
    pendingOffline: order.status === 'pending_offline',
    failed: order.status === 'cancelled' || order.status === 'refunded' || order.status === 'expired',
    eventName: order.event?.name ?? '',
    quantity: order.quantity,
    totalLabel: order.total_label,
    email: order.email,
    offlineInstructions: order.offline_instructions,
    qrSvg: paid ? qrSvg(order.order_code, { size: 220 }) : '',
  });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}
