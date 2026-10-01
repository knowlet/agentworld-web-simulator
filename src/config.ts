import { VERSION } from './domain';
import { sha256Hex } from './hash';

export interface Config {
  mode: 'live' | 'mock'; host: string; port: number; db: string; epoch: string;
  jevBase: string; jevPath: string; jevProtocol: 'systemone' | 'choice-chat'; jevKey: string; jevModel: string; jevEvalTimeout: number;
  composeTimeout: number; composeMaxSteps: number; composeMaxElements: number; composeMaxDepth: number;
  base: string; model: string; key: string;
  jsonMode: 'json_object' | 'json_schema' | 'off'; thinking: 'omit' | 'disabled' | 'enabled';
  maxTokens: number; timeout: number;
}
function endpoint(s: string): string {
  const u = new URL(s);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Invalid provider base URL');
  return u.href.replace(/\/$/, '');
}
function endpointPath(s: string): string {
  if (!s.startsWith('/') || /\s/.test(s)) throw new Error('Invalid provider endpoint path');
  return s;
}
function enumValue<T extends string>(value: string, options: readonly T[]): T {
  if (!options.includes(value as T)) throw new Error(`Expected one of: ${options.join(', ')}`);
  return value as T;
}
function integer(value: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error('Invalid numeric configuration');
  return n;
}
export function loadConfig(e: NodeJS.ProcessEnv = process.env): Config {
  const mode = enumValue(e.APP_MODE || 'live', ['live', 'mock']);
  const c: Config = {
    mode, host: e.HOST || '127.0.0.1', port: integer(e.PORT || '3000', 0, 65535),
    db: e.WORLD_DB || 'data/world.sqlite', epoch: e.WORLD_EPOCH || 'direct-typesafe-jev-1',
    jevBase: endpoint(e.JEV_BASE_URL || 'https://api.typesafe.ai/v1'),
    jevPath: endpointPath(e.JEV_PATH || '/systemone'),
    // 'systemone': POST {model, state, questions} (TypeSafe, OpenRouter /decisions).
    // 'choice-chat': any OpenAI-compatible /chat/completions model answers the
    // same Choice questions as JSON; choices stay strictly in-catalog.
    jevProtocol: enumValue(e.JEV_PROTOCOL || 'systemone', ['systemone', 'choice-chat'] as const),
    jevKey: e.JEV_API_KEY || e.TYPESAFE_API_KEY || '',
    jevModel: e.JEV_MODEL || 'jev-latest',
    jevEvalTimeout: integer(e.JEV_EVALUATION_TIMEOUT_MS || '10000', 100, 120000),
    composeTimeout: integer(e.JEV_COMPOSE_TIMEOUT_MS || '45000', 500, 180000),
    composeMaxSteps: integer(e.JEV_COMPOSE_MAX_STEPS || '4', 1, 32),
    composeMaxElements: integer(e.JEV_COMPOSE_MAX_ELEMENTS || '32', 3, 64),
    composeMaxDepth: integer(e.JEV_COMPOSE_MAX_DEPTH || '4', 2, 8),
    base: endpoint(e.OPENAI_BASE_URL || 'https://api.deepseek.com/v1'), model: e.OPENAI_MODEL || 'deepseek-flash',
    key: e.OPENAI_API_KEY || '',
    jsonMode: enumValue(e.OPENAI_JSON_MODE || 'json_object', ['json_object', 'json_schema', 'off']),
    thinking: enumValue(e.OPENAI_THINKING || 'omit', ['omit', 'disabled', 'enabled']),
    maxTokens: integer(e.OPENAI_MAX_TOKENS || '4096', 512, 32768),
    timeout: integer(e.REQUEST_TIMEOUT_MS || '120000', 50, 300000),
  };
  if (mode === 'live' && !c.jevKey) throw new Error('Live mode requires JEV_API_KEY (or TYPESAFE_API_KEY)');
  return c;
}
export function namespace(c: Config): string {
  // Legacy compatibility: defaults keep the historical tuple so worlds cached
  // before JEV_PATH / JEV_PROTOCOL existed stay readable. Non-default values
  // join the digest to keep their namespaces distinct.
  const tuple = [VERSION, c.epoch, c.mode, c.base, c.model, c.jevBase,
    ...(c.jevPath !== '/systemone' ? [c.jevPath] : []),
    ...(c.jevProtocol !== 'systemone' ? [c.jevProtocol] : []),
    c.jevModel, c.jsonMode, c.thinking, c.maxTokens, c.composeMaxSteps, c.composeMaxElements, c.composeMaxDepth];
  return sha256Hex(JSON.stringify(tuple)).slice(0, 24);
}
