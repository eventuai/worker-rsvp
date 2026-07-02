# worker-rsvp

The RSVP public website backed by 0xCMS — a standalone Cloudflare Worker (own
domain) that renders guest-facing, **EDM-driven multilingual RSVP forms** from
the CMS's **published** database. The counterpart of
[`worker-web`](../worker-web) for the events side: `cms-plugin-events` authors
and publishes the content and mints the signed links; this Worker serves them.

```
cms-plugin-events ──publish──▶ cms-published (D1) ──read──▶ worker-rsvp ──HTML──▶ guest
        │                       live_pages
        └── mints signed links: {PUBLIC_BASE_URL}/{lang}/rsvp/{event}/{list}/{guest}/{sig}?edm={edm}
```

## Routes

| Route | Description |
|-------|-------------|
| `GET /:lang?/rsvp/:eventId/:listId/:guestId/:sig` | The RSVP form (`?edm=` picks the EDM whose `rsvp-*` blocks define it) |
| `POST` same path | Submit (interim: F1 draft-guest update as the events plugin) |
| `GET /:lang?/rsvp/thank-you` | Post-submit page |
| `GET /healthz` | Liveness + deploy version |

`:lang` is one of `mis / en / zh-hant / zh-hans` (legacy Eventuai parity); the
guest's `prefer_language` is the fallback. Form blocks: paragraph/table/button/
spacer, location, date-time, meal preferences (repeated per named plus guest),
plus-one, custom inputs, travel/hotel, pickup, sessions (from the event page),
and a signed check-in QR resolved by `cms-plugin-checkin`.

## Security / data posture

- **Published data only on GET** — event/list/guest/EDM come from `PUBLISHED_DB`
  (`live_pages`, parameterized SELECTs in `src/published.ts`); unpublished
  content is simply invisible. No draft/F1 reads on the public path.
- **No cookies or sessions** — guest identity comes solely from the HMAC-signed
  link, verified with `EVENTS_PLUGIN_SECRET` (a copy of `cms-plugin-events`'
  secret, same pattern as `cms-plugin-checkin`).
- Strict security headers on every response; editor-authored rich text passes
  through the same `safeHtml` sanitiser the EDM pipeline uses; everything else
  is Liquid-escaped.
- **Interim submit storage:** the POST updates the draft guest page through the
  CMS F1 API (status, plus-guest count, response log), authenticated as the
  events plugin. Full answer storage, self-registration, and the confirmation
  email are an open decision — `cms-to-rsvp.md` §9.2 B.1.

## Configuration

```
wrangler secret put EVENTS_PLUGIN_SECRET   # copy of cms-plugin-events' PLUGIN_SECRET
```

`CMS_URL` (interim F1 write) and optional `CHECKIN_BASE_URL` (origin of the
check-in QR links) are vars in `wrangler.toml`. `PUBLISHED_DB.database_id` must
match the real `cms-published` database. Point `cms-plugin-events`'
`PUBLIC_BASE_URL` at this Worker's public origin so emailed links land here.

Guests, lists, events and EDMs must be **published** for their form to render.

## Development

```
npm install
npm run typecheck
npm test
npm run dev      # wrangler dev --local
```

`wrangler dev --local` gives `PUBLISHED_DB` an empty local D1 — apply the
published schema from `cms/migrations/published` (or reuse worker-web's
`db:setup:local`) and publish a test event/list/guest/EDM first.
