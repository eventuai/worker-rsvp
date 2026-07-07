// ============================================================
// Submission writes — the ONLY writes this Worker makes to the
// published D1 (PUBLISHED_DB, otherwise read-only; see published.ts).
//
// RSVP responses and public self-registrations are stored as insert-only
// rows in `live_pages` with reserved page types the CMS never mints:
//
//   rsvp_response      — one row per submit; page_id = the guest's id
//   rsvp_registration  — one row per signup;  page_id = the event's id
//
// Ownership contract with worker-cms (its src/publish/README.md):
//   - INSERT only — never UPDATE or DELETE, and never touch rows whose
//     uuids the CMS minted, so a republish can never overwrite a response
//     and a response can never corrupt published content.
//   - ids are NEGATIVE (CMS page ids are positive, minted from the same
//     timestamp formula — the sign makes a collision impossible).
//   - uuids come from the table default; worker-cms ingests rows into its
//     draft DB keyed by that uuid and fires plugin hooks from there.
// ============================================================

import type { CmsPage } from './cms';

export const RESPONSE_PAGE_TYPE = 'rsvp_response';
export const REGISTRATION_PAGE_TYPE = 'rsvp_registration';

/** Mirrors the CMS id formula, negated: -((epoch_s - offset) * 100000 + rand16). */
const CMS_ID_EPOCH_OFFSET = 1563741060;

function mintSubmissionId(): number {
  const seconds = Math.floor(Date.now() / 1000) - CMS_ID_EPOCH_OFFSET;
  const random = crypto.getRandomValues(new Uint16Array(1))[0];
  return -(seconds * 100000 + random);
}

export interface ResponseSubmission {
  guest: CmsPage;
  eventId: number;
  listId: number;
  edmId: number | null;
  status: string;
  plusGuests: number;
  message: string;
  language: string;
  /** Every rsvp-* / meal-* / session-* form field, verbatim. */
  answers: Record<string, string>;
}

export interface RegistrationSubmission {
  event: CmsPage;
  edmId: number | null;
  fields: {
    name: string;
    firstName: string;
    lastName: string;
    email: string;
    salutation: string;
    organization: string;
    jobTitle: string;
    plusGuests: number;
  };
  language: string;
  answers: Record<string, string>;
}

export async function insertResponse(db: D1Database, submission: ResponseSubmission): Promise<void> {
  const submittedAt = new Date().toISOString();
  await insertSubmission(db, {
    pageType: RESPONSE_PAGE_TYPE,
    name: `${submission.guest.name} — ${submission.status}`,
    slug: `response-${submission.guest.id}-${Date.now()}`,
    parentId: submission.guest.id,
    lect: {
      _type: RESPONSE_PAGE_TYPE,
      guest_uuid: submission.guest.uuid,
      event_id: String(submission.eventId),
      list_id: String(submission.listId),
      edm_id: submission.edmId === null ? '' : String(submission.edmId),
      status: submission.status,
      plus_guests: String(submission.plusGuests),
      message: submission.message,
      language: submission.language,
      submitted_at: submittedAt,
      answers: submission.answers,
    },
  });
}

export async function insertRegistration(db: D1Database, submission: RegistrationSubmission): Promise<void> {
  const submittedAt = new Date().toISOString();
  await insertSubmission(db, {
    pageType: REGISTRATION_PAGE_TYPE,
    name: submission.fields.name,
    slug: `registration-${submission.event.id}-${Date.now()}`,
    parentId: submission.event.id,
    lect: {
      _type: REGISTRATION_PAGE_TYPE,
      event_id: String(submission.event.id),
      edm_id: submission.edmId === null ? '' : String(submission.edmId),
      name: submission.fields.name,
      first_name: submission.fields.firstName,
      last_name: submission.fields.lastName,
      email: submission.fields.email,
      salutation: submission.fields.salutation,
      organization: submission.fields.organization,
      job_title: submission.fields.jobTitle,
      plus_guests: String(submission.fields.plusGuests),
      language: submission.language,
      submitted_at: submittedAt,
      answers: submission.answers,
    },
  });
}

interface SubmissionRow {
  pageType: string;
  name: string;
  slug: string;
  parentId: number;
  lect: Record<string, unknown>;
}

async function insertSubmission(db: D1Database, row: SubmissionRow): Promise<void> {
  await db.prepare(
    `INSERT INTO live_pages (id, name, slug, weight, page_type, lect, page_id)
     VALUES (?, ?, ?, 5, ?, ?, ?)`,
  )
    .bind(mintSubmissionId(), row.name, row.slug, row.pageType, JSON.stringify(row.lect), row.parentId)
    .run();
}

/** Lect of the newest rsvp_response row for a guest, or null when none exists. */
export async function latestResponse(db: D1Database, guestId: number): Promise<Record<string, unknown> | null> {
  const row = await db.prepare(
    `SELECT lect FROM live_pages
     WHERE page_type = ? AND page_id = ?
     ORDER BY created_at DESC, id ASC
     LIMIT 1`,
  )
    .bind(RESPONSE_PAGE_TYPE, guestId)
    .first<{ lect: string | null }>();
  if (!row?.lect) return null;
  try {
    const parsed = JSON.parse(row.lect) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Form fields kept verbatim as the submission's answers payload. */
export function collectAnswers(form: FormData): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (
      key.startsWith('rsvp-public-')
      || key.startsWith('rsvp-custom-')
      || key.startsWith('rsvp-travel-hotel-')
      || key.startsWith('rsvp-pickup-')
      || key.startsWith('rsvp-plus-one-')
      || key.startsWith('meal-')
      || key.startsWith('session-')
    ) {
      answers[key] = String(value);
    }
  }
  return answers;
}
