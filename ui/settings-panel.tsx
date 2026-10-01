import { useState, type FormEvent } from 'react';
import {
  DEFAULT_DECISIONS_MODEL, DEFAULT_GENERATOR_MODEL,
  fetchModelIds, maskKey, saveSettings, type BrowserSettings,
} from './settings';

interface Props {
  open: boolean;
  settings: BrowserSettings;
  transportKind: 'server' | 'browser' | null;
  onChange: (settings: BrowserSettings) => void;
  onClose: () => void;
}

/**
 * OpenRouter key + model pickers. The stored key is used only by browser mode
 * (static hosting without the Bun server); server mode keeps reading .env.
 */
export function SettingsPanel({ open, settings, transportKind, onChange, onClose }: Props) {
  const [draft, setDraft] = useState<BrowserSettings>(settings);
  const [status, setStatus] = useState('');
  const [modelList, setModelList] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  if (!open) return null;
  const note = transportKind === 'server'
    ? '目前是伺服器模式：內容由 server .env 設定生成，下列設定僅在瀏覽器模式生效。'
    : '目前是瀏覽器模式：內容直接由下列設定呼叫 OpenRouter 生成。';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const saved = saveSettings(draft);
    onChange(saved.settings);
    setStatus(saved.persisted
      ? '已儲存（僅存於此瀏覽器）'
      : '已套用於本次瀏覽，但瀏覽器拒絕寫入儲存 —— 下次開啟需重填');
  };
  const loadModels = async () => {
    setLoadingModels(true);
    setStatus('');
    try {
      const ids = await fetchModelIds();
      setModelList(ids);
      setStatus(`已載入 ${ids.length} 個模型`);
    } catch (error) {
      setStatus(`載入模型清單失敗：${(error as Error).message}`);
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <section className="settings-panel" aria-label="OpenRouter settings">
      <div className="settings-head">
        <h2>OpenRouter 設定</h2>
        <button type="button" aria-label="Close settings" onClick={onClose}>✕</button>
      </div>
      <p className="settings-note">{note}</p>
      <form onSubmit={submit}>
        <label htmlFor="setting-key">OpenRouter API key</label>
        <input
          id="setting-key" type="password" autoComplete="off" spellCheck={false}
          placeholder={settings.apiKey ? maskKey(settings.apiKey) : 'sk-or-…'}
          value={draft.apiKey}
          onChange={e => setDraft({ ...draft, apiKey: e.target.value })}
        />
        <div className="settings-grid">
          <div>
            <label htmlFor="setting-generator">生成模型（搜尋／頁面內容）</label>
            <input
              id="setting-generator" list="aw-models" autoComplete="off" spellCheck={false}
              placeholder={DEFAULT_GENERATOR_MODEL}
              value={draft.generatorModel}
              onChange={e => setDraft({ ...draft, generatorModel: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="setting-decisions">決策模型（Jev choices）</label>
            <input
              id="setting-decisions" list="aw-models" autoComplete="off" spellCheck={false}
              placeholder={DEFAULT_DECISIONS_MODEL}
              value={draft.decisionsModel}
              onChange={e => setDraft({ ...draft, decisionsModel: e.target.value })}
            />
          </div>
        </div>
        <datalist id="aw-models">
          <option value={DEFAULT_GENERATOR_MODEL} />
          <option value={DEFAULT_DECISIONS_MODEL} />
          {modelList.map(id => <option key={id} value={id} />)}
        </datalist>
        <div className="settings-actions">
          <button type="submit">儲存</button>
          <button type="button" onClick={() => void loadModels()} disabled={loadingModels}>
            {loadingModels ? '載入中…' : '載入模型清單'}
          </button>
          <button type="button" onClick={() => {
            const cleared = saveSettings({ ...draft, apiKey: '' });
            setDraft(cleared.settings); onChange(cleared.settings); setStatus('已清除金鑰');
          }}>清除金鑰</button>
          <label className="settings-toggle">
            <input
              type="checkbox" checked={draft.forceBrowser}
              onChange={e => setDraft({ ...draft, forceBrowser: e.target.checked })}
            />
            強制瀏覽器模式
          </label>
        </div>
        {status && <p className="settings-status" role="status">{status}</p>}
        <p className="settings-security">
          金鑰只存於此瀏覽器的 localStorage，請求只送往 openrouter.ai，不會經過專案伺服器。
          公共或共用裝置請使用低額度、可隨時撤銷的金鑰。
        </p>
      </form>
    </section>
  );
}
