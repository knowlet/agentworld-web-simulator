import { useEffect, useState, useCallback, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Spec } from '@json-render/core';
import { canonicalUrl, pageSchema, searchSchema, type Page, type Result } from '../src/domain';
import type { SearchDocument } from '../src/world';
import { catalog } from '../src/catalog';
import { Navigation, WorldView } from './registry';
import { loadSettings, type BrowserSettings } from './settings';
import { createBrowserWorld } from './client-world';
import { SettingsPanel } from './settings-panel';
import './style.css';

// Injected by scripts/build.ts (BASE_PATH); falls back to the server root.
declare const __BASE__: string;
const BASE = typeof __BASE__ === 'string' ? __BASE__ : '/';
const apiHref = (path: string) => BASE + path;
const absoluteFor = (href: string) => BASE + href.replace(/^\//, '');

/** Current app route (base stripped) so a GitHub Pages subpath behaves like `/`. */
function relativePath(): string {
  const raw = location.pathname;
  const rest = raw.startsWith(BASE) ? raw.slice(BASE.length) : raw.replace(/^\//, '');
  return '/' + rest.replace(/^\//, '');
}

interface Transport {
  kind: 'server' | 'browser';
  page(url: string, from: string, ctx: string, signal: AbortSignal): Promise<Result<Page>>;
  search(query: string, signal: AbortSignal): Promise<Result<SearchDocument>>;
}

function serverTransport(): Transport {
  const post = async <T,>(path: string, body: unknown, signal: AbortSignal): Promise<T> => {
    const response = await fetch(apiHref(path), {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(payload.error || `Request failed (HTTP ${response.status})`);
    return payload as T;
  };
  return {
    kind: 'server',
    page: (url, from, ctx, signal) => post('api/page', { url, from, ctx }, signal),
    search: (query, signal) => post('api/search', { query }, signal),
  };
}

function browserTransport(settings: BrowserSettings): Transport {
  const world = createBrowserWorld(settings);
  const settle = async <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    const value = await promise;
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return value;
  };
  return {
    kind: 'browser',
    page: (url, from, ctx, signal) => settle(world.page(url, from, ctx), signal),
    search: (query, signal) => settle(world.search(query), signal),
  };
}

function App() {
  const [settings, setSettings] = useState<BrowserSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [probe, setProbe] = useState<'probing' | 'done'>('probing');
  const [transport, setTransport] = useState<Transport | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);

  const [route, setRoute] = useState(() => relativePath() + location.search);
  const [reload, setReload] = useState(0);
  const [input, setInput] = useState('');
  const [spec, setSpec] = useState<Spec | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('…');
  const [meta, setMeta] = useState('');

  const navigate = useCallback((href: string) => {
    if (!(href === '/' || href.startsWith('/view?') || href.startsWith('/search?'))) return;
    const current = relativePath() + location.search;
    if (href === current) setReload(n => n + 1);
    else { history.pushState(null, '', absoluteFor(href)); setRoute(href); }
    window.scrollTo(0, 0);
  }, []);

  // Transport detection: Bun server if reachable, else browser mode using the
  // visitor's OpenRouter settings (static hosting / forced browser mode).
  useEffect(() => {
    let cancelled = false;
    setProbe('probing');
    void (async () => {
      if (!settings.forceBrowser) {
        try {
          const response = await fetch(apiHref('api/health'), { signal: AbortSignal.timeout(4000) });
          const health = response.ok ? await response.json() as { mode?: unknown } : null;
          if (!cancelled && health && typeof health.mode === 'string') {
            setMode(health.mode);
            setTransport(serverTransport());
            setUnconfigured(false);
            setProbe('done');
            return;
          }
        } catch { /* no server → browser mode */ }
      }
      if (cancelled) return;
      if (settings.apiKey) {
        setTransport(browserTransport(settings));
        setUnconfigured(false);
      } else {
        setTransport(null);
        setUnconfigured(true);
      }
      setMode('browser');
      setProbe('done');
    })();
    return () => { cancelled = true; };
  }, [settings]);

  useEffect(() => {
    const pop = () => { setRoute(relativePath() + location.search); setReload(n => n + 1); };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const u = new URL(relativePath() + location.search, location.origin);
    const page = u.pathname === '/view';
    const q = u.searchParams.get(page ? 'url' : 'q') || '';
    setInput(q); setError(''); setSpec(null); setMeta('');
    if (u.pathname === '/') { setLoading(false); document.title = 'AgentWorld'; return () => ac.abort(); }
    if (probe === 'probing') { setLoading(true); return () => ac.abort(); }
    if (!transport) {
      setLoading(false);
      setError(unconfigured
        ? '瀏覽器模式尚未設定 OpenRouter API key，無法生成內容。'
        : '沒有可用的 world transport。');
      if (unconfigured) setSettingsOpen(true);
      return () => ac.abort();
    }
    setLoading(true);
    const request = page
      ? transport.page(q, u.searchParams.get('from') || '', u.searchParams.get('ctx') || '', ac.signal)
      : transport.search(q, ac.signal);
    request
      .then(result => {
        if (ac.signal.aborted) return;
        let policySource: string;
        if (page) {
          const document = result.data as Page;
          pageSchema.parse(document);
          policySource = document.policy.source;
          window.document.title = `${document.title} — AgentWorld`;
        } else {
          const document = result.data as SearchDocument;
          searchSchema.parse({ results: document.results, related: document.related });
          policySource = document.policy.source;
          window.document.title = `${q} — AgentWorld`;
        }
        if (!catalog.validate(result.spec).success) throw new Error('Server returned a spec outside the json-render catalog');
        setSpec(result.spec);
        setMode(transport.kind === 'browser' ? 'browser' : result.mode);
        setMeta(`${result.cached ? 'Cached observation' : 'New observation'} · ${result.elapsedMs} ms · world policy: ${policySource} · UI: ${result.composition.source}/${result.composition.evaluations} eval · generation: ${result.generation}`);
      })
      .catch(e => { if (!ac.signal.aborted) setError(e.message || 'Unable to materialize'); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [route, reload, transport, probe, unconfigured]);

  const submit = (e: FormEvent) => {
    e.preventDefault(); const value = input.trim(); if (!value) return;
    try {
      const isUrl = /^[a-z][a-z\d+.-]*:/i.test(value) || /^[^\s/]+\.[^\s/]+(?:\/[^\s]*)?$/.test(value);
      navigate(isUrl ? '/view?' + new URLSearchParams({ url: canonicalUrl(value) }) : '/search?' + new URLSearchParams({ q: value }));
    } catch { setError('Enter an http(s) address without credentials, or a search query.'); }
  };

  const badge = transport?.kind === 'browser'
    ? 'BROWSER · OPENROUTER'
    : (mode === 'mock' ? 'MOCK · NO MODEL CALLS' : mode.toUpperCase());

  return <Navigation.Provider value={navigate}>
    <header className="chrome">
      <div className="topline">
        <button className="wordmark" onClick={() => navigate('/')}>◈ AgentWorld</button>
        <span className="topline-right">
          <span className={`mode ${mode === 'mock' ? 'mock' : ''}`}>{badge}</span>
          <button
            className={`gear ${settingsOpen ? 'active' : ''}`}
            title="OpenRouter settings"
            aria-label="OpenRouter settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(open => !open)}
          >⚙</button>
        </span>
      </div>
      <div className="toolbar">
        <button title="Back" aria-label="Back" onClick={() => history.back()}>←</button>
        <button title="Forward" aria-label="Forward" onClick={() => history.forward()}>→</button>
        <button title="Reload" aria-label="Reload" onClick={() => setReload(n => n + 1)}>↻</button>
        <form onSubmit={submit}>
          <label className="sr-only" htmlFor="address">Search or URL</label>
          <input id="address" autoComplete="off" value={input} onChange={e => setInput(e.target.value)} placeholder="Search the simulated internet, or enter a URL" maxLength={2048} />
          <button type="submit">Go</button>
        </form>
      </div>
      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        transportKind={transport?.kind ?? null}
        onChange={next => setSettings(next)}
        onClose={() => setSettingsOpen(false)}
      />
    </header>
    <div className="disclaimer">FICTIONAL INTERNET — generated observations, not real websites or verified facts.</div>
    <main>
      {route === '/' && <section className="welcome">
        <span className="eyebrow">JEV × JSON-RENDER × YOUR LLM</span>
        <h1>An internet that<br />materializes as you explore.</h1>
        <p>Search for anything. Open a result. Follow another link.<br />The world remembers every page you discover.</p>
        <div className="examples">
          {['deep sea exploration', 'history of computing', 'https://docs.rust-lang.org/book/'].map(q =>
            <button key={q} onClick={() => navigate((q.startsWith('https:') ? '/view?url=' : '/search?q=') + encodeURIComponent(q))}>{q} ↗</button>)}
        </div>
        {unconfigured && <p className="settings-hint">
          尚未設定 OpenRouter API key —— 按右上 ⚙ 填入金鑰即可開始（預設已填好兩組模型）。
        </p>}
        <p className="footnote">Your configured model writes structured content. json-render's official experimental Jev composer chooses the UI tree, grouping and order.</p>
      </section>}
      {loading && <section className="status" role="status">
        <div className="spinner" />
        <h2>Materializing this observation…</h2>
        <p>Jev world policy → content generation → official json-render Jev composition → validation</p>
      </section>}
      {error && <section className="status error" role="alert">
        <h2>This observation could not materialize.</h2>
        <p>{error}</p>
        <div className="error-actions">
          <button onClick={() => setReload(n => n + 1)}>Retry</button>
          {unconfigured && <button onClick={() => setSettingsOpen(true)}>打開 OpenRouter 設定</button>}
        </div>
      </section>}
      {spec && <><div className="metadata">{meta}</div><WorldView spec={spec} /></>}
    </main>
    <footer className="app-footer">SIMULATED, NOT SCRAPED. · Local links only. · No generated scripts.</footer>
  </Navigation.Provider>;
}

createRoot(document.getElementById('root')!).render(<App />);
