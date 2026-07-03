import { blocks, localized, pointer, type CmsPage } from '@lionrockjs/worker-cms-plugin';
import { getPublishedPagesByType, type PublishedEnv } from './published';
import { RSVP_LANGUAGES } from './rsvp';
import { renderLiquid } from './templates/liquid';

interface HomeEnv extends PublishedEnv {
  VIEWS: Fetcher;
}

export async function handleHome(env: HomeEnv, url: URL): Promise<Response | null> {
  const segments = url.pathname.split('/').filter(Boolean);
  const language = segments.length === 1 && RSVP_LANGUAGES.includes(segments[0]) ? segments[0] : 'en';
  if (segments.length > (segments[0] === language ? 1 : 0)) return null;
  if (!env.PUBLISHED_DB) return new Response('server misconfigured', { status: 500 });

  const [events, edms] = await Promise.all([
    getPublishedPagesByType(env.PUBLISHED_DB, 'event'),
    getPublishedPagesByType(env.PUBLISHED_DB, 'edm'),
  ]);
  const prefix = language === 'en' ? '/en' : `/${language}`;
  const eventRows = events.map((event) => {
    const forms = edms
      .filter((edm) => pointer(edm.lect, 'event') === String(event.id))
      .map((edm) => ({
        name: localized(edm.lect, 'subject', language) || edm.name,
        slug: edm.slug,
        href: `${prefix}/rsvp/${event.slug}/${edm.slug}/new`,
        hasPublicForm: hasPublicForm(edm),
      }));
    return {
      name: localized(event.lect, 'name', language) || event.name,
      slug: event.slug,
      start: event.start ?? '',
      forms,
      hasForms: forms.length > 0,
      publicForms: forms.filter((form) => form.hasPublicForm),
      hasPublicForms: forms.some((form) => form.hasPublicForm),
    };
  });

  const html = await renderLiquid(env.VIEWS, '/templates/public-index.liquid', {
    language,
    events: eventRows,
    hasEvents: eventRows.length > 0,
    languages: RSVP_LANGUAGES
      .filter((code) => code !== 'mis')
      .map((code) => ({
        code,
        label: code === 'zh-hant' ? '繁體中文' : code === 'zh-hans' ? '简体中文' : 'English',
        href: code === 'en' ? '/en' : `/${code}`,
        active: code === language,
      })),
  });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function hasPublicForm(edm: CmsPage): boolean {
  return blocks(edm.lect).some((block) => String(block._type ?? '') === 'rsvp-public-form');
}
