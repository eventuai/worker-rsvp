export interface CmsPage {
  id: number;
  uuid: string;
  page_type: string | null;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  page_id: number | null;
  created_at: string;
  updated_at: string;
  lect: Record<string, unknown>;
}

export interface CmsPageInput {
  page_type: string;
  page_id?: number | null;
  name?: string;
  slug?: string;
  lect?: Record<string, unknown>;
}

interface CmsClientOptions {
  cmsUrl?: string;
  pluginSecret?: string;
  pluginId: string;
  fetcher?: typeof fetch;
}

interface CmsListOptions {
  pointer?: { key: string; value: string | number };
  limit?: number;
}

export class CmsClient {
  private readonly cmsUrl: string;
  private readonly pluginSecret?: string;
  private readonly pluginId: string;
  private readonly fetcher: typeof fetch;

  constructor(options: CmsClientOptions) {
    this.cmsUrl = (options.cmsUrl ?? '').replace(/\/+$/, '');
    this.pluginSecret = options.pluginSecret;
    this.pluginId = options.pluginId;
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  async list(pageType: string, options: CmsListOptions = {}): Promise<{ pages: CmsPage[]; total?: number }> {
    const url = this.url('/__cms/pages');
    url.searchParams.set('page_type', pageType);
    if (options.limit) url.searchParams.set('limit', String(options.limit));
    if (options.pointer) {
      url.searchParams.set('pointer_key', options.pointer.key);
      url.searchParams.set('pointer_value', String(options.pointer.value));
    }

    const data = await this.request<{ pages?: CmsPage[]; total?: number }>(url, { method: 'GET' });
    return { pages: data.pages ?? [], total: data.total };
  }

  async create(input: CmsPageInput): Promise<CmsPage> {
    const data = await this.request<{ page?: CmsPage }>(this.url('/__cms/pages'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!data.page) throw new Error('CMS create did not return a page');
    return data.page;
  }

  async update(id: number, input: Partial<CmsPageInput>): Promise<CmsPage | null> {
    const data = await this.request<{ page?: CmsPage }>(this.url(`/__cms/pages/${id}`), {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    return data.page ?? null;
  }

  private url(path: string): URL {
    if (!this.cmsUrl) throw new Error('CMS_URL must be set for CMS writes');
    return new URL(path, this.cmsUrl);
  }

  private async request<T>(url: URL, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    headers.set('x-plugin-id', this.pluginId);
    if (this.pluginSecret) headers.set('x-plugin-secret', this.pluginSecret);

    const response = await this.fetcher(url.toString(), { ...init, headers });
    if (!response.ok) throw new Error(`CMS request failed: ${response.status}`);
    return response.json() as Promise<T>;
  }
}

export function attr(lect: Record<string, unknown>, key: string): string {
  return scalarText(lect[key]);
}

export function localized(lect: Record<string, unknown>, key: string, lang = 'en'): string {
  const value = lect[key];
  if (value == null) return '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    const preferred = scalarText(map[lang]);
    if (preferred) return preferred;
    for (const candidate of Object.values(map)) {
      const text = scalarText(candidate);
      if (text) return text;
    }
    return '';
  }
  return scalarText(value);
}

export function items(lect: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = lect[key];
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

export function blocks(lect: Record<string, unknown>): Array<Record<string, unknown>> {
  return items(lect, '_blocks');
}

export function pointer(lect: Record<string, unknown>, key: string): string {
  const pointers = lect._pointers;
  if (!pointers || typeof pointers !== 'object' || Array.isArray(pointers)) return '';
  const value = (pointers as Record<string, unknown>)[key];
  return scalarText(value);
}

function scalarText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '';
  if (typeof value === 'object') {
    const map = value as Record<string, unknown>;
    for (const key of ['url', 'src', 'href', 'path', 'file', 'value']) {
      const text = scalarText(map[key]);
      if (text) return text;
    }
    for (const candidate of Object.values(map)) {
      const text = scalarText(candidate);
      if (text) return text;
    }
  }
  return '';
}
