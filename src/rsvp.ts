// ============================================================
// Public RSVP form — the whole site.
//
// Reads ONLY published content: the event / mail_list / guest / edm pages come
// from the CMS's published D1 (`live_pages`, see src/published.ts) — unpublished
// content is simply not visible here. The form itself is built from the Event's
// shared RSVP blocks followed by the EDM's `rsvp-*` content blocks (meal
// preferences, plus-one, travel/hotel, pickup, custom inputs, …), localized per
// the legacy Eventuai multilingual routes
// (`/:language/rsvp/...`, mis/en/zh-hant/zh-hans).
//
// Links are minted and HMAC-signed by cms-plugin-events (its PUBLIC_BASE_URL
// points at this Worker); EVENTS_SIGN_KEY here is a copy of that plugin's
// public-token signKey (the tenant record's `signKey` — NOT the pairwise
// CMS↔plugin secret), used to verify them. The EDM that defines the form is
// picked from the
// link's `?edm=` parameter or, failing that, the guest list's `edm` pointer.
// Without a valid EDM the plain status/plus-guests fallback form renders
// instead, so pre-EDM links keep working.
//
// Response storage (decided 2026-07-07, cms-to-rsvp.md §9.2 B.1): submits and
// self-registrations are stored as INSERT-only rows in the published D1
// (rsvp_response / rsvp_registration — see src/submissions.ts for the
// ownership contract that keeps CMS republishes from ever overwriting them).
// worker-cms ingests the rows into its draft DB on a cron and fires create
// hooks; cms-plugin-events applies responses to guest pages from there. This
// Worker no longer writes to the CMS on the submit path at all.
// ============================================================

import { attr, blocks, items, localized, pointer, type CmsPage } from './cms';
import {
  collectAnswers,
  insertRegistration,
  insertResponse,
  latestResponse,
} from './submissions';
import { signPayload, verifyPayload } from './crypto';
import { getPublishedPage, getPublishedPageBySlug, getPublishedPages, type PublishedEnv } from './published';
import { qrSvg } from './qr';
import { renderLiquid } from './templates/liquid';
import { applyTemplateTokens, defaultGuestTokens, guestTokens, safeHtml } from './tokens';

export interface RsvpEnv extends PublishedEnv {
  /** Copy of cms-plugin-events' public-token signKey (tenant `signKey`, or its
   *  SIGN_KEY/PLUGIN_SECRET fallback in single-tenant installs) — verifies the
   *  signed RSVP/unsubscribe links and mints check-in QR signatures. */
  EVENTS_SIGN_KEY?: string;
  /** Pairwise CMS↔events-plugin secret — used ONLY by the unsubscribe
   *  write-back (src/unsubscribe.ts) to authenticate against the Plugin API. */
  EVENTS_PLUGIN_SECRET?: string;
  /** Base URL of the CMS Worker — used only by the unsubscribe write-back (src/unsubscribe.ts). */
  CMS_URL?: string;
  /** Public origin serving /checkin/… QR links (cms-plugin-checkin). */
  CHECKIN_BASE_URL?: string;
  VIEWS: Fetcher;
}

export const RSVP_LANGUAGES = ['mis', 'en', 'zh-hant', 'zh-hans'];

const RESPONSES = new Set(['confirmed', 'declined']);
const DEFAULT_LANGUAGE = 'en';

export async function handleRsvp(request: Request, env: RsvpEnv, url: URL): Promise<Response | null> {
  const path = url.pathname.split('/').filter(Boolean);
  const urlLanguage = RSVP_LANGUAGES.includes(path[0]) ? path[0] : '';
  if (urlLanguage) path.shift();
  if (path[0] !== 'rsvp') return null;
  if (path[1] === 'thank-you') return thankYou(env.VIEWS, url.searchParams.get('status') ?? 'confirmed');
  if (path[3] === 'preview') {
    return previewRsvp(env, url, {
      eventRef: path[1] ?? '',
      edmRef: path[2] ?? '',
      language: urlLanguage || DEFAULT_LANGUAGE,
    });
  }
  if (path[3] === 'new') {
    return publicRegistration(request, env, url, {
      eventRef: path[1] ?? '',
      edmRef: path[2] ?? '',
      language: urlLanguage || DEFAULT_LANGUAGE,
      languagePrefix: urlLanguage ? `/${urlLanguage}` : '',
    });
  }
  if (path.length === 3 && path[1] && path[2]) {
    return publicRegistration(request, env, url, {
      eventRef: path[1],
      edmRef: path[2],
      language: urlLanguage || DEFAULT_LANGUAGE,
      languagePrefix: urlLanguage ? `/${urlLanguage}` : '',
    });
  }

  const eventId = pageId(path[1]);
  const listId = pageId(path[2]);
  const guestId = pageId(path[3]);
  const signature = path[4] ?? '';
  if (!eventId || !listId || !guestId || !signature || !env.EVENTS_SIGN_KEY) return new Response('not found', { status: 404 });
  const payload = `rsvp:${eventId}:${listId}:${guestId}`;
  if (!(await verifyPayload(env.EVENTS_SIGN_KEY, payload, signature))) return new Response('not found', { status: 404 });

  // Published data only — no draft/Plugin API reads on the public GET path.
  if (!env.PUBLISHED_DB) return new Response('server misconfigured', { status: 500 });
  const pages = await getPublishedPages(env.PUBLISHED_DB, [eventId, listId, guestId]);
  const event = pages.get(eventId);
  const list = pages.get(listId);
  const guest = pages.get(guestId);
  if (!event || !list || !guest || !validContext(event, list, guest, eventId, listId)) {
    return new Response('not found', { status: 404 });
  }

  const preferred = attr(guest.lect, 'prefer_language').toLowerCase();
  const language = urlLanguage || (RSVP_LANGUAGES.includes(preferred) ? preferred : '') || DEFAULT_LANGUAGE;
  const languagePrefix = urlLanguage ? `/${urlLanguage}` : '';
  const edm = await resolveEdm(env.PUBLISHED_DB, url, list, eventId);

  // A guest-specific confirmation stays on the signed RSVP URL so the QR
  // cannot be guessed from the generic /rsvp/thank-you route. The stored
  // response decides the displayed status; a forged query parameter alone
  // cannot create a confirmation screen.
  const responded = await respondedStatus(env.PUBLISHED_DB, guest);
  if (url.searchParams.has('thank-you') && responded) {
    return guestThankYou(env, edm, language, responded);
  }

  if (request.method === 'POST') return submitRsvp(request, env, url, guest, eventId, listId, language, languagePrefix);

  // Already responded → straight to thank-you, unless the guest allows refills.
  // Response rows are the source of truth (the published guest row only picks
  // up a response after ingest + republish); the guest lect is the fallback.
  if (responded && !allowRefill(guest)) {
    return guestThankYouRedirect(url, responded);
  }

  return rsvpForm(env, url, { event, list, guest, edm, eventId, listId, language });
}

// ── EDM resolution ─────────────────────────────────────────────────────────────

/**
 * The EDM whose `rsvp-*` blocks define this form: the link's `?edm=` (every
 * emailed RSVP link carries the sending EDM) or the list's assigned `edm`
 * pointer. Either way it must be a published `edm` page of this event.
 */
async function resolveEdm(db: D1Database, url: URL, list: CmsPage, eventId: number): Promise<CmsPage | null> {
  for (const candidate of [pageId(url.searchParams.get('edm')), pageId(pointer(list.lect, 'edm'))]) {
    if (!candidate) continue;
    const edm = await getPublishedPage(db, candidate);
    if (edm && edm.page_type === 'edm' && edmBelongsToEvent(edm, eventId)) return edm;
  }
  return null;
}

// ── Form rendering ─────────────────────────────────────────────────────────────

interface FormContext {
  event: CmsPage;
  list: CmsPage;
  guest: CmsPage;
  edm: CmsPage | null;
  eventId: number;
  listId: number;
  language: string;
}

async function rsvpForm(env: RsvpEnv, url: URL, context: FormContext): Promise<Response> {
  const { event, list, guest, edm, listId, language } = context;

  // Personalization tokens ({{name}}, {{salutation}}, …), legacy ControllerRSVP.parse.
  const tokens = guestTokens(guest);
  const personalize = (value: string): string => (value ? applyTemplateTokens(value, tokens) : value);

  const action = url.pathname + (url.searchParams.get('edm') ? `?edm=${encodeURIComponent(url.searchParams.get('edm')!)}` : '');
  const openedFromEdm = !!url.searchParams.get('edm');
  const edmLect = edm?.lect ?? {};
  const formBlocks = edm ? await formBlockVMs(env, edm, event, guest, listId, language, personalize) : [];
  const meals = formBlocks.filter((block) => block.type === 'rsvp-meal-preferences');

  const html = await renderLiquid(env.VIEWS, '/templates/public-rsvp.liquid', {
    language,
    action,
    hasEdm: !!edm,
    eventName: localized(event.lect, 'name', language) || event.name,
    listName: list.name,
    guestName: personalize('{{prefer_name||name}}') || guest.name,
    status: attr(guest.lect, 'status'),
    plusGuests: attr(guest.lect, 'plus_guests') || '0',
    subject: personalize(localized(edmLect, 'subject', language)),
    heading: personalize(localized(edmLect, 'heading', language)),
    bodyHtml: personalize(safeHtml(localized(edmLect, 'body', language))),
    acceptLabel: localized(edmLect, 'rsvp_form_button', language)
      || localized(edmLect, 'rsvp_button', language)
      || 'Accept',
    blocks: formBlocks,
    meals,
    hasMeals: meals.length > 0,
    showEventLabel: !openedFromEdm,
    showLanguageSelector: !openedFromEdm,
    languages: RSVP_LANGUAGES
      .filter((code) => code !== 'mis')
      .map((code) => ({
        code,
        label: code === 'zh-hant' ? '繁體中文' : code === 'zh-hans' ? '简体中文' : 'English',
        href: `/${code}${stripLanguagePrefix(url.pathname)}${url.search}`,
        active: code === language,
      })),
  });
  return htmlResponse(html);
}

interface PublicRegistrationRoute {
  eventRef: string;
  edmRef: string;
  language: string;
  languagePrefix: string;
}

interface PreviewRoute {
  eventRef: string;
  edmRef: string;
  language: string;
}

async function previewRsvp(env: RsvpEnv, url: URL, route: PreviewRoute): Promise<Response> {
  if (!env.PUBLISHED_DB) return new Response('server misconfigured', { status: 500 });
  const [event, edm] = await Promise.all([
    getPublishedPageByRef(env.PUBLISHED_DB, 'event', route.eventRef),
    getPublishedPageByRef(env.PUBLISHED_DB, 'edm', route.edmRef),
  ]);
  if (!event || !edm || !edmBelongsToEvent(edm, event.id)) {
    return new Response('not found', { status: 404 });
  }

  const html = await previewRsvpForm(env, url, event, edm, route.language);
  return htmlResponse(html);
}

async function previewRsvpForm(
  env: RsvpEnv,
  url: URL,
  event: CmsPage,
  edm: CmsPage,
  language: string,
): Promise<string> {
  const guest = previewGuest();
  const tokens = guestTokens(guest);
  const personalize = (value: string): string => (value ? applyTemplateTokens(value, tokens) : value);
  const edmLect = edm.lect ?? {};
  const formBlocks = await formBlockVMs(env, edm, event, guest, 0, language, personalize, { preview: true });
  const meals = formBlocks.filter((block) => block.type === 'rsvp-meal-preferences');

  return renderLiquid(env.VIEWS, '/templates/public-rsvp.liquid', {
    language,
    action: '#',
    hasEdm: true,
    eventName: localized(event.lect, 'name', language) || event.name,
    listName: '',
    guestName: guest.name,
    status: '',
    plusGuests: '0',
    subject: personalize(localized(edmLect, 'subject', language)),
    heading: personalize(localized(edmLect, 'heading', language)),
    bodyHtml: personalize(safeHtml(localized(edmLect, 'body', language))),
    acceptLabel: localized(edmLect, 'rsvp_form_button', language)
      || localized(edmLect, 'rsvp_button', language)
      || 'Accept',
    blocks: formBlocks,
    meals,
    hasMeals: meals.length > 0,
    preview: true,
    previewName: edm.name,
    registrationHref: url.pathname.replace(/\/preview\/?$/, ''),
    showEventLabel: false,
    showLanguageSelector: false,
  });
}

async function publicRegistration(
  request: Request,
  env: RsvpEnv,
  url: URL,
  route: PublicRegistrationRoute,
): Promise<Response> {
  if (!env.PUBLISHED_DB) return new Response('server misconfigured', { status: 500 });
  const [event, edm] = await Promise.all([
    getPublishedPageByRef(env.PUBLISHED_DB, 'event', route.eventRef),
    getPublishedPageByRef(env.PUBLISHED_DB, 'edm', route.edmRef),
  ]);
  if (!event || !edm || !edmBelongsToEvent(edm, event.id)) return new Response('not found', { status: 404 });

  if (request.method === 'POST') return submitPublicRegistration(request, env, url, event, edm, route.language, route.languagePrefix);

  const html = await publicRegistrationForm(env, url, event, edm, route.language);
  return htmlResponse(html);
}

async function publicRegistrationForm(
  env: RsvpEnv,
  url: URL,
  event: CmsPage,
  edm: CmsPage,
  language: string,
): Promise<string> {
  const edmLect = edm.lect ?? {};
  const tokens = defaultGuestTokens(language);
  const personalize = (value: string): string => (value ? applyTemplateTokens(value, tokens) : value);
  const formBlocks = await formBlockVMs(env, edm, event, null, 0, language, personalize, { publicRegistration: true });
  const publicFormBlock = formBlocks.find((block) => block.type === 'rsvp-public-form') ?? null;
  const edmBlocks = formBlocks.filter((block) => block.type !== 'rsvp-public-form');
  const meals = formBlocks.filter((block) => block.type === 'rsvp-meal-preferences');

  return renderLiquid(env.VIEWS, '/templates/public-rsvp.liquid', {
    language,
    action: url.pathname,
    hasEdm: true,
    eventName: localized(event.lect, 'name', language) || event.name,
    listName: '',
    guestName: '',
    status: '',
    plusGuests: '0',
    subject: personalize(localized(edmLect, 'subject', language)),
    heading: personalize(localized(edmLect, 'heading', language)),
    bodyHtml: personalize(safeHtml(localized(edmLect, 'body', language))),
    acceptLabel: localized(edmLect, 'rsvp_form_button', language)
      || localized(edmLect, 'rsvp_button', language)
      || 'Register',
    blocks: edmBlocks,
    publicFormBlock,
    meals,
    hasMeals: meals.length > 0,
    hideDecline: true,
    showEventLabel: false,
    showLanguageSelector: false,
  });
}

function stripLanguagePrefix(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (RSVP_LANGUAGES.includes(segments[0])) segments.shift();
  return `/${segments.join('/')}`;
}

/**
 * Projects the Event's shared RSVP blocks and the EDM's content blocks into
 * the flat shapes the form template renders. Event blocks come first; EDM
 * blocks then add invitation-specific content. Rich-text fields are sanitised
 * through safeHtml; everything else is escaped in the templates.
 */
async function formBlockVMs(
  env: RsvpEnv,
  edm: CmsPage,
  event: CmsPage,
  guest: CmsPage | null,
  listId: number,
  language: string,
  personalize: (value: string) => string,
  options: { publicRegistration?: boolean; preview?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  const vms: Array<Record<string, unknown>> = [];
  let hasPublicRegistrationForm = false;
  const eventRsvpTypes = new Set([
    'rsvp-meal-preferences',
    'rsvp-travel-hotel',
    'rsvp-plus-one',
    'rsvp-custom',
  ]);
  const sourceBlocks = [
    ...blocks(event.lect)
      .map((block, index) => ({ block, index, source: 'event' }))
      .filter(({ block }) => eventRsvpTypes.has(attr(block, '_type'))),
    ...blocks(edm.lect).map((block, index) => ({ block, index, source: 'edm' })),
  ];

  for (const { block, index, source } of sourceBlocks) {
    const type = attr(block, '_type');
    const key = source === 'event'
      ? `event-${attr(block, '_id') || String(index)}`
      : attr(block, '_id') || String(index);
    const title = personalize(localized(block, 'title', language));
    const bodyHtml = personalize(safeHtml(localized(block, 'body', language)));

    switch (type) {
      case 'picture': {
        const src = assetUrl(env.CMS_URL, localized(block, 'picture', language) || attr(block, 'picture'));
        if (src) {
          vms.push({
            type,
            src,
            caption: localized(block, 'caption', language) || attr(block, 'caption'),
            width: attr(block, 'width'),
            align: attr(block, 'align'),
          });
        }
        break;
      }
      case 'paragraph':
        vms.push({ type, subject: personalize(localized(block, 'subject', language)), bodyHtml });
        break;
      case 'table':
        vms.push({
          type,
          titleHtml: safeHtml(localized(block, 'title', language)),
          rows: items(block, 'row').map((row) => ({
            nameHtml: safeHtml(localized(row, 'name', language)),
            descriptionHtml: safeHtml(localized(row, 'description', language)),
          })),
        });
        break;
      case 'button':
        vms.push({
          type,
          label: localized(block, 'label', language) || attr(block, 'label'),
          url: localized(block, 'url', language) || attr(block, 'url'),
        });
        break;
      case 'spacer':
        vms.push({ type, lines: Math.max(1, Number.parseInt(attr(block, 'lines'), 10) || 1) });
        break;
      case 'rsvp-location':
        vms.push({
          type,
          name: localized(block, 'name', language),
          lines: ['address_1', 'address_2', 'address_3']
            .map((field) => localized(block, field, language))
            .concat([[localized(block, 'city', language), localized(block, 'state', language), localized(block, 'country', language)]
              .filter(Boolean).join(', ')])
            .filter(Boolean),
        });
        break;
      case 'rsvp-date-time':
        vms.push({
          type,
          dateText: localized(block, 'date_text', language),
          time: localized(block, 'time', language),
          timezone: attr(block, 'timezone'),
        });
        break;
      case 'rsvp-meal-preferences':
        vms.push({
          type,
          key: `meal-${key}`,
          title,
          bodyHtml,
          allowMessage: truthy(attr(block, 'allow_message')),
          messagePlaceholder: localized(block, 'message_placeholder', language)
            || 'Please let us know if you have any special dietary requirements.',
          food: items(block, 'food').map((row) => ({
            name: localized(row, 'name', language),
            description: localized(row, 'description', language),
          })).filter((row) => row.name),
        });
        break;
      case 'rsvp-plus-one': {
        const maxGuests = Math.max(0, Number.parseInt(attr(block, 'max_guests'), 10) || 0);
        vms.push({ type, title, bodyHtml, maxGuests, hasGuests: maxGuests > 0 });
        break;
      }
      case 'rsvp-custom':
        vms.push({ type, title, bodyHtml, inputs: customInputVMs(block, 'custom_input', 'rsvp-custom-', language) });
        break;
      case 'rsvp-public-form':
        if (options.publicRegistration) {
          hasPublicRegistrationForm = true;
          vms.push({
            type,
            title,
            bodyHtml,
            salutationLabel: localized(block, 'label_salutation', language) || 'Salutation',
            salutationSelectLabel: localized(block, 'label_select', language) || 'Please Select',
            firstNameLabel: localized(block, 'label_first_name', language) || 'First Name',
            lastNameLabel: localized(block, 'label_last_name', language) || 'Last Name',
            emailLabel: localized(block, 'label_email', language) || 'Email',
            organizationLabel: localized(block, 'label_organization', language) || 'Company / Organization',
            jobTitleLabel: localized(block, 'label_job_title', language) || 'Position',
            inputs: customInputVMs(block, 'custom_input', 'rsvp-public-', language),
          });
        }
        break;
      case 'rsvp-travel-hotel':
        vms.push({
          type,
          title,
          bodyHtml,
          flightInputs: customInputVMs(block, 'flight_custom_input', 'rsvp-travel-hotel-flight-', language),
          hotelInputs: customInputVMs(block, 'hotel_custom_input', 'rsvp-travel-hotel-', language),
        });
        break;
      case 'rsvp-pickup':
        vms.push({
          type,
          title: title || 'Pickup Service',
          pickupDateLabel: localized(block, 'pickup_date_label', language) || 'Pickup Date',
          pickupTimeLabel: localized(block, 'pickup_time_label', language) || 'Pickup Time',
          pickupLocationLabel: localized(block, 'pickup_location_label', language) || 'Pickup Location',
          dropoffDateLabel: localized(block, 'dropoff_date_label', language) || 'Drop-off Date',
          dropoffTimeLabel: localized(block, 'dropoff_time_label', language) || 'Drop-off Time',
          dropoffLocationLabel: localized(block, 'dropoff_location_label', language) || 'Drop-off Location',
          accommodationTitle: localized(block, 'accommodation_title', language),
          checkinDateLabel: localized(block, 'checkin_date_label', language) || 'Check-in Date',
          checkoutDateLabel: localized(block, 'checkout_date_label', language) || 'Check-out Date',
        });
        break;
      case 'rsvp-sessions':
        vms.push({
          type,
          title,
          bodyHtml,
          sessions: items(event.lect, 'session').map((session, sessionIndex) => ({
            name: localized(session, 'name', language) || `Session ${sessionIndex + 1}`,
            start: attr(session, 'start'),
            location: localized(session, 'location', language),
            field: `session-${sessionIndex}`,
          })).filter((session) => session.name),
        });
        break;
      case 'rsvp-qrcode': {
        if (options.publicRegistration || options.preview || !guest) break;
        // Same signed check-in payload the events plugin's admin guest-QR view
        // mints, resolved by cms-plugin-checkin's /checkin/… routes.
        const token = `${listId}.${guest.id}`;
        const sig = env.EVENTS_SIGN_KEY ? await signPayload(env.EVENTS_SIGN_KEY, token) : '';
        const base = (env.CHECKIN_BASE_URL ?? '').replace(/\/+$/, '');
        const qrPayload = base && sig ? `${base}/checkin/${listId}/${guest.id}/${sig}` : `${token}.${sig}`;
        const size = Math.max(120, Number.parseInt(attr(block, 'size'), 10) || 200);
        vms.push({
          type,
          title: localized(block, 'title', language),
          message: localized(block, 'message', language),
          size,
          qrSvg: qrSvg(qrPayload, { size }),
        });
        break;
      }
      // rsvp-accept / rsvp-button render as the form's submit buttons.
      // Email-only blocks such as attachments and unsubscribe are skipped.
      default:
        break;
    }
  }
  if (options.publicRegistration && !hasPublicRegistrationForm) {
    vms.push({
      type: 'rsvp-public-form',
      title: '',
      bodyHtml: '',
      salutationLabel: 'Salutation',
      salutationSelectLabel: 'Please Select',
      firstNameLabel: 'First Name',
      lastNameLabel: 'Last Name',
      emailLabel: 'Email',
      organizationLabel: 'Company / Organization',
      jobTitleLabel: 'Position',
      inputs: [],
    });
  }
  return vms;
}

interface CustomInputVM {
  name: string;
  label: string;
  type: string;
  required: boolean;
  description: string;
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
}

/** Legacy field-name scheme: `<prefix><label-slug>` (lowercased, spaces → dashes). */
function customInputVMs(
  block: Record<string, unknown>,
  itemsKey: string,
  prefix: string,
  language: string,
): CustomInputVM[] {
  return items(block, itemsKey)
    .map((input) => {
      const label = localized(input, 'label', language);
      const name = attr(input, 'name') || slug(label);
      const type = attr(input, 'type') || 'text';
      const defaultValue = attr(input, 'default_value') || localized(input, 'default_value', language);
      return {
        name: `${prefix}${slug(name)}`,
        label,
        type,
        required: truthy(attr(input, 'required')),
        description: localized(input, 'description', language),
        defaultValue,
        options: type === 'select' || type === 'radio' ? parseOptions(defaultValue) : [],
      };
    })
    .filter((input) => input.label);
}

/** `value:label|value:label` → options (legacy select/radio encoding). */
function parseOptions(encoded: string): Array<{ value: string; label: string }> {
  return encoded
    .split('|')
    .map((part) => {
      const [value, label] = part.split(':');
      return { value: (value ?? '').trim(), label: (label ?? value ?? '').trim() };
    })
    .filter((option) => option.value !== '' || option.label !== '');
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[/()]/g, '').replace(/\s+/g, '-');
}

// ── Submit (published-DB rows — see header note) ──────────────────────────────

async function submitRsvp(
  request: Request,
  env: RsvpEnv,
  url: URL,
  guest: CmsPage,
  eventId: number,
  listId: number,
  language: string,
  languagePrefix: string,
): Promise<Response> {
  const form = await request.formData();
  const status = String(form.get('status') ?? '').trim().toLowerCase();
  if (!RESPONSES.has(status)) return new Response('Choose a response', { status: 400 });
  // Honeypot filled → a bot. Pretend success, store nothing.
  if (honeypotFilled(form)) return redirect(url, `${languagePrefix}/rsvp/thank-you`, { status });

  const responded = await respondedStatus(env.PUBLISHED_DB!, guest);
  if (responded && !allowRefill(guest)) {
    return guestThankYouRedirect(url, responded);
  }

  // Plus guests: the explicit count field (fallback form), else the number of
  // named companions the EDM's plus-one block collected.
  const namedPlusGuests = [...form.entries()]
    .filter(([name, value]) => /^rsvp-plus-one-\d+:name$/.test(name) && String(value).trim() !== '')
    .length;
  const plusGuestValue = form.get('plus_guests') ?? (namedPlusGuests || attr(guest.lect, 'plus_guests')) ?? '0';
  const plusGuests = Math.max(0, Number(plusGuestValue));
  const message = String(form.get('message') ?? '').trim();

  await insertResponse(env.PUBLISHED_DB!, {
    guest,
    eventId,
    listId,
    edmId: pageId(url.searchParams.get('edm')),
    status,
    plusGuests: Number.isFinite(plusGuests) ? plusGuests : 0,
    message,
    language,
    answers: collectAnswers(form),
  });
  return guestThankYouRedirect(url, status);
}

/**
 * Latest response status for a guest, or null when they have not responded.
 * Reads the rsvp_response rows this Worker writes (authoritative), falling
 * back to the response log in the published guest lect (pre-cutover data, or
 * a response that already made the round trip through ingest + republish).
 */
async function respondedStatus(db: D1Database, guest: CmsPage): Promise<string | null> {
  const latest = await latestResponse(db, guest.id);
  if (latest) return String(latest.status ?? 'confirmed');
  const responses = realResponses(guest);
  if (responses.length) return String(responses[responses.length - 1].status ?? 'confirmed');
  return null;
}

/** Classic honeypot: a visually hidden "website" input real visitors never fill. */
function honeypotFilled(form: FormData): boolean {
  return String(form.get('website') ?? '').trim() !== '';
}

// Self-registrations land as rsvp_registration rows — NO CMS call from this
// public, unauthenticated path (a bot can no longer create draft guest pages).
// The events plugin's admin review converts rows into real guests (dedupe by
// email + registration uuid) or discards them.
async function submitPublicRegistration(
  request: Request,
  env: RsvpEnv,
  url: URL,
  event: CmsPage,
  edm: CmsPage,
  language: string,
  languagePrefix: string,
): Promise<Response> {
  const form = await request.formData();
  const status = String(form.get('status') ?? 'confirmed').trim().toLowerCase();
  if (status && status !== 'confirmed') return new Response('Choose a response', { status: 400 });
  if (honeypotFilled(form)) return redirect(url, `${languagePrefix}/rsvp/thank-you`, { status: 'confirmed' });

  const firstName = formText(form, 'first_name');
  const lastName = formText(form, 'last_name');
  const name = [firstName, lastName].filter(Boolean).join(' ').trim();
  const email = formText(form, 'email');
  if (!name || !email) return new Response('Name and email are required', { status: 400 });
  const salutation = formText(form, 'prefix') || formText(form, 'salutation');
  const organization = formText(form, 'company') || formText(form, 'organization');

  const namedPlusGuests = [...form.entries()]
    .filter(([field, value]) => /^rsvp-plus-one-\d+:name$/.test(field) && String(value).trim() !== '')
    .length;
  await insertRegistration(env.PUBLISHED_DB!, {
    event,
    edmId: edm.id,
    fields: {
      name,
      firstName,
      lastName,
      email,
      salutation,
      organization,
      jobTitle: formText(form, 'job_title'),
      plusGuests: namedPlusGuests,
    },
    language,
    answers: collectAnswers(form),
  });

  return redirect(url, `${languagePrefix}/rsvp/thank-you`, { status: 'confirmed' });
}

function formText(form: FormData, key: string): string {
  return String(form.get(key) ?? '').trim();
}

function previewGuest(): CmsPage {
  return {
    id: 0,
    uuid: '',
    page_type: 'guest',
    name: 'Guest',
    slug: '',
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_id: null,
    created_at: '',
    updated_at: '',
    lect: {
      name: { en: 'Guest' },
      zh_hant_name: '貴賓',
      zh_hans_name: '贵宾',
      salutation: '',
      prefix: '',
      organization: '',
      job_title: '',
      plus_guests: '0',
      response: [{}],
    },
  };
}

// ── Thank-you ──────────────────────────────────────────────────────────────────

async function thankYou(views: Fetcher, status: string): Promise<Response> {
  const html = await renderLiquid(views, '/templates/public-thank-you.liquid', { declined: status === 'declined' });
  return htmlResponse(html);
}

/** Renders the post-RSVP confirmation. Check-in passes are sent separately. */
async function guestThankYou(
  env: RsvpEnv,
  edm: CmsPage | null,
  language: string,
  status: string,
): Promise<Response> {
  const declined = status === 'declined';
  const lect = edm?.lect ?? {};
  const title = declined
    ? localized(lect, 'decline_heading', language) || 'Thank you'
    : localized(lect, 'thankyou_heading', language) || 'Thank you for your RSVP';
  const bodyHtml = safeHtml(
    declined
      ? localized(lect, 'decline_body', language) || 'We have recorded that you cannot attend.'
      : localized(lect, 'thankyou_body', language) || 'Your RSVP has been recorded. We look forward to seeing you.',
  );
  const picture = assetUrl(env.CMS_URL, attr(lect, 'thankyou_picture'));
  const html = await renderLiquid(env.VIEWS, '/templates/public-thank-you.liquid', {
    declined,
    title,
    bodyHtml,
    picture,
  });
  return htmlResponse(html);
}

/** Redirects to the same signed URL, retaining event/list/guest identity and EDM selection. */
function guestThankYouRedirect(url: URL, status: string): Response {
  const target = new URL(url);
  target.searchParams.set('thank-you', status);
  return new Response(null, { status: 303, headers: { Location: target.toString() } });
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function getPublishedPageByRef(db: D1Database, pageType: string, ref: string): Promise<CmsPage | null> {
  const value = ref.trim();
  if (!value) return null;

  const id = pageId(value);
  if (id) {
    const page = await getPublishedPage(db, id);
    if (page?.page_type === pageType) return page;
  }

  return getPublishedPageBySlug(db, pageType, value);
}

function validContext(event: CmsPage, list: CmsPage, guest: CmsPage, eventId: number, listId: number): boolean {
  return event.page_type === 'event'
    // The list belongs to the event via its `event` pointer (not parent page).
    && list.page_type === 'mail_list' && pointer(list.lect, 'event') === String(eventId)
    && guest.page_type === 'guest' && guest.page_id === listId;
}

function edmBelongsToEvent(edm: CmsPage, eventId: number): boolean {
  return pointer(edm.lect, 'event') === String(eventId) || edm.page_id === eventId;
}

/**
 * Real submitted responses. The host seeds every blueprint block (including
 * `response`) with one empty row on create, so rows only count once they carry
 * a status or date.
 */
function realResponses(guest: CmsPage): Array<Record<string, unknown>> {
  return items(guest.lect, 'response').filter(
    (entry) => String(entry.status ?? '').trim() !== '' || String(entry.date ?? '').trim() !== '',
  );
}

function allowRefill(guest: CmsPage): boolean {
  return truthy(attr(guest.lect, 'allow_refill'));
}

function truthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'yes' || normalized === 'true';
}

function assetUrl(base: string | undefined, value: string): string {
  const src = value.trim();
  if (!src) return '';
  if (src.startsWith('/media/')) return src;
  if (/^(https?:)?\/\//i.test(src) || src.startsWith('data:')) return src;
  const origin = (base ?? '').replace(/\/+$/, '');
  return origin && src.startsWith('/') ? `${origin}${src}` : src;
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function redirect(url: URL, path: string, params: Record<string, string> = {}): Response {
  const target = new URL(path, url.origin);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return new Response(null, { status: 303, headers: { Location: target.toString() } });
}

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}
