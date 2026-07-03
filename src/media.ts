const INLINE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
]);

export interface MediaEnv {
  MEDIA_BUCKET?: R2Bucket;
}

export async function handleMedia(env: MediaEnv, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/media/')) return null;
  if (!env.MEDIA_BUCKET) return new Response('not found', { status: 404 });

  const key = decodeURIComponent(url.pathname.replace(/^\/media\//, ''));
  if (!key || key.includes('..')) return new Response('not found', { status: 404 });

  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) return new Response('not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=31536000');
  headers.set('etag', object.httpEtag);
  applyMediaResponseHeaders(headers, key);

  return new Response(object.body, { headers });
}

function applyMediaResponseHeaders(headers: Headers, key: string): void {
  headers.set('content-security-policy', "default-src 'none'; sandbox");

  const contentType = headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  const inlineSafe = (contentType.startsWith('image/') && contentType !== 'image/svg+xml')
    || INLINE_CONTENT_TYPES.has(contentType);
  if (!inlineSafe) {
    const filename = key.split('/').pop() ?? 'download';
    headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  }
}
