// ============================================================
// Guest personalization for EDM-authored content ({{name}}, {{salutation}},
// {{prefer_name||name}}, …) and the safeHtml sanitiser for rich-text fields.
// Vendored subset of cms-plugin-events src/edm.ts (guestEmailTokens /
// applyTemplateTokens / safeHtml) — the email-only fields (signed URLs,
// obfuscated address) are omitted; keep the substitution semantics in sync.
// ============================================================

import { attr, localized, type CmsPage } from './cms';

const DEFAULT_NAME = 'Guest';
const DEFAULT_ZH_HANT_NAME = '貴賓';
const DEFAULT_ZH_HANS_NAME = '贵宾';

export function guestTokens(guest: CmsPage): Record<string, string> {
  const language = attr(guest.lect, 'prefer_language');
  const email = attr(guest.lect, 'email');
  const enName = guest.name || localized(guest.lect, 'name', language);
  const zhHantName = attr(guest.lect, 'zh_hant_name') || attr(guest.lect, 'zh_hans_name') || enName;
  const zhHansName = attr(guest.lect, 'zh_hans_name') || attr(guest.lect, 'zh_hant_name') || enName;
  const preferName = language.toLowerCase().startsWith('zh-hant')
    ? zhHantName
    : language.toLowerCase().startsWith('zh-hans')
      ? zhHansName
      : enName || zhHantName;
  const tokens: Record<string, string> = {
    language,
    view_id: String(guest.id),
    contact: email,
    email,
    name: enName,
    en_name: enName,
    zh_hant_name: zhHantName,
    zh_hans_name: zhHansName,
    prefer_name: preferName,
    salutation: attr(guest.lect, 'prefix'),
    zh_hant_salutation: attr(guest.lect, 'prefix'),
    zh_hans_salutation: attr(guest.lect, 'prefix'),
    company: attr(guest.lect, 'organization'),
    organization: attr(guest.lect, 'organization'),
    title: attr(guest.lect, 'job_title'),
    job_title: attr(guest.lect, 'job_title'),
  };
  for (const [key, value] of Object.entries(guest.lect)) {
    if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && tokens[key] === undefined) {
      tokens[key] = String(value);
    }
  }
  return tokens;
}

export function defaultGuestTokens(language = 'en'): Record<string, string> {
  const tokens = guestTokens({
    id: 0,
    uuid: '',
    page_type: 'guest',
    name: DEFAULT_NAME,
    slug: '',
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_id: null,
    created_at: '',
    updated_at: '',
    lect: {
      prefer_language: language,
      name: { en: DEFAULT_NAME, 'zh-hant': DEFAULT_ZH_HANT_NAME, 'zh-hans': DEFAULT_ZH_HANS_NAME },
      zh_hant_name: DEFAULT_ZH_HANT_NAME,
      zh_hans_name: DEFAULT_ZH_HANS_NAME,
      prefix: '',
    },
  });
  tokens.name = DEFAULT_NAME;
  tokens.en_name = DEFAULT_NAME;
  tokens.zh_hant_name = DEFAULT_ZH_HANT_NAME;
  tokens.zh_hans_name = DEFAULT_ZH_HANS_NAME;
  tokens.salutation = '';
  tokens.zh_hant_salutation = '';
  tokens.zh_hans_salutation = '';
  tokens.prefer_name = language.toLowerCase().startsWith('zh-hant')
    ? DEFAULT_ZH_HANT_NAME
    : language.toLowerCase().startsWith('zh-hans')
      ? DEFAULT_ZH_HANS_NAME
      : DEFAULT_NAME;
  return tokens;
}

export function applyTemplateTokens(html: string, tokens: Record<string, string>): string {
  let result = html;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.replace(new RegExp(`{{\\s*@?${escapeRegExp(key)}\\s*}}`, 'gi'), () => value);
  }
  result = result.replace(/{{\s*@?([\w]+(?:\s*\|\|\s*[\w]+)+)\s*}}/gi, (_match, keys: string) => {
    for (const key of keys.split('||').map((value) => value.trim())) {
      const value = tokens[key];
      if (value !== undefined && value !== '') return value;
    }
    return '';
  });
  return result.replace(/{{\s*@?[\w]+(?:\s*\|\|\s*[\w]+)*\s*}}/gi, '');
}

export function safeHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, ' $1="#"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
