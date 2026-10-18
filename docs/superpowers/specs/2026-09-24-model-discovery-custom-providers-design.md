# Model discovery, custom providers, and model pricing

Date: 2026-09-24
Branch: `feature/model-discovery-custom-providers`
Worktree: `/Applications/Python/sitegeist-feature`

## Problem

Models come only from the static catalog compiled into `@mariozechner/pi-ai`
(`models.generated.ts`). When a provider ships a new model it is invisible until
the catalog is regenerated and pi-mono is rebuilt. Users also cannot point the
extension at a local server or an OpenAI-compatible endpoint that is not in the
catalog. Discovered and custom models carry no pricing, so cost tracking for
them would read zero.

## Goals

- Models are discovered live from every provider the user has a key or login for.
- Subscription (OAuth) login is unchanged and gains the same discovery.
- Users can add any number of custom OpenAI-compatible providers under API Keys.
- The model picker groups by provider, can refresh, and marks newly discovered models.
- Discovered and custom models have prices: inherited where possible, user-entered otherwise.
- No changes to `../pi-mono` or `../mini-lit`. Everything lives in sitegeist.

## Non-goals (deferred)

- Excluding subscription-login usage from cost tracking. Today costs are recorded
  for OAuth providers as if they were API-key billed. Left as is for now.
- Any change to the Costs tab layout.
- Discovery for providers with no list endpoint (OpenAI Codex, Gemini CLI). They
  stay catalog-only.

## Constraints found during exploration

- pi-web-ui at the pinned version already ships `CustomProvidersStore`,
  `CustomProviderCard`, `discoverModels()` for Ollama, LM Studio, vLLM and
  llama.cpp, and a `ModelSelector` that merges custom models. Sitegeist already
  creates the store in IndexedDB (`app-storage.ts`, DB version 3) but shows no UI.
- Upstream pi-mono has deleted the web-ui package, so pi-web-ui is frozen at the
  pinned version. Anything it lacks is written in sitegeist.
- The pi-ai model registry is a module-level Map with no register function, so
  discovered models cannot be injected into `getModels()`. Sitegeist needs its
  own aggregation layer.
- Extension pages have `host_permissions` for all http(s) hosts, so discovery
  fetches do not need CORS rules.
- Cost flows from `Model.cost` through `calculateCost()` in pi-ai into each
  assistant message, then into `CostStore.recordCost()` in `sidepanel.ts`. Setting
  `cost` on the merged model object is sufficient for tracking.

## Design

### 1. Model sources (`src/models/`)

`src/models/model-catalog.ts` is the one place the app asks what models exist.

```ts
getAvailableModels(): Promise<Model<Api>[]>
refreshDiscoveredModels(providers?: string[]): Promise<void>
```

`getAvailableModels()` returns the union of:

1. Catalog models (`getModels(provider)`) for every built-in provider that has a
   key or OAuth credential in `providerKeys`.
2. Discovered extras for those providers, read from the settings cache.
3. Custom-provider models (manual lists or cached auto-discovery results).

Pricing overrides (section 4) are applied to every returned model.

`src/models/model-discovery.ts` holds a table keyed by provider:

| Provider | Endpoint | Auth | Filter / metadata |
|---|---|---|---|
| anthropic | `GET /v1/models` | `x-api-key` or OAuth bearer + beta header | all; `display_name` |
| openai | `GET /v1/models` | bearer | id prefix allowlist: `gpt-`, `o1`, `o3`, `o4`, `chatgpt-` |
| google | `GET /v1beta/models?key=` | query key | `supportedGenerationMethods` includes `generateContent`; `inputTokenLimit`, `outputTokenLimit` |
| groq | `GET /openai/v1/models` | bearer | all; `context_window` |
| openrouter | `GET /api/v1/models` | none | `pricing`, `context_length`, `architecture.input_modalities` |
| xai | `GET /v1/models` | bearer | all |
| mistral | `GET /v1/models` | bearer | `capabilities.completion_chat`; `capabilities.vision`; `max_context_length` |
| cerebras | `GET /v1/models` | bearer | all |
| github-copilot | `GET /models` | copilot token + `Copilot-Integration-Id` | `model_picker_enabled`; `capabilities.limits.max_context_window_tokens`, `supports.vision` |
| vercel-ai-gateway | `GET /v1/models` | bearer | all; pricing when present |
| huggingface | `GET /v1/models` | bearer | all |

| openai-codex | `GET /backend-api/codex/models?client_version=<ver>` | OAuth bearer + `chatgpt-account-id` | `visibility === "list"`; `slug`, `display_name`, `context_window`, `input_modalities`, `supported_reasoning_levels` |

Providers absent from the table return no discovered models.

OpenAI Codex (ChatGPT subscription) is a special case, verified 2026-09-24
against the live endpoint with the Codex CLI's token:

- The endpoint requires the `client_version` query parameter and returns HTTP
  400 without it. The `originator` header is not checked. Sitegeist sends a
  constant `CODEX_CLIENT_VERSION` (currently `0.156.1`, the installed CLI). The
  server hides models whose `minimal_client_version` exceeds it, so bump the
  constant when new models fail to appear.
- The account id comes from the JWT access token (`https://api.openai.com/auth`
  claim, `chatgpt_account_id`), the same way pi-ai's Codex provider reads it.
- The static catalog's eight `openai-codex` entries (gpt-5.1 through gpt-5.4)
  are all rejected by the server with "not supported when using Codex with a
  ChatGPT account". For this provider the discovered list replaces the catalog
  instead of merging with it. `getAvailableModels()` never returns the catalog
  entries for `openai-codex`.
- Fallback when the cache is empty or discovery fails: a constant
  `CODEX_FALLBACK_MODEL`, a full `Model` object built from the catalog's first
  `openai-codex` entry as template with id and name `gpt-6-sol`, context window
  272000, image input, reasoning true. `getAvailableModels()` returns it as the
  provider's only model until discovery succeeds, so a Codex-only user always
  has a selectable, working default. DEFAULT_MODELS for `openai-codex` is
  resolved from `getAvailableModels()`, preferring the lowest `priority` from
  discovery, else the fallback. Since `getModel("openai-codex", "gpt-6-sol")`
  returns undefined, the default-model chain must not go through `getModel()`
  for this provider (see section 5).
- The live list on 2026-09-24: gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol,
  gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 (plus two hidden entries). gpt-6-sol and
  gpt-6-luna were exercised through pi-ai's pinned `openai-codex-responses`
  provider over SSE with a function tool attached and returned correct tool
  calls. `prefer_websockets` and `tool_mode: code_mode_only` in the response do
  not prevent SSE or standard function calling and are ignored.
- `supported_reasoning_levels` includes `max` and `ultra`, which pi-ai's
  `ThinkingLevel` does not have. Discovery records `reasoning: true` and the
  existing minimal to xhigh picker stays as is.
- Subscription models have no price. They inherit zeros and are not flagged as
  unknown, since there is nothing to enter.

Each fetcher returns `DiscoveredModel[]`: `{ id, name?, contextWindow?,
maxTokens?, input?, reasoning?, cost? }`. Nothing else is cached. `toModel()`
turns one into a `Model<Api>` at read time, so the base URL, headers and
pricing always come from the current provider record and never from a stale
cache. It copies `baseUrl`, `headers` and `compat` from a template catalog model
of the same provider, then fills defaults: context window 128000, max tokens
8192, input `["text"]`, reasoning false, cost zeros.

Protocol resolution (`api`) picks the template per discovered model, because
GitHub Copilot's catalog mixes `anthropic-messages` (claude-*),
`openai-completions` (gemini-*, grok-*, gpt-4*) and `openai-responses` (gpt-5*):

1. If every catalog model for the provider shares one `api`, use it.
2. Otherwise take the catalog model with the longest common id prefix. Ties go
   to the lexicographically greatest id, which favors the newest family member
   (`gpt-6-sol` ties across all `gpt-*`, resolves to `gpt-5.x`, so
   `openai-responses`).
3. A zero-length common prefix means the family is unknown. The model is
   excluded and logged, not guessed.

Merge rule: if the catalog already has `provider/id`, the catalog entry wins and
the discovered one is dropped. Otherwise it is added and flagged `discovered:
true` so the picker can badge it.

Cache: settings key `discoveredModels` holding
`Record<cacheKey, { fetchedAt: number; models: DiscoveredModel[] }>` where
`cacheKey` is the built-in provider id or `custom:<uuid>`. Refresh runs:

- when the picker opens and any provider's entry is older than 24 hours,
- on the picker's Refresh button (all providers),
- right after a key is saved or an OAuth login completes (that provider only).

A failed fetch keeps the previous cache entry and logs a warning. It never blocks
the picker.

Response parsers are pure functions over the raw JSON so they can be unit tested
without network.

### 2. Custom providers

Reuse `CustomProvidersStore` from pi-web-ui for persistence only. pi-web-ui
does not export its discovery helper from the package index and its four
server-specific types (vLLM, llama.cpp, LM Studio, Ollama) all serve
`/v1/models` anyway, so sitegeist defines two types of its own:

```ts
type SitegeistProviderType = "openai-compatible" | "ollama";
```

`openai-compatible` probes `GET {baseUrl}/models` and then
`GET {baseUrl}/v1/models` with optional bearer, and stores the root that
answered as the provider's `baseUrl`, so both Open WebUI (`https://host/api`)
and bare hosts (`http://localhost:11434`) work for discovery and streaming. A
non-JSON answer is reported as "not JSON (got HTML, wrong base URL?)" rather
than a parse error. It covers vLLM, llama.cpp, LM Studio, Open WebUI and any
gateway. `ollama` uses
the already-installed `ollama` package to list models and keep only those with
tool support, reading context length and vision from the model details. The
store does not validate `type`, so the sitegeist string is stored as is; records
with any other type are ignored on read. Every returned model gets
`provider = customProvider.name` and a cache entry under the same
`discoveredModels` settings key, keyed `custom:<id>`.

`src/dialogs/CustomProviderDialog.ts` (sitegeist-owned, pi-web-ui's dialog uses
`alert()` and hardcodes its type list): fields are name, type, base URL, API key
(optional). Test Connection runs discovery and lists the models found. Save
requires name and base URL. Name must not equal a built-in provider id
(`getProviders()`), case-insensitive, or an existing custom provider name.

`ApiKeysOAuthTab` gains a third section, Custom Providers: a list of
`custom-provider-card` rows (pi-web-ui component) with Edit, Delete and Refresh,
plus an Add Provider button.

Save (add or edit) drops the provider's `custom:<uuid>` cache entry and re-runs
discovery for auto-discovery types. Since the cache holds only ids and
metadata, and base URL comes from the provider record at read time, an edited
URL takes effect on the next `getAvailableModels()` call with no further
invalidation. A rename moves pricing overrides from the old name to the new one
and updates `lastUsedModel.provider` if it matched. Delete removes the cache
entry and pricing overrides, and clears `lastUsedModel` if it pointed at that
provider.

Key handling has two gates, both in `sidepanel.ts`:

1. pi-web-ui's `AgentInterface.sendMessage()` reads `providerKeys.get(provider)`
   before every send and, when empty, calls `onApiKeyRequired(provider)` and
   aborts on false. Sitegeist's existing `onApiKeyRequired` handler gains a
   first branch: if `provider` names a custom provider, return true without
   prompting. Custom keys stay in `CustomProvidersStore` only; nothing is
   mirrored into `providerKeys`.
2. The agent's `getApiKey(provider)`: if `providerKeys` has no entry, look up
   the custom provider by name and return its `apiKey`, or the placeholder
   `"none"` when it has no key. pi-ai's OpenAI client throws on an empty key,
   and local servers ignore the bearer value, so the placeholder is required
   for keyless endpoints. Marked with a `ponytail:` comment.

`updateAuthLabel()` returns `"custom"` for custom providers.

### 3. Model picker (`src/dialogs/ModelPickerDialog.ts`)

Adapted from pi-web-ui `ModelSelector` (367 lines). Kept: subsequence search,
thinking and vision filter toggles, keyboard navigation, current-model highlight,
cost and context display. Changed:

- Models come from `getAvailableModels()`, not `getProviders()`.
- Rows are grouped under provider headers. Order: built-in providers with keys,
  alphabetical, then custom providers, alphabetical.
- A Refresh button in the header calls `refreshDiscoveredModels()` and shows a
  spinner while running.
- Models flagged `discovered` show a small "new" badge.
- Unknown cost (all four rates zero and no override) renders as a dash plus a
  "set price" link that opens the pricing dialog (section 4).

`sidepanel.ts` replaces `ModelSelector.open(...)` with `ModelPickerDialog.open(...)`.
The `allowedProviders` argument goes away: the catalog layer already filters.

### 4. Model pricing

Settings key `modelPricing`: `Record<"provider/id", { input, output, cacheRead,
cacheWrite }>` in dollars per million tokens, matching `Model.cost`.

Price resolution when building a model, first match wins:

1. User override from `modelPricing`.
2. Pricing in the discovery response (OpenRouter, Vercel AI Gateway).
3. A catalog model with the same id on any provider, after stripping a vendor
   prefix (`anthropic/claude-sonnet-4-6` matches `claude-sonnet-4-6`). This covers
   custom endpoints that proxy a known model.
4. Zeros, flagged unknown.

`src/dialogs/ModelPricingDialog.ts`: four numeric inputs with the current values
prefilled, Save writes the override and the picker re-renders. Reachable from the
picker's "set price" link and from a pencil icon next to any model's cost. A
"Reset" clears the override and falls back to inherited pricing.

Cost tracking itself does not change: `calculateCost()` reads `model.cost`, and
the daily aggregate records by `provider` and `id` as today.

### 5. Startup

The default-model chain keeps its order (saved model, then DEFAULT_MODELS for a
provider with a key, then first model of a provider with a key, then the
Anthropic fallback) but every lookup goes through `getAvailableModels()`
instead of `getModel()` and `getModels()`. That is what makes the Codex
fallback model and custom providers selectable at startup.

`lastUsedModel` is matched by provider and id against `getAvailableModels()`.
If found, the stored object is replaced by the fresh one so URL changes and
pricing overrides apply. If not found, the chain continues. A Codex-only user
whose first discovery fails lands on `CODEX_FALLBACK_MODEL`, never on the
credential-less Anthropic fallback.

### 6. Error handling

- Discovery errors are per provider: caught, logged, previous cache kept.
- Custom provider Test Connection surfaces the HTTP status or fetch error inline.
- Malformed responses (missing `data` array, non-string ids) are treated as
  empty results, not thrown.
- Pricing inputs reject negative or non-numeric values.

### 7. Testing

- `src/models/model-discovery.test.ts` using `node:test` via `npx tsx --test`:
  one fixture per provider parser, asserting ids, filtering and metadata mapping.
  Plus one test each for the merge rule, price resolution order, protocol
  resolution (Copilot `gpt-6-*` to responses, `claude-*` to anthropic, unknown
  family excluded), and that `toModel()` reads base URL from the provider
  record rather than the cache.
- `./check.sh` for lint and types.
- Manual: build the worktree, load `sitegeist-feature/dist-chrome` as a second
  unpacked extension, verify discovery for Anthropic and OpenAI, add an Ollama or
  OpenAI-compatible provider, set a price, run a session, confirm the Costs tab
  shows it.

## Files

New:

- `src/models/model-catalog.ts`
- `src/models/model-discovery.ts`
- `src/models/model-discovery.test.ts`
- `src/dialogs/ModelPickerDialog.ts`
- `src/dialogs/CustomProviderDialog.ts`
- `src/dialogs/ModelPricingDialog.ts`

Modified:

- `src/dialogs/ApiKeysOAuthTab.ts` (custom providers section, refresh after key save)
- `src/sidepanel.ts` (picker swap, getApiKey fallback, auth label, startup check)
- `package.json` (`test` script)
- `CHANGELOG.md` (Unreleased: Added, Changed)

Unchanged: `../pi-mono`, `../mini-lit`, storage schema (no new IndexedDB stores;
new data lives in the existing settings store and custom-providers store).
