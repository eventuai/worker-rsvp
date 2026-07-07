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
| `POST` same path | Submit — stored as an `rsvp_response` row in `PUBLISHED_DB` (see below) |
| `GET /:lang?/rsvp/thank-you` | Post-submit page |
| `GET/POST /unsubscribe/:listId/:guestId/:sig` | EDM unsubscribe — confirm page, then sets the guest's `not_send` flag over the Plugin API |
| `GET /healthz` | Liveness + deploy version |

`:lang` is one of `mis / en / zh-hant / zh-hans` (legacy Eventuai parity); the
guest's `prefer_language` is the fallback. Form blocks: paragraph/table/button/
spacer, location, date-time, meal preferences (repeated per named plus guest),
plus-one, custom inputs, travel/hotel, pickup, sessions (from the event page),
and a signed check-in QR resolved by `cms-plugin-checkin`.

## Security / data posture

- **Published data only on GET** — event/list/guest/EDM come from `PUBLISHED_DB`
  (`live_pages`, parameterized SELECTs in `src/published.ts`); unpublished
  content is simply invisible. No draft/Plugin API reads on the public path.
- **No cookies or sessions** — guest identity comes solely from the HMAC-signed
  link, verified with `EVENTS_PLUGIN_SECRET` (a copy of `cms-plugin-events`'
  secret, same pattern as `cms-plugin-checkin`).
- Strict security headers on every response; editor-authored rich text passes
  through the same `safeHtml` sanitiser the EDM pipeline uses; everything else
  is Liquid-escaped.
- **Submit storage (decided 2026-07-07):** responses and self-registrations are
  INSERT-only rows in `PUBLISHED_DB` (`rsvp_response` / `rsvp_registration`,
  negative ids, full answers — `src/submissions.ts`). This Worker never
  updates/deletes published rows and never calls the CMS on the submit path;
  worker-cms ingests the rows into its draft DB on a cron and the events plugin
  applies them to guest pages from there. Because the CMS republish only ever
  upserts rows by its own uuids, it can never overwrite a stored submission
  (ownership contract: worker-cms `src/publish/README.md`). A hidden honeypot
  field silently drops bot submits. The confirmation email is still open.

## Configuration

```
wrangler secret put EVENTS_PLUGIN_SECRET   # copy of cms-plugin-events' PLUGIN_SECRET
```

`CMS_URL` (unsubscribe write-back only) and optional `CHECKIN_BASE_URL` (origin
of the check-in QR links) are vars in `wrangler.toml`. `PUBLISHED_DB.database_id`
must match the real `cms-published` database. Point `cms-plugin-events`'
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
