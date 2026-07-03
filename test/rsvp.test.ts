// ============================================================
// Public RSVP form — EDM-block-driven, multilingual, published-data-only.
//
// Drives the Worker directly with a fake PUBLISHED_DB (the published D1's
// `live_pages`) and a global fetch stub standing in for the F1 API. GET
// requests must be satisfied ENTIRELY from the published DB; only the POST
// submit may call the CMS (interim draft update, authenticated as the events
// plugin).
// ============================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signPayload } from '../src/crypto';
import worker from '../src/index';

interface Env {
  CMS_URL?: string;
  EVENTS_PLUGIN_SECRET?: string;
  CHECKIN_BASE_URL?: string;
  PUBLISHED_DB?: D1Database;
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

interface SeedPage {
  id: number;
  page_type: string;
  name?: string;
  slug?: string;
  page_id?: number | null;
  lect?: Record<string, unknown>;
}

/** Fake published D1: answers the parameterized SELECTs in src/published.ts. */
function publishedDb(pages: SeedPage[]): D1Database {
  const rows = pages.map(({ lect, ...page }) => ({
    uuid: `uuid-${page.id}`,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    name: '',
    slug: `page-${page.id}`,
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_id: null,
    ...page,
    lect: JSON.stringify(lect ?? {}),
  }));
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const matched = sql.includes('page_type = ? AND slug = ?')
            ? rows.filter((row) => row.page_type === values[0] && row.slug === values[1])
            : sql.includes('WHERE page_type = ?')
              ? rows.filter((row) => row.page_type === values[0])
            : rows.filter((row) => values.includes(row.id));
          return {
            async first() { return matched[0] ?? null; },
            async all() { return { results: matched }; },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const SECRET = 'events-secret';

function env(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    VIEWS: views(),
    CMS_URL: 'https://cms.test',
    EVENTS_PLUGIN_SECRET: SECRET,
    CHECKIN_BASE_URL: 'https://checkin.test',
    PUBLISHED_DB: db,
    ...overrides,
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://rsvp.test${path}`, init);
}

/** Event 7 with sessions, list 8 pointing at EDM 30, guest 9, EDM 30 with rsvp blocks. */
function seed(overrides: { guestLect?: Record<string, unknown>; listLect?: Record<string, unknown> } = {}): SeedPage[] {
  return [
    {
      id: 7,
      page_type: 'event',
      name: 'Launch',
      slug: 'launch-night',
      lect: {
        name: { en: 'Launch Night', 'zh-hant': '啟動之夜' },
        session: [
          { name: { en: 'Morning keynote' }, start: '2026-08-01 09:00', location: { en: 'Hall A' } },
          { name: { en: 'Evening gala' }, start: '2026-08-01 19:00', location: { en: 'Ballroom' } },
        ],
      },
    },
    { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7', edm: '30' }, ...(overrides.listLect ?? {}) } },
    {
      id: 9,
      page_type: 'guest',
      name: 'Ada Lovelace',
      page_id: 8,
      lect: { plus_guests: '0', response: [{}], ...(overrides.guestLect ?? {}) },
    },
    {
      id: 30,
      page_type: 'edm',
      name: 'Invite',
      slug: 'invite',
      lect: {
        _pointers: { event: '7' },
        subject: { en: 'You are invited', 'zh-hant': '誠邀您出席' },
        heading: { en: 'Dear {{name}}', 'zh-hant': '親愛的 {{name}}' },
        body: { en: '<p>Join us at Launch Night.</p>' },
        rsvp_form_button: { en: 'Count me in' },
        _blocks: [
          { _type: 'paragraph', subject: { en: 'Programme' }, body: { en: '<p>Doors open 18:00.</p>' } },
          {
            _type: 'rsvp-meal-preferences',
            title: { en: 'Meal preference', 'zh-hant': '餐飲選擇' },
            allow_message: 'yes',
            food: [
              { name: { en: 'Chicken', 'zh-hant': '雞肉' }, description: { en: 'Roasted' } },
              { name: { en: 'Vegetarian' }, description: {} },
            ],
          },
          { _type: 'rsvp-plus-one', max_guests: '2', title: { en: 'Bring a guest' } },
          {
            _type: 'rsvp-custom',
            title: { en: 'A few questions' },
            custom_input: [
              { label: { en: 'Dietary Notes' }, type: 'textarea', required: 'no' },
              { label: { en: 'Shuttle Bus' }, type: 'select', default_value: 'yes:Yes please|no:No thanks' },
            ],
          },
          {
            _type: 'rsvp-public-form',
            title: { en: 'Register' },
            body: { en: '<p>Tell us who you are.</p>' },
            label_salutation: { en: 'Title' },
            label_first_name: { en: 'First name' },
            label_last_name: { en: 'Last name' },
            label_email: { en: 'Email' },
            label_organization: { en: 'Company' },
            label_job_title: { en: 'Role' },
            custom_input: [
              { name: 'source', label: { en: 'How did you hear about us?' }, type: 'text' },
            ],
          },
          { _type: 'rsvp-sessions', title: { en: 'Sessions' } },
          { _type: 'rsvp-qrcode', title: { en: 'Your pass' }, message: { en: 'Scan at the door' }, size: '200' },
          { _type: 'picture', picture: '/media/pictures/invite.jpg', caption: { en: 'Invite artwork' } },
        ],
      },
    },
  ];
}

function pageIdOnlyEdmSeed(): SeedPage[] {
  const pages = seed();
  const edm = pages.find((page) => page.id === 30);
  if (edm) {
    edm.page_id = 7;
    edm.lect = { ...(edm.lect ?? {}), _pointers: {} };
  }
  return pages;
}

function defaultPublicFormSeed(): SeedPage[] {
  const pages = seed();
  const edm = pages.find((page) => page.id === 30);
  const lect = edm?.lect;
  if (edm && lect && Array.isArray(lect._blocks)) {
    edm.lect = {
      ...lect,
      _blocks: lect._blocks.filter((block) => (block as Record<string, unknown>)._type !== 'rsvp-public-form'),
    };
  }
  return pages;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signedPath(prefix = ''): Promise<string> {
  return `${prefix}/rsvp/7/8/9/${await signPayload(SECRET, 'rsvp:7:8:9')}`;
}

function noCmsFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('public GET must not call the CMS'); }));
}

describe('public RSVP form (EDM-driven, published data)', () => {
  it('lists published events and public registration links on the homepage', async () => {
    noCmsFetch();

    const response = await site.fetch(request('/'), env(publishedDb(seed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Published events');
    expect(html).toContain('Launch Night');
    expect(html).toContain('event id: 7');
    expect(html).toContain('event slug: launch-night');
    expect(html).toContain('edm id: 30');
    expect(html).toContain('edm slug: invite');
    expect(html).toContain('edm pointer: 7');
    expect(html).toContain('href="/en/rsvp/launch-night/invite/new"');
  });

  it('lists EDMs attached to events by parent page_id', async () => {
    noCmsFetch();

    const response = await site.fetch(request('/'), env(publishedDb(pageIdOnlyEdmSeed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('edm id: 30');
    expect(html).toContain('edm slug: invite');
    expect(html).toContain('edm parent: 7');
    expect(html).toContain('href="/en/rsvp/launch-night/invite/new"');
  });

  it('renders the EDM blocks as a form, reading only the published DB', async () => {
    noCmsFetch();

    const response = await site.fetch(request(await signedPath()), env(publishedDb(seed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    // Personalized heading + EDM content
    expect(html).toContain('Dear Ada Lovelace');
    expect(html).toContain('Doors open 18:00.');
    // Meal radios (block index 1 → field meal-1-food) + optional message
    expect(html).toContain('name="meal-1-food"');
    expect(html).toContain('value="Chicken"');
    expect(html).toContain('name="meal-1-message"');
    // Plus-one rows with per-guest nested meal blocks (legacy field scheme)
    expect(html).toContain('name="rsvp-plus-one-1:name"');
    expect(html).toContain('name="rsvp-plus-one-2:organization"');
    expect(html).toContain('name="rsvp-plus-one-2:meal-1-food"');
    // Custom inputs (label-slug field names) incl. select options
    expect(html).toContain('name="rsvp-custom-dietary-notes"');
    expect(html).toContain('name="rsvp-custom-shuttle-bus"');
    expect(html).toContain('No thanks');
    // Sessions from the EVENT page
    expect(html).toContain('name="session-0"');
    expect(html).toContain('Evening gala');
    // Check-in QR block, linking to the checkin site
    expect(html).toContain('Scan at the door');
    expect(html).toContain('<svg');
    // EDM-configured accept button
    expect(html).toContain('Count me in');
    expect(html).toContain('src="https://cms.test/media/pictures/invite.jpg"');
  });

  it('applies security headers to every response', async () => {
    noCmsFetch();
    const response = await site.fetch(request('/nope'), env(publishedDb([])));
    expect(response.status).toBe(404);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('localizes via the URL language prefix (legacy /:language/rsvp/…)', async () => {
    noCmsFetch();

    const response = await site.fetch(request(await signedPath('/zh-hant')), env(publishedDb(seed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('親愛的 Ada Lovelace');
    expect(html).toContain('餐飲選擇');
    expect(html).toContain('value="雞肉"');
    // Language switcher keeps the signed path
    expect(html).toContain('href="/en/rsvp/7/8/9/');
  });

  it('falls back to the guest prefer_language when the URL has no prefix', async () => {
    noCmsFetch();

    const db = publishedDb(seed({ guestLect: { plus_guests: '0', response: [{}], prefer_language: 'zh-hant' } }));
    const response = await site.fetch(request(await signedPath()), env(db));
    const html = await response.text();

    expect(html).toContain('親愛的 Ada Lovelace');
  });

  it('lets ?edm= choose the form when the list has no EDM pointer', async () => {
    noCmsFetch();

    const pages = seed();
    pages[1] = { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } };
    const response = await site.fetch(request(`${await signedPath()}?edm=30`), env(publishedDb(pages)));
    const html = await response.text();

    expect(html).toContain('name="meal-1-food"');
    // Form posts back to the same signed URL including the edm selector
    expect(html).toContain('?edm=30"');
  });

  it('renders a slug-based public registration form without touching the CMS', async () => {
    noCmsFetch();

    const response = await site.fetch(request('/en/rsvp/launch-night/invite/new'), env(publishedDb(seed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Tell us who you are.');
    expect(html).toContain('name="first_name"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="rsvp-public-source"');
    expect(html).toContain('name="meal-1-food"');
    expect(html).not.toContain('Scan at the door');
    expect(html).not.toContain('Decline');
    expect(html).not.toContain('<nav class="langs">');
    expect(html).toContain('src="https://cms.test/media/pictures/invite.jpg"');
  });

  it('renders public registration when event and EDM refs are ids or slugs', async () => {
    noCmsFetch();

    const byIds = await site.fetch(request('/en/rsvp/7/30/new'), env(publishedDb(seed())));
    expect(byIds.status).toBe(200);
    expect(await byIds.text()).toContain('Tell us who you are.');

    const mixed = await site.fetch(request('/en/rsvp/7/invite/new'), env(publishedDb(seed())));
    expect(mixed.status).toBe(200);
    expect(await mixed.text()).toContain('Tell us who you are.');
  });

  it('renders the legacy public registration route without /new', async () => {
    noCmsFetch();

    const response = await site.fetch(request('/en/rsvp/launch-night/invite'), env(publishedDb(seed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Tell us who you are.');
    expect(html).not.toContain('<nav class="langs">');
  });

  it('renders the default legacy new-guest fields when the EDM has no public-form block', async () => {
    noCmsFetch();

    const response = await site.fetch(request('/en/rsvp/launch-night/invite'), env(publishedDb(defaultPublicFormSeed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<label for="salutation">Salutation *</label>');
    expect(html).toContain('<option value="">Please Select</option>');
    expect(html).toContain('<label for="first_name">First Name *</label>');
    expect(html).toContain('<label for="last_name">Last Name *</label>');
    expect(html).toContain('<label for="company">Company / Organization</label>');
    expect(html).toContain('<label for="job_title">Position</label>');
    expect(html).toContain('<label for="email">Email *</label>');
  });

  it('renders public registration when the EDM is attached by parent page_id', async () => {
    noCmsFetch();

    const response = await site.fetch(request('/en/rsvp/launch-night/invite/new'), env(publishedDb(pageIdOnlyEdmSeed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Tell us who you are.');
  });

  it('renders the legacy EDM preview route without a signature', async () => {
    noCmsFetch();

    const response = await site.fetch(request('/rsvp/launch-night/30/preview'), env(publishedDb(seed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Preview of RSVP form: Invite');
    expect(html).toContain('Dear Guest');
    expect(html).toContain('name="meal-1-food"');
    expect(html).toContain('action="#"');
    expect(html).not.toContain('Scan at the door');
    expect(html).not.toContain('<nav class="langs">');
  });

  it('renders the legacy EDM preview route when event and EDM refs are ids or slugs', async () => {
    noCmsFetch();

    const byIds = await site.fetch(request('/rsvp/7/30/preview'), env(publishedDb(seed())));
    expect(byIds.status).toBe(200);
    expect(await byIds.text()).toContain('Preview of RSVP form: Invite');

    const mixed = await site.fetch(request('/rsvp/7/invite/preview'), env(publishedDb(seed())));
    expect(mixed.status).toBe(200);
    expect(await mixed.text()).toContain('Preview of RSVP form: Invite');

    const bySlugs = await site.fetch(request('/rsvp/launch-night/invite/preview'), env(publishedDb(seed())));
    expect(bySlugs.status).toBe(200);
    expect(await bySlugs.text()).toContain('Preview of RSVP form: Invite');
  });

  it('localizes the legacy EDM preview route', async () => {
    noCmsFetch();

    const response = await site.fetch(request('/zh-hant/rsvp/launch-night/30/preview'), env(publishedDb(seed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('親愛的 Guest');
    expect(html).toContain('餐飲選擇');
  });

  it('renders the plain fallback form when no valid EDM resolves', async () => {
    noCmsFetch();

    const pages = seed().filter((page) => page.id !== 30);
    pages[1] = { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } };
    const response = await site.fetch(request(await signedPath()), env(publishedDb(pages)));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('name="plus_guests"');
    expect(html).not.toContain('meal-1-food');
  });

  it('404s on a bad signature and when the guest page is not published', async () => {
    noCmsFetch();

    const badSig = await site.fetch(request('/rsvp/7/8/9/deadbeef'), env(publishedDb(seed())));
    expect(badSig.status).toBe(404);

    const pages = seed().filter((page) => page.id !== 9);
    const unpublished = await site.fetch(request(await signedPath()), env(publishedDb(pages)));
    expect(unpublished.status).toBe(404);
  });

  it('redirects an already-responded guest to thank-you unless refills are allowed', async () => {
    noCmsFetch();

    const responded = { plus_guests: '0', response: [{ status: 'confirmed', date: '2026-06-01', message: '' }] };
    const redirected = await site.fetch(
      request(await signedPath('/zh-hant')),
      env(publishedDb(seed({ guestLect: responded }))),
    );
    expect(redirected.status).toBe(303);
    expect(redirected.headers.get('location')).toContain('/zh-hant/rsvp/thank-you?status=confirmed');

    const refillable = await site.fetch(
      request(await signedPath()),
      env(publishedDb(seed({ guestLect: { ...responded, allow_refill: '1' } }))),
    );
    expect(refillable.status).toBe(200);
  });

  it('submits via the F1 API as the events plugin, counting named plus guests', async () => {
    let updateBody: Record<string, unknown> | undefined;
    let updateHeaders: Headers | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/9' && init?.method === 'PUT') {
        updateBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        updateHeaders = new Headers(init.headers);
        return Response.json({ page: { id: 9 } });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await site.fetch(request(await signedPath(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'status': 'confirmed',
        'rsvp-plus-one-1:name': 'Grace Hopper',
        'rsvp-plus-one-1:organization': 'Navy',
        'rsvp-plus-one-2:name': '',
        'meal-1-food': 'Chicken',
      }),
    }), env(publishedDb(seed())));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/rsvp/thank-you?status=confirmed');
    expect(updateBody).toMatchObject({ lect: { status: 'confirmed', plus_guests: '1' } });
    expect(updateHeaders?.get('x-plugin-id')).toBe('events');
    expect(updateHeaders?.get('x-plugin-secret')).toBe(SECRET);
  });

  it('registers a public slug-form submit as an adhoc guest', async () => {
    let createBody: Record<string, unknown> | undefined;
    let createHeaders: Headers | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages' && init?.method === 'GET') {
        expect(url.searchParams.get('page_type')).toBe('mail_list');
        expect(url.searchParams.get('pointer_key')).toBe('event');
        expect(url.searchParams.get('pointer_value')).toBe('7');
        return Response.json({
          pages: [{
            id: 80,
            page_type: 'mail_list',
            name: 'Adhoc',
            slug: 'adhoc',
            page_id: null,
            lect: { _pointers: { event: '7' } },
          }],
          total: 1,
        });
      }
      if (url.pathname === '/__cms/pages' && init?.method === 'POST') {
        createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        createHeaders = new Headers(init.headers);
        return Response.json({ page: { id: 81 } });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await site.fetch(request('/en/rsvp/launch-night/invite/new', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        status: 'confirmed',
        first_name: 'Grace',
        last_name: 'Hopper',
        email: 'grace@example.com',
        prefix: 'dr',
        company: 'Navy',
        job_title: 'Rear Admiral',
        'rsvp-public-source': 'Friend',
        'rsvp-plus-one-1:name': 'Ada',
      }),
    }), env(publishedDb(seed())));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/en/rsvp/thank-you?status=confirmed');
    expect(createBody).toMatchObject({
      page_type: 'guest',
      page_id: 80,
      name: 'Grace Hopper',
      lect: {
        prefix: 'dr',
        salutation: 'dr',
        email: 'grace@example.com',
        organization: 'Navy',
        job_title: 'Rear Admiral',
        plus_guests: '1',
        status: 'confirmed',
        type: 'adhoc',
        _pointers: { event: '7', mail_list: '80' },
        public_registration: { 'rsvp-public-source': 'Friend', 'rsvp-plus-one-1:name': 'Ada' },
      },
    });
    expect(createHeaders?.get('x-plugin-id')).toBe('events');
    expect(createHeaders?.get('x-plugin-secret')).toBe(SECRET);
  });
});

describe('EDM unsubscribe', () => {
  async function unsubPath(): Promise<string> {
    return `/unsubscribe/8/9/${await signPayload(SECRET, 'unsub:8:9')}`;
  }

  it('shows a confirm page for a valid signed link (published guest only)', async () => {
    noCmsFetch();
    const db = publishedDb(seed({ guestLect: { plus_guests: '0', response: [{}], email: 'ada@example.com' } }));
    const response = await site.fetch(request(await unsubPath()), env(db));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Unsubscribe');
    expect(html).toContain('a***@example.com');
    expect(html).toContain(`action="${await unsubPath()}"`);
  });

  it('404s on a bad signature', async () => {
    noCmsFetch();
    const response = await site.fetch(request('/unsubscribe/8/9/deadbeef'), env(publishedDb(seed())));
    expect(response.status).toBe(404);
  });

  it('sets not_send over F1 on confirm', async () => {
    let updateBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/9' && init?.method === 'PUT') {
        updateBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ page: { id: 9 } });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await site.fetch(request(await unsubPath(), { method: 'POST' }), env(publishedDb(seed())));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("You're unsubscribed");
    expect(updateBody).toMatchObject({ lect: { not_send: '1' } });
  });

  it('skips the write when the guest already opted out', async () => {
    noCmsFetch();
    const db = publishedDb(seed({ guestLect: { plus_guests: '0', response: [{}], not_send: '1' } }));
    const response = await site.fetch(request(await unsubPath(), { method: 'POST' }), env(db));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("You're unsubscribed");
  });
});
