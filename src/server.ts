import { z } from 'zod';
import { canonicalUrl } from './domain';
import type { World } from './world';
import { ProviderError } from './providers';

const pageInput = z.strictObject({ url: z.string().min(1).max(2048), from: z.string().max(2048).optional(), ctx: z.string().max(200).optional() });
const searchInput = z.strictObject({ query: z.string().trim().min(1).max(500) });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function response(status: number, body: BodyInit | null, contentType: string, cacheControl = 'no-store') {
  return new Response(body, { status, headers: { ...securityHeaders, 'Cache-Control': cacheControl, 'Content-Type': contentType } });
}
function json(status: number, data: unknown) {
  return response(status, JSON.stringify(data), 'application/json; charset=utf-8');
}
async function parseJsonBody(req: Request): Promise<unknown> {
  if (!req.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Use application/json');
  const declared = Number(req.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > 16384) throw new HttpError(413, 'Request too large');
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > 16384) throw new HttpError(413, 'Request too large');
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function createApp(world: World) {
  let active = 0;
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      const host = req.headers.get('host') || url.host;
      if (!['127.0.0.1', 'localhost', '[::1]', world.providers.config.host].includes(url.hostname)) {
        throw new HttpError(403, 'Host not allowed');
      }
      const origin = req.headers.get('origin');
      if (origin && origin !== `${url.protocol}//${host}`) throw new HttpError(403, 'Cross-origin request denied');

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(200, {
          runtime: `Bun ${Bun.version}`,
          database: 'bun:sqlite',
          mode: world.providers.config.mode,
          world: world.store.stats(),
          configured: true,
          upstreamConnectivity: 'not-probed',
        });
      }
      if (req.method === 'POST' && ['/api/page', '/api/search'].includes(url.pathname)) {
        if (active >= 8) throw new HttpError(429, 'Too many materializations');
        active++;
        try {
          const input = await parseJsonBody(req);
          if (url.pathname === '/api/search') {
            const q = searchInput.parse(input);
            return json(200, await world.search(q.query));
          }
          const p = pageInput.parse(input);
          try { canonicalUrl(p.url); if (p.from) canonicalUrl(p.from); }
          catch { throw new HttpError(400, 'Invalid simulated URL'); }
          return json(200, await world.page(p.url, p.from, p.ctx));
        } finally { active--; }
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const files: Record<string, [string, string]> = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/search': ['index.html', 'text/html; charset=utf-8'],
        '/view': ['index.html', 'text/html; charset=utf-8'],
        '/assets/app.js': ['assets/app.js', 'text/javascript; charset=utf-8'],
        '/assets/app.css': ['assets/app.css', 'text/css; charset=utf-8'],
      };
      const mapped = files[url.pathname];
      if (!mapped) throw new HttpError(404, 'Not found');
      const file = Bun.file(new URL(`../dist/${mapped[0]}`, import.meta.url));
      if (!await file.exists()) throw new HttpError(404, 'Not found');
      // HTML must stay no-store (SPA entry); build assets may be reused briefly.
      const cache = url.pathname.startsWith('/assets/') ? 'public, max-age=300' : 'no-store';
      return response(200, file, mapped[1], cache);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      if (e instanceof z.ZodError) return json(400, { error: 'Invalid request or generated document' });
      if (e instanceof ProviderError) return json(e.status, { error: e.message });
      return json(500, { error: 'Materialization failed. Check configuration or retry. No failed page was cached.' });
    }
  };
}

export function listen(app: ReturnType<typeof createApp>, port: number, host = '127.0.0.1') {
  // Bun.serve has no auto-compression option (types reject `compress`); GitHub
  // Pages compresses at the CDN and LAN deployments do not need it.
  const server = Bun.serve({ hostname: host, port, fetch: app });
  return { server, base: `http://${host}:${server.port}`, stop: async () => { await server.stop(true); } };
}
