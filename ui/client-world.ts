import type { Config } from '../src/config';
import { namespace } from '../src/config';
import { World } from '../src/world';
import { Providers } from '../src/providers';
import { LocalStore } from './local-store';
export { LocalStore } from './local-store';
import { assertNativeDecisionModel, NATIVE_DECISIONS } from './decision-models';
import {
  OPENROUTER_BASE,
  type BrowserSettings,
} from './settings';

/** Browser-mode world: same pipeline as the server, providers called directly. */
export function createBrowserWorld(settings: BrowserSettings): World {
  assertNativeDecisionModel(settings.decisionsModel);
  const config: Config = {
    mode: 'live',
    host: '127.0.0.1', port: 0, db: '',
    epoch: 'browser-openrouter-1',
    jevBase: NATIVE_DECISIONS.base,
    jevPath: NATIVE_DECISIONS.path,
    // Native decisions endpoint, called directly from the page (same contract
    // as server mode; needs no server-side adapter).
    jevProtocol: NATIVE_DECISIONS.protocol,
    jevKey: settings.apiKey,
    jevModel: settings.decisionsModel.trim(),
    jevEvalTimeout: 30000,
    composeTimeout: 90000,
    composeMaxSteps: 4,
    composeMaxElements: 32,
    composeMaxDepth: 4,
    base: OPENROUTER_BASE,
    model: settings.generatorModel,
    key: settings.apiKey,
    jsonMode: 'json_object',
    thinking: 'omit',
    maxTokens: 4096,
    timeout: 120000,
  };
  // namespace() excludes credentials by design (same rule as server mode).
  return new World(new LocalStore(namespace(config)), new Providers(config));
}
