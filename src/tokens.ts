// ============================================================
// Guest personalization for EDM-authored content ({{name}}, {{salutation}},
// {{prefer_name||name}}, …) and the safeHtml sanitiser for rich-text fields.
// Vendored subset of cms-plugin-events src/edm.ts (guestEmailTokens /
// applyTemplateTokens / safeHtml) — the email-only fields (signed URLs,
// obfuscated address) are omitted; keep the substitution semantics in sync.
// ============================================================

import { attr, localized, type CmsPage } from '@lionrockjs/worker-cms-plugin';

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

export function applyTemplateTokens(html: string, tokens: Record<string, string>): string {
  let result = html;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.replace(new RegExp(`{{@?${escapeRegExp(key)}}}`, 'gi'), () => value);
  }
  return result.replace(/{{@?([\w]+(?:\|\|[\w]+)+)}}/gi, (_match, keys: string) => {
    for (const key of keys.split('||').map((value) => value.trim())) {
      const value = tokens[key];
      if (value !== undefined && value !== '') return value;
    }
    return '';
  });
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
