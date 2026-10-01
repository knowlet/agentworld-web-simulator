// OpenRouter browser settings, persisted per visitor in localStorage only.
// The key never leaves the browser: it is sent exclusively to openrouter.ai.

export const DEFAULT_GENERATOR_MODEL = 'stealth/space-bunny-alpha';
export const DEFAULT_DECISIONS_MODEL = 'inception/mercury-decide:free';
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DECISIONS_BASE = 'https://openrouter.ai/api/alpha';

const LS_KEY = 'agentworld.settings.v1';

export interface BrowserSettings {
  apiKey: string;
  generatorModel: string;
  decisionsModel: string;
  forceBrowser: boolean;
}

export function defaultSettings(): BrowserSettings {
  return {
    apiKey: '',
    generatorModel: DEFAULT_GENERATOR_MODEL,
    decisionsModel: DEFAULT_DECISIONS_MODEL,
    forceBrowser: false,
  };
}

function trimmed(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function loadSettings(): BrowserSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<BrowserSettings>;
    const d = defaultSettings();
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
      generatorModel: trimmed(parsed.generatorModel, d.generatorModel),
      decisionsModel: trimmed(parsed.decisionsModel, d.decisionsModel),
      forceBrowser: parsed.forceBrowser === true,
    };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: BrowserSettings): BrowserSettings {
  const clean: BrowserSettings = {
    apiKey: settings.apiKey.trim(),
    generatorModel: trimmed(settings.generatorModel, DEFAULT_GENERATOR_MODEL),
    decisionsModel: trimmed(settings.decisionsModel, DEFAULT_DECISIONS_MODEL),
    forceBrowser: settings.forceBrowser === true,
  };
  localStorage.setItem(LS_KEY, JSON.stringify(clean));
  return clean;
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 10) return '••••••';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Public OpenRouter catalog (no auth). Used to fill the model pickers. */
export async function fetchModelIds(): Promise<string[]> {
  const res = await fetch(`${OPENROUTER_BASE}/models`);
  if (!res.ok) throw new Error(`OpenRouter /models responded HTTP ${res.status}`);
  const data = await res.json() as { data?: Array<{ id?: unknown }> };
  const ids = (data.data ?? [])
    .map(m => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (!ids.length) throw new Error('OpenRouter returned no model ids');
  return ids.sort();
}
