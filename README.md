# Jev AgentWorld Web Simulator

一個隨瀏覽動作生成、並記住已探索頁面的**虛構網際網路**。目標與 [hanxiao/qwen-agentworld-35b-a3b-web-simulator](https://github.com/hanxiao/qwen-agentworld-35b-a3b-web-simulator) 相同：搜尋 → 開啟結果 → 點擊連結 → 持續探索 → 重訪同一個世界。

本版技術路線是：

- **OpenAI-compatible API**（任何 OpenAI-compatible endpoint；示範用 `stealth/space-bunny-alpha`）只生成結構化搜尋／頁面內容。
- **Jev** 負責 bounded decisions，包括 search intent、page policy，以及 UI composition（示範用 `inception/mercury-decide:free`）。
- **json-render 官方 experimental composer** (`experimental_composeSpec`) 直接把 app-owned component candidates 組成正式 `Spec`；evaluator 是 server-side System One adapter（`JEV_BASE_URL` + `JEV_PATH`，可指 TypeSafe `/systemone` 或 OpenRouter `/decisions`），不走 Vercel AI Gateway。
- **React + @json-render/react** 只渲染 server 已驗證、已 cache 的 `Spec`。
- **Bun 1.4.2** 負責 runtime、package manager、bundler/test command 與 HTTP server；持久層使用 **`bun:sqlite`**。

```text
query / URL / click context
        │
        ├─→ System One decisions endpoint (JEV_BASE_URL + JEV_PATH)
        │        └─→ world policy + json-render composition decisions
        │
        └─→ OpenAI-compatible generator
                 └─→ SearchDocument / PageDocument
                              │
                         Zod validation
                              │
                  atomic component candidates
                              │
                    experimental_composeSpec
                              │
                    validated json-render Spec
                              │
                   SQLite persistent world
                              │
                    @json-render/react UI
```

這不是搜尋引擎、爬蟲或可靠事實來源；模擬 URL 不會被實際抓取。

## 官方 json-render Jev preview

`experimental_composeSpec` 目前仍未發佈到 npm。依官方 [Jev (Experimental)](https://json-render.dev/docs/jev) 指引，本 repo 依 upstream 官方流程使用 **source-built + pnpm pack** 產生並 vendoring 的 `@json-render/core`，並固定到：

- upstream: `vercel-labs/json-render`
- commit: `3ad381881194e7011ad3ccd6d668033495a06c29`
- package version: `0.21.0`
- vendored archive: `vendor/json-render-core-3ad38188.tgz`
- SHA256: `0b002467614c0ade41e18ef6b15c116e9cf41fbe44cd49c6d93a49fe5adf73e6`

`vendor/json-render-core-3ad38188.json` 保存 provenance。`bun run verify:json-render` 會驗證 archive checksum，並確認安裝後確實 export 官方 `experimental_composeSpec` API。renderer 仍固定 `@json-render/react@0.21.0`，與該 checkout package version 相同。

不要把 `@json-render/core` 改回 npm `0.21.0`：npm 發佈版目前沒有這兩個 experimental exports。

## 架構重點

### 1. 不再有 deterministic `compilePage()` / `compileSearch()`

Generator 只寫資料，例如：

```json
{
  "title": "Deep sea",
  "summary": "...",
  "sections": [...],
  "links": [...]
}
```

server 將資料轉成受 catalog 約束的 atomic candidates：

```text
Surface variants
Header
Section #1..N
optional image placeholder
Links container
Link #1..N
```

candidate 的 props 已經是具體資料；Jev **不能寫 prose、URL、CSS、JS 或任意 props**。它只決定 candidate membership、root、parent/slot 與 order。這正是 json-render 官方 Jev composer 的模型。

### 2. Jev evaluator 直接走 System One decisions API

`experimental_composeSpec` 本身是 model-neutral：它只需要一個符合 `Experimental_CompositionEvaluator` 的 callback。這個 repo 不使用 json-render 內建的 Gateway adapter；server 直接呼叫 `JEV_BASE_URL + JEV_PATH` 組成的 endpoint（預設 TypeSafe `/systemone`），保持 TypeSafe 原生 `state + Choice questions` contract，回傳的 choice / confidence / probabilities 經本地驗證（out-of-catalog 拒絕、機率分佈完整性）後，再轉成 json-render composer 需要的 evaluator result。

同一個 adapter 也支援 OpenRouter 的 decisions model：

```dotenv
JEV_BASE_URL=https://openrouter.ai/api/alpha
JEV_PATH=/decisions
JEV_MODEL=inception/mercury-decide:free
JEV_API_KEY=your_openrouter_key
```

因此 live 模式只需要 **`JEV_API_KEY`**（或 `TYPESAFE_API_KEY`），也不經 Vercel AI Gateway。

### 3. Cache 保存內容 + UI tree

一次成功 materialization 會一起保存：

```text
semantic document
json-render Spec
composition metadata
```

Reload／重訪同一 observation 不會重新呼叫 generator 或 Jev。`WORLD_EPOCH`、模型與 composition budget 都會進 namespace；換模型或 composer 設定不會污染舊世界。

### 4. 安全邊界

- Generator output 必須通過 Zod schema。
- Jev 只看到 candidate descriptions / explicit context，不會自動收到 raw props/state。
- candidate props 由 server 建立，navigation URL 只會編譯成 `/view?...` / `/search?...`。
- catalog 不允許 generated script 或 arbitrary action handler。
- composed spec 會再經 catalog validation 和最低語意 postcondition；失敗不寫 cache。
- UI renderer 最後仍拒絕任意外部 `href`。

## 本機啟動

需要 **Bun 1.4.2+**。

```bash
git clone https://github.com/knowlet/agentworld-web-simulator.git
cd agentworld-web-simulator
bun install
cp .env.example .env
bun run build
bun run start
```

開啟 `http://127.0.0.1:3000`。

`.env.example` 預設：

```dotenv
APP_MODE=mock
```

mock 模式不會做任何外部 model call；但 UI tree 仍走**同一個官方 `experimental_composeSpec` 程式碼**，只是 evaluator 換成本地 deterministic fixture evaluator，供 CI 驗證 composer/candidate/renderer integration。

## Live 設定

```dotenv
APP_MODE=live

JEV_API_KEY=your_typesafe_key
JEV_BASE_URL=https://api.typesafe.ai/v1
JEV_MODEL=jev-latest
JEV_EVALUATION_TIMEOUT_MS=10000
JEV_COMPOSE_TIMEOUT_MS=45000
JEV_COMPOSE_MAX_STEPS=4
JEV_COMPOSE_MAX_ELEMENTS=32
JEV_COMPOSE_MAX_DEPTH=4

OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-flash
OPENAI_API_KEY=your_generator_key
OPENAI_JSON_MODE=json_object
OPENAI_THINKING=disabled
OPENAI_MAX_TOKENS=4096
REQUEST_TIMEOUT_MS=120000
```

`OPENAI_MODEL=deepseek-flash` 只是預設示例；請填你 endpoint 真正提供的 DeepSeek V4.1 Flash model ID。本 repo 只依賴 OpenAI-compatible `/chat/completions`。

`OPENAI_JSON_MODE` 支援 `json_object` / `json_schema` / `off`。所有模式最後都還會跑本地 Zod validation。

## 介面設定與瀏覽器模式（OpenRouter）

頁面右上 **⚙** 可填入 **OpenRouter API key**、選擇**生成模型**與 **Jev 決策模型**（預設 `stealth/space-bunny-alpha` + `inception/mercury-decide:free`；「載入模型清單」抓 OpenRouter 公開目錄）。設定只存於該瀏覽器的 localStorage，請求只送往 `openrouter.ai`。

兩種模式會自動切換：

| 模式 | 判定 | 內容生成 | 世界持久化 |
|---|---|---|---|
| 伺服器 | `/api/health` 可達 | Bun server 讀 `.env` | `bun:sqlite` |
| 瀏覽器 | 靜態托管（GitHub Pages）或勾選「強制瀏覽器模式」 | 頁端直呼 OpenRouter | `localStorage`（依 world namespace 分群） |

瀏覽器模式跑同一條 pipeline：Zod 驗證 → atomic candidates → 官方 `experimental_composeSpec` → catalog 驗證 → renderer；只是 provider 改由頁端呼叫、持久層換成 `localStorage`。金鑰存在使用者瀏覽器中，公開站請自行評估（建議低額度、可隨時撤銷的金鑰）；伺服器模式完全不接觸這個金鑰。

## GitHub Pages 部署

`Deploy GitHub Pages (static browser build)` workflow 在 push `develop` 時：以 `BASE_PATH=/<repo>/` 建置靜態 bundle（`__BASE__` 進 bundle、asset 路徑改寫）→ 複製 `index.html` 為 `404.html`（SPA fallback）→ `actions/deploy-pages`。完成後網址為 `https://<owner>.github.io/<repo>/`。

- 模擬同一環境：`BASE_PATH=/<repo>/ bun run build && cp dist/index.html dist/404.html`，再用 static file server 掛在該子路徑（未知路徑回 `404.html` + HTTP 404，與 Pages 行為一致）。
- 本地 server 模式請用預設 `bun run build`（`BASE_PATH=/`）；兩種 build 的 `dist/` 不可混用。
- workflow 需要 repo 的 Pages 設定為 **Source: GitHub Actions**（workflow 內會嘗試自動啟用，失敗時到 Settings → Pages 手動切換）。

## MVP 功能

- 虛構搜尋結果與 related searches。
- 直接輸入 URL。
- 頁面內 link 持續 materialize 下一頁。
- search intent / page type / palette 使用 Jev Choice。
- 官方 json-render Jev composer 選 component membership、root、grouping、placement、order。
- 五種 Surface layout：article / docs / forum / product / home。
- 四組 palette。
- `bun:sqlite` 世界持久化、同站品牌／palette、來源摘要與 anchor context。
- 同一 observation request deduplication。
- browser back / forward / reload。
- mock/live 明確標示。

第一版刻意不做 agent autoplay、表單 mutation、購物車或 progressive spec streaming；先驗證完整 world loop 與官方 Jev composition。

## 測試

```bash
bun run verify:json-render
bun run typecheck
bun run build
bun test tests/*.test.ts
bunx playwright install chromium
bun run test:e2e
```

真實 API：

```bash
bun run test:live
```

### Offline CI

`CI (offline fixtures)` 在 push / PR / manual dispatch 執行：

- pinned source-built json-render archive + export verification
- TypeScript
- production build
- provider / Gateway transport contract tests
- official `experimental_composeSpec` candidate composition tests
- bun:sqlite persistence / dedup / retry behavior
- 純 TS sha256 與既有 `Bun.CryptoHasher` storage key 相容、`JEV_PATH` 設定、瀏覽器 `localStorage` store 語意
- XSS-safe rendering
- Chromium 搜尋 → 頁面 → link → back → reload

不使用 secrets、不呼叫外部模型。push `develop` 另有 `Deploy GitHub Pages (static browser build)` 部署靜態瀏覽器版。

### Live smoke

在 GitHub **Settings → Secrets and variables → Actions** 設定：

| 類型 | 名稱 | 用途 |
|---|---|---|
| Secret | `JEV_API_KEY` | TypeSafe Jev API key；也接受 `TYPESAFE_API_KEY` |
| Secret | `OPENAI_API_KEY` | generator API key |
| Variable | `OPENAI_BASE_URL` | 例如 `https://api.deepseek.com/v1` |
| Variable | `OPENAI_MODEL` | endpoint 真正的 DS4.1 Flash model ID |
| Variable, optional | `JEV_BASE_URL` / `JEV_MODEL` | 預設 `https://api.typesafe.ai/v1` / `jev-latest` |
| Variable, optional | `OPENAI_JSON_MODE` | 預設 `json_object` |
| Variable, optional | `OPENAI_THINKING` | generic provider 建議 `omit`；DeepSeek 可用 `disabled` |
| Variable, optional | `JEV_*_TIMEOUT_MS` / compose limits | 調整 evaluator/composer budget |

然後：

**Actions → Live smoke (official json-render Jev + generator) → Run workflow**

live smoke 會驗證：Direct TypeSafe Jev world policy、OpenAI-compatible content generation、官方 json-render Jev select/layout composition、兩個連續頁面、cache 零新增 provider call，以及 Chromium 實際渲染。

這仍是 integration smoke，不是 factuality、Jev confidence calibration 或長期 world-consistency benchmark。


## Bun migration

此 repo 的正常開發與 CI 不需要 Node/npm/pnpm：

- runtime/server: `Bun.serve()`
- package manager / lockfile: `bun install` + `bun.lock`
- frontend build: `Bun.build()`
- tests: `bun test`
- SQLite: `bun:sqlite`

唯一仍出現 pnpm 的地方，是 **json-render upstream preview archive 的 provenance**：官方 Jev 文件目前要求從其 monorepo checkout 後用 pnpm build/pack；本 repo 已把那個精確產物與 SHA256 vendoring，因此日常安裝不需要 pnpm。
