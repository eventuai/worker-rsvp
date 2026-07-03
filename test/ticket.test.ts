// ============================================================
// Public ticket pages — checkout form and order/e-ticket page.
//
// Drives the Worker directly with a global fetch stub standing in for
// cms-plugin-ticket's /api/* endpoints. This Worker only renders; every
// authorisation decision is the plugin's (relayed signatures).
// ============================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

interface Env {
  TICKET_PLUGIN_URL?: string;
  VIEWS: Fetcher;
}

const site = worker as { fetch(request: Request, env: Env): Promise<Response> };

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        return new Response(await readFile(fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href), 'utf8'));
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

function env(overrides: Partial<Env> = {}): Env {
  return { VIEWS: views(), TICKET_PLUGIN_URL: 'https://ticket.test', ...overrides };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://rsvp.test${path}`, init);
}

const SIG = 'a'.repeat(64);

const CONTEXT = {
  event: { id: 11, name: 'Gala Dinner', description: 'Black tie.' },
  guest: { id: 33, name: 'Ada Lovelace', email: 'ada@example.com' },
  stripe_enabled: true,
  offline_enabled: true,
  types: [
    { id: 44, name: 'Early bird', description: '', price: 12050, price_label: 'HKD 120.50', currency: 'hkd', remaining: 10 },
  ],
};

function stubPlugin(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>): Array<{ path: string; body?: unknown }> {
  const calls: Array<{ path: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'ticket.test') throw new Error(`Unexpected fetch: ${url.href}`);
    calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url.pathname.startsWith(prefix)) return handler(init);
    }
    return new Response('not found', { status: 404 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkout form', () => {
  it('renders ticket types and both payment methods', async () => {
    stubPlugin({ '/api/checkout/': () => Response.json(CONTEXT) });

    const response = await site.fetch(request(`/ticket/buy/11/22/33/${SIG}`), env());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Gala Dinner');
    expect(html).toContain('Early bird');
    expect(html).toContain('HKD 120.50');
    expect(html).toContain('ada@example.com');
    expect(html).toContain('value="stripe"');
    expect(html).toContain('value="offline"');
  });

  it('404s when the plugin rejects the signature', async () => {
    stubPlugin({ '/api/checkout/': () => Response.json({ error: 'not found' }, { status: 404 }) });
    const response = await site.fetch(request(`/ticket/buy/11/22/33/${SIG}`), env());
    expect(response.status).toBe(404);
  });

  it('500s when TICKET_PLUGIN_URL is not configured', async () => {
    const response = await site.fetch(request(`/ticket/buy/11/22/33/${SIG}`), env({ TICKET_PLUGIN_URL: undefined }));
    expect(response.status).toBe(500);
  });
});

describe('checkout submit', () => {
  function submit(): Request {
    const form = new URLSearchParams({
      ticket_type_id: '44', quantity: '2', promo_code: '', payment_method: 'stripe', email: 'ada@example.com',
    });
    return request(`/ticket/buy/11/22/33/${SIG}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  }

  it('relays the order to the plugin and redirects to Stripe', async () => {
    const calls = stubPlugin({
      '/api/orders': () => Response.json({ order_code: 'TABC', order_url: 'https://rsvp.test/ticket/order/TABC/x', checkout_url: 'https://checkout.stripe.com/pay/cs_1' }),
      '/api/checkout/': () => Response.json(CONTEXT),
    });

    const response = await site.fetch(submit(), env());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://checkout.stripe.com/pay/cs_1');
    expect(calls.find((call) => call.path === '/api/orders')?.body).toMatchObject({
      event_id: 11, list_id: 22, guest_id: 33, sig: SIG, ticket_type_id: 44, quantity: 2, payment_method: 'stripe',
    });
  });

  it('redirects to the order page for offline orders', async () => {
    stubPlugin({
      '/api/orders': () => Response.json({ order_code: 'TABC', order_url: 'https://rsvp.test/ticket/order/TABC/x' }),
      '/api/checkout/': () => Response.json(CONTEXT),
    });
    const response = await site.fetch(submit(), env());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://rsvp.test/ticket/order/TABC/x');
  });

  it('re-renders the form with the plugin error message', async () => {
    stubPlugin({
      '/api/orders': () => Response.json({ error: 'Only 1 left.' }, { status: 400 }),
      '/api/checkout/': () => Response.json(CONTEXT),
    });
    const response = await site.fetch(submit(), env());
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Only 1 left.');
  });
});

describe('order page', () => {
  function orderJson(overrides: Record<string, unknown> = {}) {
    return {
      order_code: 'TABC123',
      status: 'paid',
      payment_method: 'stripe',
      quantity: 2,
      total_label: 'HKD 241.00',
      email: 'ada@example.com',
      event: { id: 11, name: 'Gala Dinner' },
      offline_instructions: '',
      ...overrides,
    };
  }

  it('shows the e-ticket QR when paid', async () => {
    stubPlugin({ '/api/orders/': () => Response.json(orderJson()) });
    const response = await site.fetch(request(`/ticket/order/TABC123/${SIG}`), env());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('TABC123');
    expect(html).toContain('<svg');
    expect(html).toContain('Confirmed');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it('shows offline instructions while awaiting payment', async () => {
    stubPlugin({
      '/api/orders/': () => Response.json(orderJson({ status: 'pending_offline', offline_instructions: 'Transfer to account 123-456.' })),
    });
    const html = await (await site.fetch(request(`/ticket/order/TABC123/${SIG}`), env())).text();
    expect(html).toContain('Awaiting payment');
    expect(html).toContain('Transfer to account 123-456.');
    expect(html).not.toContain('<svg');
  });

  it('auto-refreshes while a Stripe payment is settling', async () => {
    stubPlugin({ '/api/orders/': () => Response.json(orderJson({ status: 'pending' })) });
    const html = await (await site.fetch(request(`/ticket/order/TABC123/${SIG}`), env())).text();
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('Processing payment');
  });

  it('404s an unknown or forged order link', async () => {
    stubPlugin({ '/api/orders/': () => Response.json({ error: 'not found' }, { status: 404 }) });
    const response = await site.fetch(request(`/ticket/order/TABC123/${SIG}`), env());
    expect(response.status).toBe(404);
  });
});
