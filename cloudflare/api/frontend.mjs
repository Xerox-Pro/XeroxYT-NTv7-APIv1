// Optional same-origin frontend on Workers Static Assets. The API-only deployment
// keeps its existing guard; only browser requests from this asset origin enter here.
export function frontendRequest(request, env) {
  if (!env.ASSETS) return null;
  const url = new URL(request.url);
  if (!/^\/(api|internal|health|stream|360|edu|scratch-edu)(\/|$)/.test(url.pathname)) {
    return {response: env.ASSETS.fetch(request)};
  }
  if (!url.pathname.startsWith('/api/')) return null;
  const origin = request.headers.get('Origin');
  let referer = '';
  try { referer = new URL(request.headers.get('Referer')).origin; } catch {}
  const local = origin === url.origin || (!origin && referer === url.origin);
  if (!local) return null;
  if (url.pathname === '/api/transport-config') {
    return {response: Response.json({origins:[url.origin]}, {headers:{'Cache-Control':'no-store'}})};
  }
  const headers = new Headers(request.headers);
  headers.set('Origin', url.origin);
  headers.set('Authorization', 'Bearer ' + env.API_SHARED_SECRET);
  return {
    request: new Request(request, {headers}),
    env: {...env, ALLOWED_ORIGINS: [...new Set([...(env.ALLOWED_ORIGINS || '').split(',').filter(Boolean), url.origin])].join(',')},
  };
}
