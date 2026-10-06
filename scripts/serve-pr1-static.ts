// Local-only fixture host for the actual production subpath build. No keys or
// provider proxy: Playwright intercepts every OpenRouter request offline.
const prefix = '/agentworld-web-simulator/';
Bun.serve({ hostname: '127.0.0.1', port: 4174, async fetch(req) {
  const pathname = new URL(req.url).pathname;
  if (pathname === '/__ready') return new Response('ready');
  if (pathname === '/fixture-parent') return new Response('<!doctype html><title>Local frame fixture</title>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  if (!pathname.startsWith(prefix)) return new Response('Not found', { status: 404 });
  const route = pathname.slice(prefix.length);
  const asset = route === 'assets/app.js' ? ['assets/app.js', 'text/javascript']
    : route === 'assets/app.css' ? ['assets/app.css', 'text/css'] : null;
  const file = Bun.file(new URL(`../dist/${asset?.[0] ?? 'index.html'}`, import.meta.url));
  return new Response(file, {
    // Pages' SPA fallback has an HTTP 404 status; tests must not assume 200.
    status: asset || route === '' || route === 'index.html' ? 200 : 404,
    headers: { 'Content-Type': `${asset?.[1] ?? 'text/html'}; charset=utf-8`, 'Cache-Control': 'no-store' },
  });
} });
