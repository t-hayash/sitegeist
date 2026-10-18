# Model Discovery and Custom Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sitegeist discovers models live from every configured provider, lets users add OpenAI-compatible and Ollama endpoints, and tracks cost for discovered models through inherited or user-entered pricing.

**Architecture:** A new `src/models/` layer owns the question "what models exist": pure parsers and fetchers (`discovery.ts`), pure merge and pricing rules (`resolve.ts`), and a storage-backed aggregator with a 24-hour cache (`catalog.ts`). A sitegeist-owned picker, custom-provider dialog and pricing dialog sit on top. `sidepanel.ts` switches its model lookups from pi-ai's static `getModel()` to the aggregator.

**Tech Stack:** TypeScript 6, Lit 3, mini-lit components, pi-ai (pinned via `../pi-mono` at v0.60.0), pi-web-ui stores, esbuild, Biome, Node's built-in test runner via tsx.

**Spec:** `docs/superpowers/specs/2026-09-24-model-discovery-custom-providers-design.md`

## Global Constraints

- Work in the worktree `/Applications/Python/sitegeist-feature` on branch `feature/model-discovery-custom-providers`. Never edit `/Applications/Python/sitegeist`, `../pi-mono` or `../mini-lit`.
- Never commit. AGENTS.md forbids commits unless the user asks. Each task ends with `./check.sh` passing instead of a commit step.
- Do not run `npm run build` or `npm run dev`. `./check.sh` (Biome plus `tsc --noEmit`) and `npm test` are the only verification commands.
- No `any` types unless unavoidable; no inline `import()`; no emojis anywhere; imports use `.js` extensions.
- Formatting is Biome: tabs, line width 120. Run `./check.sh` to auto-format.
- pi-web-ui does not export its `model-discovery` util from its package index. Do not deep-import from its `dist/`. Write the fetchers in sitegeist.
- `CODEX_CLIENT_VERSION` is `"0.156.1"`.
- Cache TTL is 24 hours. Settings keys are `discoveredModels` and `modelPricing`. Cache keys are the built-in provider id or `custom:<uuid>`.
- Custom provider types are exactly `"openai-compatible"` and `"ollama"`. A custom provider name must not equal a built-in provider id (case-insensitive) or another custom provider name.
- Keyless custom providers send the placeholder API key `"none"`.
- For `openai-codex`, discovered models replace the catalog; the fallback is `CODEX_FALLBACK_MODEL` with id `gpt-6-sol`.
- Catalog entry wins over a discovered entry with the same provider and id.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise. Each has a test pinned to its owning task.

1. A provider response whose `data` is not an array (an error object with HTTP 200) must yield an empty list, not throw. (Task 1)
2. An OpenAI list containing `gpt-4o-realtime-preview` and `text-embedding-3-large` must exclude both. (Task 1)
3. A custom provider base URL entered with a trailing slash must produce `.../v1` once, never `...//v1`. (Task 2)
4. A discovered model whose id equals a catalog id on the same provider must not appear twice and must keep the catalog's pricing. (Task 2)
5. A pricing override with a negative or non-numeric value must be rejected by the dialog and never written. (Task 4)

---

### Task 1: Discovery parsers and fetchers

**Files:**
- Create: `src/models/discovery.ts`
- Modify: `src/oauth/openai-codex.ts` (export the account id helper)
- Create: `test/discovery.test.ts`
- Modify: `package.json` (add `test` script), `biome.json` (include `test/**/*`)

**Interfaces:**
- Consumes: `getGitHubCopilotBaseUrl(token)` from `src/oauth/github-copilot.ts` (exists), `getCodexAccountId(token)` from `src/oauth/openai-codex.ts` (exported in this task).
- Produces:
  - `interface DiscoveredModel { id: string; name?: string; contextWindow?: number; maxTokens?: number; input?: ("text" | "image")[]; reasoning?: boolean; cost?: ModelCost; priority?: number }`
  - `interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }`
  - `interface ProviderAuth { token: string; isOAuth: boolean }`
  - `const CODEX_CLIENT_VERSION: string`
  - `function hasDiscovery(provider: string): boolean`
  - `async function discoverBuiltinModels(provider: string, auth: ProviderAuth): Promise<DiscoveredModel[]>`
  - `async function discoverOpenAICompatible(baseUrl: string, apiKey?: string): Promise<DiscoveredModel[]>`
  - `async function discoverOllama(baseUrl: string): Promise<DiscoveredModel[]>`
  - Pure parsers, exported for tests: `parseOpenAIModels`, `parseAnthropicModels`, `parseGoogleModels`, `parseMistralModels`, `parseOpenRouterModels`, `parseVercelModels`, `parseGroqModels`, `parseCopilotModels`, `parseCodexModels`, `parseDataList`.

- [ ] **Step 1: Add the test script and export the Codex account id helper**

In `package.json` scripts, add after `"typecheck"`:

```json
"test": "tsx --test test/*.test.ts",
```

In `biome.json`, change `files.includes` to:

```json
"includes": ["src/**/*", "scripts/**/*", "test/**/*", "*.json", "*.md", "!**/node_modules/**/*", "!site", "!!**/node_modules"]
```

In `src/oauth/openai-codex.ts`, rename the private function `getAccountId` to an exported `getCodexAccountId` and update its two call sites in the same file:

```ts
export function getCodexAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
	const accountId = auth?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}
```

- [ ] **Step 2: Write the failing parser tests**

Create `test/discovery.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseAnthropicModels,
	parseCodexModels,
	parseCopilotModels,
	parseDataList,
	parseGoogleModels,
	parseGroqModels,
	parseMistralModels,
	parseOpenAIModels,
	parseOpenRouterModels,
	parseVercelModels,
} from "../src/models/discovery.js";

test("parseDataList returns empty for malformed payloads", () => {
	assert.deepEqual(parseDataList({ error: { message: "nope" } }), []);
	assert.deepEqual(parseDataList(null), []);
	assert.deepEqual(parseDataList({ data: [{ id: 42 }, { name: "x" }] }), []);
});

test("parseOpenAIModels keeps chat families and drops non-chat ids", () => {
	const json = {
		data: [
			{ id: "gpt-4o" },
			{ id: "gpt-4o-realtime-preview" },
			{ id: "text-embedding-3-large" },
			{ id: "o3-mini" },
			{ id: "chatgpt-4o-latest" },
			{ id: "whisper-1" },
			{ id: "gpt-image-1" },
		],
	};
	assert.deepEqual(
		parseOpenAIModels(json).map((m) => m.id),
		["gpt-4o", "o3-mini", "chatgpt-4o-latest"],
	);
});

test("parseAnthropicModels maps display_name", () => {
	const json = { data: [{ id: "claude-opus-5", display_name: "Claude Opus 5", type: "model" }] };
	assert.deepEqual(parseAnthropicModels(json), [{ id: "claude-opus-5", name: "Claude Opus 5" }]);
});

test("parseGoogleModels filters on generateContent and strips models/ prefix", () => {
	const json = {
		models: [
			{
				name: "models/gemini-4-pro",
				displayName: "Gemini 4 Pro",
				inputTokenLimit: 1000000,
				outputTokenLimit: 65536,
				supportedGenerationMethods: ["generateContent"],
			},
			{ name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
		],
	};
	assert.deepEqual(parseGoogleModels(json), [
		{ id: "gemini-4-pro", name: "Gemini 4 Pro", contextWindow: 1000000, maxTokens: 65536, input: ["text", "image"] },
	]);
});

test("parseMistralModels filters on completion_chat and reads vision", () => {
	const json = {
		data: [
			{ id: "mistral-large-3", capabilities: { completion_chat: true, vision: true }, max_context_length: 262144 },
			{ id: "mistral-embed", capabilities: { completion_chat: false } },
		],
	};
	assert.deepEqual(parseMistralModels(json), [
		{ id: "mistral-large-3", contextWindow: 262144, input: ["text", "image"] },
	]);
});

test("parseOpenRouterModels converts per-token pricing to per-million", () => {
	const json = {
		data: [
			{
				id: "anthropic/claude-opus-5",
				name: "Anthropic: Claude Opus 5",
				context_length: 200000,
				pricing: { prompt: "0.000015", completion: "0.000075", input_cache_read: "0.0000015", input_cache_write: "0.00001875" },
				architecture: { input_modalities: ["text", "image"] },
				supported_parameters: ["reasoning", "tools"],
				top_provider: { max_completion_tokens: 32000 },
			},
		],
	};
	const [m] = parseOpenRouterModels(json);
	assert.equal(m.id, "anthropic/claude-opus-5");
	assert.equal(m.contextWindow, 200000);
	assert.equal(m.maxTokens, 32000);
	assert.deepEqual(m.input, ["text", "image"]);
	assert.equal(m.reasoning, true);
	assert.deepEqual(m.cost, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 });
});

test("parseVercelModels reads pricing when present", () => {
	const json = {
		data: [{ id: "openai/gpt-6", name: "GPT-6", context_window: 400000, max_tokens: 128000, pricing: { input: "0.000002", output: "0.000008" } }],
	};
	assert.deepEqual(parseVercelModels(json), [
		{ id: "openai/gpt-6", name: "GPT-6", contextWindow: 400000, maxTokens: 128000, cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
	]);
});

test("parseGroqModels reads context_window", () => {
	const json = { data: [{ id: "llama-5-70b", context_window: 131072, max_completion_tokens: 32768 }] };
	assert.deepEqual(parseGroqModels(json), [{ id: "llama-5-70b", contextWindow: 131072, maxTokens: 32768 }]);
});

test("parseCopilotModels respects model_picker_enabled and vision", () => {
	const json = {
		data: [
			{
				id: "gpt-6",
				name: "GPT-6",
				model_picker_enabled: true,
				capabilities: { type: "chat", limits: { max_context_window_tokens: 400000, max_output_tokens: 64000 }, supports: { vision: true } },
			},
			{ id: "text-embedding-3-small", capabilities: { type: "embeddings" } },
			{ id: "hidden-model", model_picker_enabled: false, capabilities: { type: "chat" } },
		],
	};
	assert.deepEqual(parseCopilotModels(json), [
		{ id: "gpt-6", name: "GPT-6", contextWindow: 400000, maxTokens: 64000, input: ["text", "image"] },
	]);
});

test("parseCodexModels keeps only visibility list and maps priority", () => {
	const json = {
		models: [
			{
				slug: "gpt-6-sol",
				display_name: "GPT-6-Sol",
				context_window: 272000,
				input_modalities: ["text", "image"],
				supported_reasoning_levels: [{ effort: "low" }],
				visibility: "list",
				priority: 2,
			},
			{ slug: "gpt-reserve", visibility: "hide", priority: 3 },
		],
	};
	assert.deepEqual(parseCodexModels(json), [
		{ id: "gpt-6-sol", name: "GPT-6-Sol", contextWindow: 272000, input: ["text", "image"], reasoning: true, priority: 2 },
	]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run from the worktree: `npm test`
Expected: FAIL with "Cannot find module '../src/models/discovery.js'".

- [ ] **Step 4: Write `src/models/discovery.ts`**

```ts
/**
 * Live model discovery. Pure parsers over provider JSON plus thin fetchers.
 * No storage access here; catalog.ts owns caching and credentials.
 */
import { getGitHubCopilotBaseUrl } from "../oauth/github-copilot.js";
import { getCodexAccountId } from "../oauth/openai-codex.js";
import { Ollama } from "ollama/browser";

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface DiscoveredModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	cost?: ModelCost;
	priority?: number;
}

export interface ProviderAuth {
	token: string;
	isOAuth: boolean;
}

// ponytail: bump when Codex hides new models behind a newer minimal_client_version
export const CODEX_CLIENT_VERSION = "0.156.1";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function perMillion(value: unknown): number {
	const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : 0;
	return Number.isFinite(n) ? n * 1_000_000 : 0;
}

function withoutUndefined(model: DiscoveredModel): DiscoveredModel {
	const out: DiscoveredModel = { id: model.id };
	if (model.name !== undefined) out.name = model.name;
	if (model.contextWindow !== undefined) out.contextWindow = model.contextWindow;
	if (model.maxTokens !== undefined) out.maxTokens = model.maxTokens;
	if (model.input !== undefined) out.input = model.input;
	if (model.reasoning !== undefined) out.reasoning = model.reasoning;
	if (model.cost !== undefined) out.cost = model.cost;
	if (model.priority !== undefined) out.priority = model.priority;
	return out;
}

/** Entries of `json.data` (or `json[key]`) that are objects with a string id. */
export function parseDataList(json: unknown, key = "data"): Json[] {
	if (!isRecord(json)) return [];
	const list = json[key];
	if (!Array.isArray(list)) return [];
	return list.filter((item): item is Json => isRecord(item) && typeof item.id === "string");
}

const OPENAI_CHAT_PREFIX = /^(gpt-|o[1-9]|chatgpt-)/;
const OPENAI_NON_CHAT = /(realtime|audio|tts|transcribe|image|embedding|moderation|search|instruct|whisper)/;

export function parseOpenAIModels(json: unknown): DiscoveredModel[] {
	return parseDataList(json)
		.map((m) => m.id as string)
		.filter((id) => OPENAI_CHAT_PREFIX.test(id) && !OPENAI_NON_CHAT.test(id))
		.map((id) => ({ id }));
}

export function parseAnthropicModels(json: unknown): DiscoveredModel[] {
	return parseDataList(json).map((m) => withoutUndefined({ id: m.id as string, name: str(m.display_name) }));
}

export function parseGoogleModels(json: unknown): DiscoveredModel[] {
	if (!isRecord(json) || !Array.isArray(json.models)) return [];
	const out: DiscoveredModel[] = [];
	for (const m of json.models) {
		if (!isRecord(m) || typeof m.name !== "string") continue;
		const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
		if (!methods.includes("generateContent")) continue;
		out.push(
			withoutUndefined({
				id: m.name.replace(/^models\//, ""),
				name: str(m.displayName),
				contextWindow: num(m.inputTokenLimit),
				maxTokens: num(m.outputTokenLimit),
				input: ["text", "image"],
			}),
		);
	}
	return out;
}

export function parseMistralModels(json: unknown): DiscoveredModel[] {
	const out: DiscoveredModel[] = [];
	for (const m of parseDataList(json)) {
		const caps = isRecord(m.capabilities) ? m.capabilities : {};
		if (caps.completion_chat === false) continue;
		out.push(
			withoutUndefined({
				id: m.id as string,
				contextWindow: num(m.max_context_length),
				input: caps.vision === true ? ["text", "image"] : ["text"],
			}),
		);
	}
	return out;
}

export function parseOpenRouterModels(json: unknown): DiscoveredModel[] {
	return parseDataList(json).map((m) => {
		const pricing = isRecord(m.pricing) ? m.pricing : {};
		const arch = isRecord(m.architecture) ? m.architecture : {};
		const modalities = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
		const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
		const top = isRecord(m.top_provider) ? m.top_provider : {};
		return withoutUndefined({
			id: m.id as string,
			name: str(m.name),
			contextWindow: num(m.context_length),
			maxTokens: num(top.max_completion_tokens),
			input: modalities.includes("image") ? ["text", "image"] : ["text"],
			reasoning: params.includes("reasoning"),
			cost: {
				input: perMillion(pricing.prompt),
				output: perMillion(pricing.completion),
				cacheRead: perMillion(pricing.input_cache_read),
				cacheWrite: perMillion(pricing.input_cache_write),
			},
		});
	});
}

export function parseVercelModels(json: unknown): DiscoveredModel[] {
	return parseDataList(json).map((m) => {
		const pricing = isRecord(m.pricing) ? m.pricing : undefined;
		return withoutUndefined({
			id: m.id as string,
			name: str(m.name),
			contextWindow: num(m.context_window),
			maxTokens: num(m.max_tokens),
			cost: pricing
				? { input: perMillion(pricing.input), output: perMillion(pricing.output), cacheRead: 0, cacheWrite: 0 }
				: undefined,
		});
	});
}

export function parseGroqModels(json: unknown): DiscoveredModel[] {
	return parseDataList(json).map((m) =>
		withoutUndefined({
			id: m.id as string,
			contextWindow: num(m.context_window),
			maxTokens: num(m.max_completion_tokens),
		}),
	);
}

export function parseCopilotModels(json: unknown): DiscoveredModel[] {
	const out: DiscoveredModel[] = [];
	for (const m of parseDataList(json)) {
		if (m.model_picker_enabled === false) continue;
		const caps = isRecord(m.capabilities) ? m.capabilities : {};
		if ((caps.type ?? "chat") !== "chat") continue;
		const limits = isRecord(caps.limits) ? caps.limits : {};
		const supports = isRecord(caps.supports) ? caps.supports : {};
		out.push(
			withoutUndefined({
				id: m.id as string,
				name: str(m.name),
				contextWindow: num(limits.max_context_window_tokens),
				maxTokens: num(limits.max_output_tokens),
				input: supports.vision === true ? ["text", "image"] : ["text"],
			}),
		);
	}
	return out;
}

export function parseCodexModels(json: unknown): DiscoveredModel[] {
	if (!isRecord(json) || !Array.isArray(json.models)) return [];
	const out: DiscoveredModel[] = [];
	for (const m of json.models) {
		if (!isRecord(m) || typeof m.slug !== "string" || m.visibility !== "list") continue;
		const modalities = Array.isArray(m.input_modalities) ? m.input_modalities : ["text"];
		const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
		out.push(
			withoutUndefined({
				id: m.slug,
				name: str(m.display_name),
				contextWindow: num(m.context_window),
				input: modalities.includes("image") ? ["text", "image"] : ["text"],
				reasoning: levels.length > 0,
				priority: num(m.priority),
			}),
		);
	}
	return out;
}

function parsePlain(json: unknown): DiscoveredModel[] {
	return parseDataList(json).map((m) => ({ id: m.id as string }));
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const response = await fetch(url, { headers });
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	return response.json();
}

function bearer(auth: ProviderAuth): Record<string, string> {
	return { Authorization: `Bearer ${auth.token}` };
}

interface DiscoverySource {
	url: (auth: ProviderAuth) => string;
	headers: (auth: ProviderAuth) => Record<string, string>;
	parse: (json: unknown) => DiscoveredModel[];
}

const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

const SOURCES: Record<string, DiscoverySource> = {
	anthropic: {
		url: () => "https://api.anthropic.com/v1/models?limit=1000",
		headers: (auth) =>
			auth.isOAuth
				? {
						Authorization: `Bearer ${auth.token}`,
						"anthropic-version": "2023-06-01",
						"anthropic-beta": "oauth-2025-04-20",
						"anthropic-dangerous-direct-browser-access": "true",
					}
				: {
						"x-api-key": auth.token,
						"anthropic-version": "2023-06-01",
						"anthropic-dangerous-direct-browser-access": "true",
					},
		parse: parseAnthropicModels,
	},
	openai: { url: () => "https://api.openai.com/v1/models", headers: bearer, parse: parseOpenAIModels },
	google: {
		url: (auth) => `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(auth.token)}`,
		headers: () => ({}),
		parse: parseGoogleModels,
	},
	groq: { url: () => "https://api.groq.com/openai/v1/models", headers: bearer, parse: parseGroqModels },
	openrouter: { url: () => "https://openrouter.ai/api/v1/models", headers: () => ({}), parse: parseOpenRouterModels },
	xai: { url: () => "https://api.x.ai/v1/models", headers: bearer, parse: parsePlain },
	mistral: { url: () => "https://api.mistral.ai/v1/models", headers: bearer, parse: parseMistralModels },
	cerebras: { url: () => "https://api.cerebras.ai/v1/models", headers: bearer, parse: parsePlain },
	huggingface: { url: () => "https://router.huggingface.co/v1/models", headers: bearer, parse: parsePlain },
	"vercel-ai-gateway": { url: () => "https://ai-gateway.vercel.sh/v1/models", headers: bearer, parse: parseVercelModels },
	"github-copilot": {
		url: (auth) => `${getGitHubCopilotBaseUrl(auth.token)}/models`,
		headers: (auth) => ({ ...COPILOT_HEADERS, ...bearer(auth) }),
		parse: parseCopilotModels,
	},
	"openai-codex": {
		url: () => `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
		headers: (auth) => {
			const accountId = getCodexAccountId(auth.token);
			if (!accountId) throw new Error("Codex token has no account id");
			return { ...bearer(auth), "chatgpt-account-id": accountId };
		},
		parse: parseCodexModels,
	},
};

export function hasDiscovery(provider: string): boolean {
	return provider in SOURCES;
}

export async function discoverBuiltinModels(provider: string, auth: ProviderAuth): Promise<DiscoveredModel[]> {
	const source = SOURCES[provider];
	if (!source) return [];
	return source.parse(await getJson(source.url(auth), source.headers(auth)));
}

export function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

export async function discoverOpenAICompatible(baseUrl: string, apiKey?: string): Promise<DiscoveredModel[]> {
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	return parsePlain(await getJson(`${normalizeBaseUrl(baseUrl)}/v1/models`, headers));
}

export async function discoverOllama(baseUrl: string): Promise<DiscoveredModel[]> {
	const ollama = new Ollama({ host: normalizeBaseUrl(baseUrl) });
	const { models } = await ollama.list();
	const out: DiscoveredModel[] = [];
	for (const m of models) {
		try {
			const details = await ollama.show({ model: m.name });
			const capabilities: string[] = (details as { capabilities?: string[] }).capabilities ?? [];
			if (!capabilities.includes("tools")) continue;
			// ollama types model_info as a Map but the wire format is a plain object
			const info = (details.model_info ?? {}) as unknown as Record<string, unknown>;
			const arch = typeof info["general.architecture"] === "string" ? info["general.architecture"] : "";
			const contextWindow = num(info[`${arch}.context_length`]);
			out.push(
				withoutUndefined({
					id: m.name,
					name: m.name,
					contextWindow,
					reasoning: capabilities.includes("thinking"),
					input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
				}),
			);
		} catch (error) {
			console.warn(`[discovery] ollama show failed for ${m.name}:`, error);
		}
	}
	return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests in `test/discovery.test.ts` PASS.

If `ollama/browser` fails to import under Node, the error names that module. Its `dist/browser.mjs` uses global `fetch`, which Node 26 has, so this should not happen; if it does, report it rather than mocking.

- [ ] **Step 6: Run checks**

Run: `./check.sh`
Expected: no errors. Biome may reformat; that is fine.

---

### Task 2: Resolution rules: protocol, pricing, merge, Codex fallback

**Files:**
- Create: `src/models/resolve.ts`
- Create: `test/resolve.test.ts`

**Interfaces:**
- Consumes: `DiscoveredModel`, `ModelCost` from Task 1; `getModels`, `getProviders`, `Model`, `Api` from `@mariozechner/pi-ai`.
- Produces:
  - `interface ModelBase { api: Api; baseUrl: string; headers?: Record<string, string>; compat?: unknown }`
  - `interface AvailableModel { model: Model<Api>; discovered: boolean; unknownCost: boolean; priority?: number }`
  - `type PricingOverrides = Record<string, ModelCost>` keyed `"<provider>/<id>"`
  - `function pricingKey(provider: string, id: string): string`
  - `function resolveApi(provider: string, id: string): Api | undefined`
  - `function stripVendorPrefix(id: string): string`
  - `function inheritCatalogPricing(id: string): ModelCost | undefined`
  - `function resolvePricing(provider: string, discovered: DiscoveredModel, overrides: PricingOverrides): { cost: ModelCost; unknownCost: boolean }`
  - `function toModel(provider: string, base: ModelBase, discovered: DiscoveredModel, overrides: PricingOverrides): AvailableModel`
  - `function customProviderBase(type: "openai-compatible" | "ollama", baseUrl: string): ModelBase`
  - `function mergeWithCatalog(provider: string, discovered: DiscoveredModel[], overrides: PricingOverrides): AvailableModel[]`
  - `function applyOverride(model: Model<Api>, overrides: PricingOverrides): Model<Api>`
  - `const CODEX_FALLBACK_MODEL: Model<Api>`
  - `const ZERO_COST: ModelCost`

- [ ] **Step 1: Write the failing tests**

Create `test/resolve.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { getModels } from "@mariozechner/pi-ai";
import {
	CODEX_FALLBACK_MODEL,
	customProviderBase,
	inheritCatalogPricing,
	mergeWithCatalog,
	parsePrice,
	pricingKey,
	resolveApi,
	resolvePricing,
	stripVendorPrefix,
	toModel,
} from "../src/models/resolve.js";

test("parsePrice rejects negatives and junk, accepts blank as zero", () => {
	assert.equal(parsePrice("-1"), undefined);
	assert.equal(parsePrice("abc"), undefined);
	assert.equal(parsePrice("1e5"), undefined);
	assert.equal(parsePrice(""), 0);
	assert.equal(parsePrice("3.5"), 3.5);
	assert.equal(parsePrice(" 15 "), 15);
});

test("resolveApi picks the newest family member on Copilot ties", () => {
	assert.equal(resolveApi("github-copilot", "gpt-6-sol"), "openai-responses");
	assert.equal(resolveApi("github-copilot", "claude-opus-5"), "anthropic-messages");
	assert.equal(resolveApi("github-copilot", "gemini-4-pro"), "openai-completions");
	assert.equal(resolveApi("github-copilot", "llama-9"), undefined);
});

test("resolveApi uses the single api for homogeneous providers", () => {
	assert.equal(resolveApi("anthropic", "claude-something-new"), "anthropic-messages");
	assert.equal(resolveApi("openrouter", "totally/unknown"), "openai-completions");
});

test("stripVendorPrefix", () => {
	assert.equal(stripVendorPrefix("anthropic/claude-sonnet-4-6"), "claude-sonnet-4-6");
	assert.equal(stripVendorPrefix("claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("inheritCatalogPricing finds a catalog model by exact or stripped id", () => {
	const catalog = getModels("anthropic").find((m) => m.id === "claude-sonnet-4-6");
	assert.ok(catalog);
	assert.deepEqual(inheritCatalogPricing("claude-sonnet-4-6"), catalog.cost);
	assert.deepEqual(inheritCatalogPricing("anthropic/claude-sonnet-4-6"), catalog.cost);
	assert.equal(inheritCatalogPricing("no-such-model-xyz"), undefined);
});

test("resolvePricing order: override, response, catalog, unknown", () => {
	const override = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
	const fromResponse = { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 };
	const key = pricingKey("local", "claude-sonnet-4-6");
	assert.deepEqual(resolvePricing("local", { id: "claude-sonnet-4-6", cost: fromResponse }, { [key]: override }), {
		cost: override,
		unknownCost: false,
	});
	assert.deepEqual(resolvePricing("local", { id: "claude-sonnet-4-6", cost: fromResponse }, {}), {
		cost: fromResponse,
		unknownCost: false,
	});
	const inherited = resolvePricing("local", { id: "claude-sonnet-4-6" }, {});
	assert.equal(inherited.unknownCost, false);
	assert.ok(inherited.cost.input > 0);
	assert.deepEqual(resolvePricing("local", { id: "mystery-7b" }, {}), {
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		unknownCost: true,
	});
});

test("customProviderBase appends /v1 exactly once", () => {
	assert.equal(customProviderBase("openai-compatible", "http://localhost:8080/").baseUrl, "http://localhost:8080/v1");
	assert.equal(customProviderBase("openai-compatible", "http://localhost:8080//").baseUrl, "http://localhost:8080/v1");
	assert.equal(customProviderBase("ollama", "http://localhost:11434").baseUrl, "http://localhost:11434/v1");
	assert.equal(customProviderBase("ollama", "http://localhost:11434").api, "openai-completions");
});

test("toModel fills defaults and reads baseUrl from the base, not the discovered record", () => {
	const base = customProviderBase("openai-compatible", "http://box:1234");
	const { model, discovered, unknownCost } = toModel("box", base, { id: "mystery-7b" }, {});
	assert.equal(model.provider, "box");
	assert.equal(model.baseUrl, "http://box:1234/v1");
	assert.equal(model.contextWindow, 128000);
	assert.equal(model.maxTokens, 8192);
	assert.deepEqual(model.input, ["text"]);
	assert.equal(model.reasoning, false);
	assert.equal(discovered, true);
	assert.equal(unknownCost, true);
});

test("mergeWithCatalog keeps catalog entry and pricing on id collision", () => {
	const merged = mergeWithCatalog("anthropic", [{ id: "claude-sonnet-4-6" }, { id: "claude-opus-9" }], {});
	const sonnet = merged.filter((m) => m.model.id === "claude-sonnet-4-6");
	assert.equal(sonnet.length, 1);
	assert.equal(sonnet[0].discovered, false);
	assert.ok(sonnet[0].model.cost.input > 0);
	const opus9 = merged.find((m) => m.model.id === "claude-opus-9");
	assert.ok(opus9);
	assert.equal(opus9.discovered, true);
	assert.equal(opus9.model.api, "anthropic-messages");
});

test("mergeWithCatalog drops discovered models with unresolvable protocol", () => {
	const merged = mergeWithCatalog("github-copilot", [{ id: "llama-9" }], {});
	assert.equal(merged.some((m) => m.model.id === "llama-9"), false);
});

test("CODEX_FALLBACK_MODEL is a complete Codex model", () => {
	assert.equal(CODEX_FALLBACK_MODEL.provider, "openai-codex");
	assert.equal(CODEX_FALLBACK_MODEL.id, "gpt-6-sol");
	assert.equal(CODEX_FALLBACK_MODEL.api, "openai-codex-responses");
	assert.equal(CODEX_FALLBACK_MODEL.baseUrl, "https://chatgpt.com/backend-api");
	assert.equal(CODEX_FALLBACK_MODEL.contextWindow, 272000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: `test/resolve.test.ts` FAILS with "Cannot find module '../src/models/resolve.js'"; `discovery.test.ts` still passes.

- [ ] **Step 3: Write `src/models/resolve.ts`**

```ts
/**
 * Pure rules for turning discovered ids into usable Model objects:
 * protocol resolution, pricing resolution, catalog merge, Codex fallback.
 */
import { type Api, getModels, getProviders, type Model } from "@mariozechner/pi-ai";
import type { DiscoveredModel, ModelCost } from "./discovery.js";
import { normalizeBaseUrl } from "./discovery.js";

export const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface ModelBase {
	api: Api;
	baseUrl: string;
	headers?: Record<string, string>;
	compat?: unknown;
}

export interface AvailableModel {
	model: Model<Api>;
	discovered: boolean;
	unknownCost: boolean;
	priority?: number;
}

export type PricingOverrides = Record<string, ModelCost>;

export function pricingKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

function catalogModels(provider: string): Model<Api>[] {
	return getModels(provider as Parameters<typeof getModels>[0]) as Model<Api>[];
}

function commonPrefixLength(a: string, b: string): number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
}

/**
 * Pick the API protocol for a discovered id on a built-in provider.
 * One protocol in the catalog: use it. Mixed: nearest catalog id by common
 * prefix, ties to the lexicographically greatest id (newest family member).
 * No shared prefix at all: undefined, caller excludes the model.
 */
export function resolveApi(provider: string, id: string): Api | undefined {
	const models = catalogModels(provider);
	if (models.length === 0) return undefined;
	const apis = new Set(models.map((m) => m.api));
	if (apis.size === 1) return models[0].api;
	let best: Model<Api> | undefined;
	let bestLen = 0;
	for (const m of models) {
		const len = commonPrefixLength(id, m.id);
		if (len > bestLen || (len === bestLen && best && m.id > best.id)) {
			best = m;
			bestLen = len;
		}
	}
	return bestLen > 0 && best ? best.api : undefined;
}

export function stripVendorPrefix(id: string): string {
	const slash = id.indexOf("/");
	return slash >= 0 ? id.slice(slash + 1) : id;
}

function isZero(cost: ModelCost): boolean {
	return cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0;
}

/** Pricing of any catalog model whose id equals the id or its vendor-stripped form. */
export function inheritCatalogPricing(id: string): ModelCost | undefined {
	const candidates = new Set([id, stripVendorPrefix(id)]);
	for (const provider of getProviders()) {
		for (const m of catalogModels(provider)) {
			if (candidates.has(m.id) && !isZero(m.cost)) return { ...m.cost };
		}
	}
	return undefined;
}

export function resolvePricing(
	provider: string,
	discovered: DiscoveredModel,
	overrides: PricingOverrides,
): { cost: ModelCost; unknownCost: boolean } {
	const override = overrides[pricingKey(provider, discovered.id)];
	if (override) return { cost: { ...override }, unknownCost: false };
	if (discovered.cost && !isZero(discovered.cost)) return { cost: { ...discovered.cost }, unknownCost: false };
	const inherited = inheritCatalogPricing(discovered.id);
	if (inherited) return { cost: inherited, unknownCost: false };
	return { cost: { ...ZERO_COST }, unknownCost: true };
}

export function toModel(
	provider: string,
	base: ModelBase,
	discovered: DiscoveredModel,
	overrides: PricingOverrides,
): AvailableModel {
	const { cost, unknownCost } = resolvePricing(provider, discovered, overrides);
	const model: Model<Api> = {
		id: discovered.id,
		name: discovered.name ?? discovered.id,
		api: base.api,
		provider,
		baseUrl: base.baseUrl,
		reasoning: discovered.reasoning ?? false,
		input: discovered.input ?? ["text"],
		cost,
		contextWindow: discovered.contextWindow ?? 128000,
		maxTokens: discovered.maxTokens ?? 8192,
	};
	if (base.headers) model.headers = { ...base.headers };
	if (base.compat !== undefined) (model as { compat?: unknown }).compat = base.compat;
	return { model, discovered: true, unknownCost, priority: discovered.priority };
}

// ponytail: both types speak OpenAI completions at /v1; the type only matters for discovery
export function customProviderBase(_type: "openai-compatible" | "ollama", baseUrl: string): ModelBase {
	return { api: "openai-completions", baseUrl: `${normalizeBaseUrl(baseUrl)}/v1` };
}

/** Parse a non-negative dollar amount typed by a user; undefined when invalid, blank means zero. */
export function parsePrice(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return 0;
	if (!/^\d*(\.\d+)?$/.test(trimmed)) return undefined;
	const n = Number.parseFloat(trimmed);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function applyOverride(model: Model<Api>, overrides: PricingOverrides): Model<Api> {
	const override = overrides[pricingKey(model.provider, model.id)];
	return override ? { ...model, cost: { ...override } } : model;
}

/** Catalog models plus discovered extras for a built-in provider. Catalog wins on id collision. */
export function mergeWithCatalog(
	provider: string,
	discovered: DiscoveredModel[],
	overrides: PricingOverrides,
): AvailableModel[] {
	const catalog = catalogModels(provider);
	const out: AvailableModel[] = catalog.map((m) => ({
		model: applyOverride(m, overrides),
		discovered: false,
		unknownCost: false,
	}));
	const known = new Set(catalog.map((m) => m.id));
	for (const d of discovered) {
		if (known.has(d.id)) continue;
		const api = resolveApi(provider, d.id);
		if (!api) {
			console.warn(`[models] ${provider}/${d.id}: unknown model family, excluded`);
			continue;
		}
		const template = catalog.find((m) => m.api === api) ?? catalog[0];
		const base: ModelBase = { api, baseUrl: template.baseUrl, headers: template.headers, compat: template.compat };
		out.push(toModel(provider, base, d, overrides));
		known.add(d.id);
	}
	return out;
}

function buildCodexFallback(): Model<Api> {
	const template = catalogModels("openai-codex")[0];
	return {
		id: "gpt-6-sol",
		name: "GPT-6-Sol",
		api: template?.api ?? ("openai-codex-responses" as Api),
		provider: "openai-codex",
		baseUrl: template?.baseUrl ?? "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { ...ZERO_COST },
		contextWindow: 272000,
		maxTokens: template?.maxTokens ?? 128000,
	};
}

export const CODEX_FALLBACK_MODEL: Model<Api> = buildCodexFallback();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS. If `resolveApi("github-copilot", "gpt-6-sol")` returns `openai-completions`, the tie rule is wrong: the greatest `gpt-*` id in the Copilot catalog must be a gpt-5 entry. Check with `node -e` against `models.generated.js` before changing the rule.

- [ ] **Step 5: Run checks**

Run: `./check.sh`
Expected: clean.

---

### Task 3: Storage-backed catalog with cache, refresh and custom providers

**Files:**
- Create: `src/models/catalog.ts`

**Interfaces:**
- Consumes: Task 1 fetchers, Task 2 rules, `getSitegeistStorage()` from `src/storage/app-storage.ts`, `isOAuthCredentials`, `resolveApiKey` from `src/oauth/index.ts`, `CustomProvider`, `CustomProvidersStore` types from `@mariozechner/pi-web-ui`.
- Produces:
  - `type SitegeistProviderType = "openai-compatible" | "ollama"`
  - `interface SitegeistCustomProvider { id: string; name: string; type: SitegeistProviderType; baseUrl: string; apiKey?: string }`
  - `async function getCustomProviders(): Promise<SitegeistCustomProvider[]>`
  - `async function saveCustomProvider(provider: SitegeistCustomProvider, previousName?: string): Promise<void>`
  - `async function deleteCustomProvider(id: string): Promise<void>`
  - `async function findCustomProvider(name: string): Promise<SitegeistCustomProvider | undefined>`
  - `async function discoverCustomProvider(provider: SitegeistCustomProvider): Promise<DiscoveredModel[]>`
  - `async function getProvidersWithCredentials(): Promise<string[]>`
  - `async function getAvailableModels(): Promise<AvailableModel[]>`
  - `async function refreshDiscoveredModels(opts?: { keys?: string[]; force?: boolean }): Promise<void>`
  - `async function getPricingOverrides(): Promise<PricingOverrides>`
  - `async function setModelPricing(provider: string, id: string, cost: ModelCost | null): Promise<void>`
  - `function customCacheKey(id: string): string`
  - `async function isStale(): Promise<boolean>`

- [ ] **Step 1: Write `src/models/catalog.ts`**

```ts
/**
 * Single source of truth for "what models exist": catalog for providers with
 * credentials, discovered extras from a settings cache, custom providers.
 */
import { type Api, getProviders, type Model } from "@mariozechner/pi-ai";
import type { CustomProvider } from "@mariozechner/pi-web-ui";
import { isOAuthCredentials, resolveApiKey } from "../oauth/index.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import {
	type DiscoveredModel,
	discoverBuiltinModels,
	discoverOllama,
	discoverOpenAICompatible,
	hasDiscovery,
	type ModelCost,
	type ProviderAuth,
} from "./discovery.js";
import {
	type AvailableModel,
	CODEX_FALLBACK_MODEL,
	customProviderBase,
	mergeWithCatalog,
	type PricingOverrides,
	pricingKey,
	toModel,
} from "./resolve.js";

const CACHE_KEY = "discoveredModels";
const PRICING_KEY = "modelPricing";
const TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
	fetchedAt: number;
	models: DiscoveredModel[];
}
type Cache = Record<string, CacheEntry>;

export type SitegeistProviderType = "openai-compatible" | "ollama";

export interface SitegeistCustomProvider {
	id: string;
	name: string;
	type: SitegeistProviderType;
	baseUrl: string;
	apiKey?: string;
}

export function customCacheKey(id: string): string {
	return `custom:${id}`;
}

async function readCache(): Promise<Cache> {
	return (await getSitegeistStorage().settings.get<Cache>(CACHE_KEY)) ?? {};
}

async function writeCache(cache: Cache): Promise<void> {
	await getSitegeistStorage().settings.set(CACHE_KEY, cache);
}

export async function getPricingOverrides(): Promise<PricingOverrides> {
	return (await getSitegeistStorage().settings.get<PricingOverrides>(PRICING_KEY)) ?? {};
}

export async function setModelPricing(provider: string, id: string, cost: ModelCost | null): Promise<void> {
	const overrides = await getPricingOverrides();
	const key = pricingKey(provider, id);
	if (cost) overrides[key] = cost;
	else delete overrides[key];
	await getSitegeistStorage().settings.set(PRICING_KEY, overrides);
}

// ---------------------------------------------------------------------------
// Custom providers (pi-web-ui store, sitegeist's narrower type)
// ---------------------------------------------------------------------------

function isSitegeistType(type: string): type is SitegeistProviderType {
	return type === "openai-compatible" || type === "ollama";
}

export async function getCustomProviders(): Promise<SitegeistCustomProvider[]> {
	const all = await getSitegeistStorage().customProviders.getAll();
	const out: SitegeistCustomProvider[] = [];
	for (const p of all) {
		if (!isSitegeistType(p.type)) continue;
		out.push({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, apiKey: p.apiKey });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function findCustomProvider(name: string): Promise<SitegeistCustomProvider | undefined> {
	return (await getCustomProviders()).find((p) => p.name === name);
}

export async function discoverCustomProvider(provider: SitegeistCustomProvider): Promise<DiscoveredModel[]> {
	return provider.type === "ollama"
		? discoverOllama(provider.baseUrl)
		: discoverOpenAICompatible(provider.baseUrl, provider.apiKey);
}

async function movePricing(fromProvider: string, toProvider: string): Promise<void> {
	const overrides = await getPricingOverrides();
	const prefix = `${fromProvider}/`;
	let changed = false;
	for (const key of Object.keys(overrides)) {
		if (!key.startsWith(prefix)) continue;
		const cost = overrides[key];
		delete overrides[key];
		if (toProvider) overrides[`${toProvider}/${key.slice(prefix.length)}`] = cost;
		changed = true;
	}
	if (changed) await getSitegeistStorage().settings.set(PRICING_KEY, overrides);
}

async function fixLastUsedModel(fromProvider: string, toProvider: string | null): Promise<void> {
	const settings = getSitegeistStorage().settings;
	const last = await settings.get<Model<Api>>("lastUsedModel");
	if (!last || last.provider !== fromProvider) return;
	if (toProvider) await settings.set("lastUsedModel", { ...last, provider: toProvider });
	else await settings.delete("lastUsedModel");
}

/** Persist a provider, drop its cache entry, and re-discover. `previousName` handles renames. */
export async function saveCustomProvider(provider: SitegeistCustomProvider, previousName?: string): Promise<void> {
	const stored: CustomProvider = {
		id: provider.id,
		name: provider.name,
		type: provider.type as unknown as CustomProvider["type"],
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey,
	};
	await getSitegeistStorage().customProviders.set(stored);
	if (previousName && previousName !== provider.name) {
		await movePricing(previousName, provider.name);
		await fixLastUsedModel(previousName, provider.name);
	}
	const cache = await readCache();
	delete cache[customCacheKey(provider.id)];
	await writeCache(cache);
	await refreshDiscoveredModels({ keys: [customCacheKey(provider.id)], force: true });
}

export async function deleteCustomProvider(id: string): Promise<void> {
	const existing = (await getCustomProviders()).find((p) => p.id === id);
	await getSitegeistStorage().customProviders.delete(id);
	const cache = await readCache();
	delete cache[customCacheKey(id)];
	await writeCache(cache);
	if (existing) {
		await movePricing(existing.name, "");
		await fixLastUsedModel(existing.name, null);
	}
}

// ---------------------------------------------------------------------------
// Built-in credentials
// ---------------------------------------------------------------------------

export async function getProvidersWithCredentials(): Promise<string[]> {
	const storage = getSitegeistStorage();
	const result: string[] = [];
	for (const provider of await storage.providerKeys.list()) {
		if (await storage.providerKeys.get(provider)) result.push(provider);
	}
	return result.sort();
}

async function providerAuth(provider: string): Promise<ProviderAuth | undefined> {
	const storage = getSitegeistStorage();
	const stored = await storage.providerKeys.get(provider);
	if (!stored) return undefined;
	const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const proxyUrl = proxyEnabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
	const token = await resolveApiKey(stored, provider, storage.providerKeys, proxyUrl);
	return { token, isOAuth: isOAuthCredentials(stored) };
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export async function isStale(): Promise<boolean> {
	const cache = await readCache();
	const now = Date.now();
	for (const provider of await getProvidersWithCredentials()) {
		if (!hasDiscovery(provider)) continue;
		const entry = cache[provider];
		if (!entry || now - entry.fetchedAt > TTL_MS) return true;
	}
	for (const custom of await getCustomProviders()) {
		const entry = cache[customCacheKey(custom.id)];
		if (!entry || now - entry.fetchedAt > TTL_MS) return true;
	}
	return false;
}

/**
 * Re-run discovery for stale entries (or all with `force`), optionally limited
 * to the given cache keys. Failures keep the previous entry and log a warning.
 */
export async function refreshDiscoveredModels(opts: { keys?: string[]; force?: boolean } = {}): Promise<void> {
	const cache = await readCache();
	const now = Date.now();
	const wanted = opts.keys ? new Set(opts.keys) : undefined;
	const due = (key: string) => {
		if (wanted && !wanted.has(key)) return false;
		if (opts.force) return true;
		const entry = cache[key];
		return !entry || now - entry.fetchedAt > TTL_MS;
	};

	const jobs: Promise<void>[] = [];

	for (const provider of await getProvidersWithCredentials()) {
		if (!hasDiscovery(provider) || !due(provider)) continue;
		jobs.push(
			(async () => {
				try {
					const auth = await providerAuth(provider);
					if (!auth) return;
					const models = await discoverBuiltinModels(provider, auth);
					cache[provider] = { fetchedAt: Date.now(), models };
				} catch (error) {
					console.warn(`[models] discovery failed for ${provider}:`, error);
				}
			})(),
		);
	}

	for (const custom of await getCustomProviders()) {
		const key = customCacheKey(custom.id);
		if (!due(key)) continue;
		jobs.push(
			(async () => {
				try {
					const models = await discoverCustomProvider(custom);
					cache[key] = { fetchedAt: Date.now(), models };
				} catch (error) {
					console.warn(`[models] discovery failed for custom provider ${custom.name}:`, error);
				}
			})(),
		);
	}

	await Promise.all(jobs);
	await writeCache(cache);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export async function getAvailableModels(): Promise<AvailableModel[]> {
	const [cache, overrides, providers, customs] = await Promise.all([
		readCache(),
		getPricingOverrides(),
		getProvidersWithCredentials(),
		getCustomProviders(),
	]);
	const known = new Set<string>(getProviders());
	const out: AvailableModel[] = [];

	for (const provider of providers) {
		if (!known.has(provider)) continue;
		const discovered = cache[provider]?.models ?? [];
		if (provider === "openai-codex") {
			if (discovered.length === 0) {
				out.push({ model: CODEX_FALLBACK_MODEL, discovered: false, unknownCost: false });
				continue;
			}
			const base = {
				api: CODEX_FALLBACK_MODEL.api,
				baseUrl: CODEX_FALLBACK_MODEL.baseUrl,
				headers: CODEX_FALLBACK_MODEL.headers,
			};
			const models = discovered.map((d) => toModel(provider, base, d, overrides));
			for (const m of models) m.unknownCost = false;
			models.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
			out.push(...models);
			continue;
		}
		out.push(...mergeWithCatalog(provider, discovered, overrides));
	}

	for (const custom of customs) {
		const base = customProviderBase(custom.type, custom.baseUrl);
		for (const d of cache[customCacheKey(custom.id)]?.models ?? []) {
			out.push(toModel(custom.name, base, d, overrides));
		}
	}

	return out;
}
```

- [ ] **Step 2: Run checks**

Run: `./check.sh`
Expected: clean. The cast `provider.type as unknown as CustomProvider["type"]` is deliberate: the pi-web-ui store does not validate `type`, and the spec widens it.

- [ ] **Step 3: Run tests to confirm nothing regressed**

Run: `npm test`
Expected: PASS. `catalog.ts` is not imported by tests because it needs IndexedDB.

---

### Task 4: Model picker and pricing dialog

**Files:**
- Create: `src/dialogs/ModelPricingDialog.ts`
- Create: `src/dialogs/ModelPickerDialog.ts`

**Interfaces:**
- Consumes: `getAvailableModels`, `refreshDiscoveredModels`, `isStale`, `setModelPricing`, `getPricingOverrides` from Task 3; `AvailableModel`, `pricingKey` from Task 2; `ModelCost` from Task 1.
- Produces:
  - `ModelPricingDialog.open(model: Model<Api>, onSaved: () => void): void`
  - `ModelPickerDialog.open(currentModel: Model<Api> | null, onSelect: (model: Model<Api>) => void): void`

- [ ] **Step 1: Write `src/dialogs/ModelPricingDialog.ts`**

```ts
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import type { Api, Model } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { ModelCost } from "../models/discovery.js";
import { getPricingOverrides, setModelPricing } from "../models/catalog.js";
import { parsePrice, pricingKey } from "../models/resolve.js";

const FIELDS: Array<{ key: keyof ModelCost; label: string }> = [
	{ key: "input", label: "Input ($ per million tokens)" },
	{ key: "output", label: "Output ($ per million tokens)" },
	{ key: "cacheRead", label: "Cache read ($ per million tokens)" },
	{ key: "cacheWrite", label: "Cache write ($ per million tokens)" },
];

@customElement("model-pricing-dialog")
export class ModelPricingDialog extends DialogBase {
	private model!: Model<Api>;
	private onSaved?: () => void;
	@state() private values: Record<keyof ModelCost, string> = { input: "", output: "", cacheRead: "", cacheWrite: "" };
	@state() private hasOverride = false;
	@state() private error = "";

	protected override modalWidth = "min(420px, 90vw)";
	protected override modalHeight = "auto";

	static open(model: Model<Api>, onSaved: () => void) {
		const dialog = new ModelPricingDialog();
		dialog.model = model;
		dialog.onSaved = onSaved;
		dialog.values = {
			input: String(model.cost.input),
			output: String(model.cost.output),
			cacheRead: String(model.cost.cacheRead),
			cacheWrite: String(model.cost.cacheWrite),
		};
		dialog.open();
		getPricingOverrides().then((o) => {
			dialog.hasOverride = pricingKey(model.provider, model.id) in o;
		});
	}

	private async save() {
		const cost: Partial<ModelCost> = {};
		for (const { key, label } of FIELDS) {
			const n = parsePrice(this.values[key]);
			if (n === undefined) {
				this.error = `${label}: enter a non-negative number`;
				return;
			}
			cost[key] = n;
		}
		await setModelPricing(this.model.provider, this.model.id, cost as ModelCost);
		this.onSaved?.();
		this.close();
	}

	private async reset() {
		await setModelPricing(this.model.provider, this.model.id, null);
		this.onSaved?.();
		this.close();
	}

	protected override renderContent(): TemplateResult {
		return html`
			<div class="p-6 flex flex-col gap-4">
				${DialogHeader({ title: `Pricing for ${this.model.provider}/${this.model.id}` })}
				${FIELDS.map(
					({ key, label }) => html`
						<div class="flex flex-col gap-1">
							${Label({ htmlFor: `price-${key}`, children: label })}
							${Input({
								value: this.values[key],
								placeholder: "0",
								onInput: (e: Event) => {
									this.values = { ...this.values, [key]: (e.target as HTMLInputElement).value };
									this.error = "";
								},
							})}
						</div>
					`,
				)}
				${this.error ? html`<div class="text-sm text-destructive">${this.error}</div>` : ""}
				<div class="flex justify-end gap-2">
					${this.hasOverride ? Button({ variant: "ghost", onClick: () => this.reset(), children: "Reset" }) : ""}
					${Button({ variant: "ghost", onClick: () => this.close(), children: "Cancel" })}
					${Button({ variant: "default", onClick: () => this.save(), children: "Save" })}
				</div>
			</div>
		`;
	}
}
```

- [ ] **Step 2: Confirm the price-validation test still passes (Review Focus item 5)**

`parsePrice` lives in `src/models/resolve.ts` (Task 2) so it stays testable without Lit. The dialog only imports it.

Run: `npm test`. Expected: PASS, including "parsePrice rejects negatives and junk".

- [ ] **Step 3: Write `src/dialogs/ModelPickerDialog.ts`**

Adapted from pi-web-ui's `ModelSelector` (search, filters, keyboard nav retained).

```ts
import { icon } from "@mariozechner/mini-lit";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { type Api, getProviders, type Model, modelsAreEqual } from "@mariozechner/pi-ai";
import { formatModelCost, Input } from "@mariozechner/pi-web-ui";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Brain, Image as ImageIcon, Pencil, RefreshCw } from "lucide";
import { getAvailableModels, isStale, refreshDiscoveredModels } from "../models/catalog.js";
import type { AvailableModel } from "../models/resolve.js";
import { ModelPricingDialog } from "./ModelPricingDialog.js";

function subsequenceScore(query: string, text: string): number {
	let qi = 0;
	let ti = 0;
	let gaps = 0;
	let lastMatchIndex = -1;
	while (qi < query.length && ti < text.length) {
		if (query[qi] === text[ti]) {
			if (lastMatchIndex >= 0) gaps += ti - lastMatchIndex - 1;
			lastMatchIndex = ti;
			qi++;
		}
		ti++;
	}
	if (qi < query.length) return 0;
	return query.length / (query.length + gaps);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`;
	return String(tokens);
}

type Row = { kind: "header"; provider: string } | { kind: "model"; entry: AvailableModel; index: number };

@customElement("sitegeist-model-picker")
export class ModelPickerDialog extends DialogBase {
	@state() private currentModel: Model<Api> | null = null;
	@state() private searchQuery = "";
	@state() private filterThinking = false;
	@state() private filterVision = false;
	@state() private selectedIndex = 0;
	@state() private loading = true;
	@state() private refreshing = false;
	@state() private navigationMode: "mouse" | "keyboard" = "mouse";
	@state() private available: AvailableModel[] = [];

	private onSelectCallback?: (model: Model<Api>) => void;
	private scrollContainerRef = createRef<HTMLDivElement>();
	private searchInputRef = createRef<HTMLInputElement>();
	private lastMousePosition = { x: 0, y: 0 };

	protected override modalWidth = "min(440px, 90vw)";

	static open(currentModel: Model<Api> | null, onSelect: (model: Model<Api>) => void) {
		const picker = new ModelPickerDialog();
		picker.currentModel = currentModel;
		picker.onSelectCallback = onSelect;
		picker.open();
		picker.load(true);
	}

	private async load(autoRefresh: boolean) {
		this.available = await getAvailableModels();
		this.loading = false;
		if (autoRefresh && (await isStale())) await this.refresh(false);
	}

	private async refresh(force: boolean) {
		this.refreshing = true;
		try {
			await refreshDiscoveredModels({ force });
			this.available = await getAvailableModels();
		} finally {
			this.refreshing = false;
		}
	}

	override async firstUpdated(changedProperties: PropertyValues): Promise<void> {
		super.firstUpdated(changedProperties);
		await this.updateComplete;
		this.searchInputRef.value?.focus();

		this.addEventListener("mousemove", (e: MouseEvent) => {
			if (e.clientX === this.lastMousePosition.x && e.clientY === this.lastMousePosition.y) return;
			this.lastMousePosition = { x: e.clientX, y: e.clientY };
			if (this.navigationMode !== "keyboard") return;
			this.navigationMode = "mouse";
			const item = (e.target as HTMLElement).closest("[data-model-item]");
			if (!item) return;
			const all = this.scrollContainerRef.value?.querySelectorAll("[data-model-item]");
			const index = all ? Array.from(all).indexOf(item) : -1;
			if (index !== -1) this.selectedIndex = index;
		});

		this.addEventListener("keydown", (e: KeyboardEvent) => {
			const models = this.filteredModels();
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.navigationMode = "keyboard";
				this.selectedIndex = Math.min(this.selectedIndex + 1, models.length - 1);
				this.scrollToSelected();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.navigationMode = "keyboard";
				this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
				this.scrollToSelected();
			} else if (e.key === "Enter") {
				e.preventDefault();
				const entry = models[this.selectedIndex];
				if (entry) this.handleSelect(entry.model);
			}
		});
	}

	private handleSelect(model: Model<Api>) {
		this.onSelectCallback?.(model);
		this.close();
	}

	private providerOrder(): string[] {
		const builtin = new Set<string>(getProviders());
		const providers = Array.from(new Set(this.available.map((a) => a.model.provider)));
		return providers.sort((a, b) => {
			const aBuiltin = builtin.has(a);
			const bBuiltin = builtin.has(b);
			if (aBuiltin !== bBuiltin) return aBuiltin ? -1 : 1;
			return a.localeCompare(b);
		});
	}

	/** Flat, ordered list of models after search and filters. Search results are score-ordered, otherwise grouped by provider. */
	private filteredModels(): AvailableModel[] {
		let list = this.available;
		if (this.filterThinking) list = list.filter((a) => a.model.reasoning);
		if (this.filterVision) list = list.filter((a) => a.model.input.includes("image"));
		const query = this.searchQuery.toLowerCase().replace(/\s+/g, "");
		if (query) {
			const scored: Array<{ entry: AvailableModel; score: number }> = [];
			for (const entry of list) {
				const text = `${entry.model.provider} ${entry.model.id} ${entry.model.name}`.toLowerCase();
				const score = subsequenceScore(query, text);
				if (score > 0) scored.push({ entry, score });
			}
			scored.sort((a, b) => b.score - a.score);
			return scored.map((s) => s.entry);
		}
		const order = this.providerOrder();
		return [...list].sort((a, b) => {
			const pa = order.indexOf(a.model.provider);
			const pb = order.indexOf(b.model.provider);
			if (pa !== pb) return pa - pb;
			const aCur = modelsAreEqual(this.currentModel, a.model);
			const bCur = modelsAreEqual(this.currentModel, b.model);
			if (aCur !== bCur) return aCur ? -1 : 1;
			if ((a.priority ?? 999) !== (b.priority ?? 999)) return (a.priority ?? 999) - (b.priority ?? 999);
			return a.model.id.localeCompare(b.model.id);
		});
	}

	private rows(): Row[] {
		const models = this.filteredModels();
		const rows: Row[] = [];
		let lastProvider = "";
		models.forEach((entry, index) => {
			if (!this.searchQuery && entry.model.provider !== lastProvider) {
				rows.push({ kind: "header", provider: entry.model.provider });
				lastProvider = entry.model.provider;
			}
			rows.push({ kind: "model", entry, index });
		});
		return rows;
	}

	private scrollToSelected() {
		requestAnimationFrame(() => {
			const el = this.scrollContainerRef.value?.querySelectorAll("[data-model-item]")[this.selectedIndex] as
				| HTMLElement
				| undefined;
			el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		});
	}

	private resetScroll() {
		this.selectedIndex = 0;
		if (this.scrollContainerRef.value) this.scrollContainerRef.value.scrollTop = 0;
	}

	private renderModel(entry: AvailableModel, index: number): TemplateResult {
		const { model } = entry;
		const isCurrent = modelsAreEqual(this.currentModel, model);
		const isSelected = index === this.selectedIndex;
		return html`
			<div
				data-model-item
				class="px-4 py-3 ${this.navigationMode === "mouse" ? "hover:bg-muted" : ""} cursor-pointer border-b border-border ${isSelected ? "bg-accent" : ""}"
				@click=${() => this.handleSelect(model)}
				@mouseenter=${() => {
					if (this.navigationMode === "mouse") this.selectedIndex = index;
				}}
			>
				<div class="flex items-center justify-between gap-2 mb-1">
					<div class="flex items-center gap-2 flex-1 min-w-0">
						<span class="text-sm font-medium text-foreground truncate">${model.id}</span>
						${isCurrent ? html`<span class="text-green-500">${"✓"}</span>` : ""}
						${entry.discovered ? Badge("new", "secondary") : ""}
					</div>
				</div>
				<div class="flex items-center justify-between text-xs text-muted-foreground">
					<div class="flex items-center gap-2">
						<span class="${model.reasoning ? "" : "opacity-30"}">${icon(Brain, "sm")}</span>
						<span class="${model.input.includes("image") ? "" : "opacity-30"}">${icon(ImageIcon, "sm")}</span>
						<span>${formatTokens(model.contextWindow)}/${formatTokens(model.maxTokens)}</span>
					</div>
					<span class="flex items-center gap-1">
						${entry.unknownCost ? html`<span title="Price unknown">${"—"}</span>` : html`<span>${formatModelCost(model.cost)}</span>`}
						<button
							class="opacity-60 hover:opacity-100"
							title=${entry.unknownCost ? "Set price" : "Edit price"}
							@click=${(e: Event) => {
								e.stopPropagation();
								ModelPricingDialog.open(model, () => this.load(false));
							}}
						>
							${icon(Pencil, "sm")}
						</button>
					</span>
				</div>
			</div>
		`;
	}

	protected override renderContent(): TemplateResult {
		const rows = this.rows();
		return html`
			<div class="p-6 pb-4 flex flex-col gap-4 border-b border-border flex-shrink-0">
				<div class="flex items-center justify-between">
					${DialogHeader({ title: "Select Model" })}
					${Button({
						variant: "ghost",
						size: "sm",
						title: "Refresh model lists",
						disabled: this.refreshing,
						onClick: () => this.refresh(true),
						children: html`<span class="${this.refreshing ? "animate-spin" : ""}">${icon(RefreshCw, "sm")}</span>`,
					})}
				</div>
				${Input({
					placeholder: "Search models...",
					value: this.searchQuery,
					inputRef: this.searchInputRef,
					onInput: (e: Event) => {
						this.searchQuery = (e.target as HTMLInputElement).value;
						this.resetScroll();
					},
				})}
				<div class="flex gap-2">
					${Button({
						variant: this.filterThinking ? "default" : "secondary",
						size: "sm",
						className: "rounded-full",
						onClick: () => {
							this.filterThinking = !this.filterThinking;
							this.resetScroll();
						},
						children: html`<span class="inline-flex items-center gap-1">${icon(Brain, "sm")} Thinking</span>`,
					})}
					${Button({
						variant: this.filterVision ? "default" : "secondary",
						size: "sm",
						className: "rounded-full",
						onClick: () => {
							this.filterVision = !this.filterVision;
							this.resetScroll();
						},
						children: html`<span class="inline-flex items-center gap-1">${icon(ImageIcon, "sm")} Vision</span>`,
					})}
				</div>
			</div>
			<div class="flex-1 overflow-y-auto" ${ref(this.scrollContainerRef)}>
				${
					this.loading
						? html`<div class="p-4 text-sm text-muted-foreground">Loading...</div>`
						: rows.length === 0
							? html`<div class="p-4 text-sm text-muted-foreground">No models. Add an API key, log in, or add a custom provider in Settings.</div>`
							: rows.map((row) =>
									row.kind === "header"
										? html`<div class="px-4 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground bg-muted/50 sticky top-0">${row.provider}</div>`
										: this.renderModel(row.entry, row.index),
								)
				}
			</div>
		`;
	}
}
```

- [ ] **Step 4: Run checks**

Run: `./check.sh`
Expected: clean. If `Input` from pi-web-ui rejects `inputRef`, check `../pi-mono/packages/web-ui/src/components/Input.ts` for the prop name; pi-web-ui's own ModelSelector passes `inputRef`, so it should exist. If `Button` rejects `title`, drop that prop.

---

### Task 5: Sidepanel wiring

**Files:**
- Modify: `src/sidepanel.ts` (imports, `DEFAULT_MODELS` use, `selectDefaultModelForAvailableProvider`, `getProvidersWithKeys`, `updateAuthLabel`, agent `getApiKey`, `onApiKeyRequired`, `onModelSelect`, startup default model block)

**Interfaces:**
- Consumes: `getAvailableModels`, `refreshDiscoveredModels`, `findCustomProvider`, `getProvidersWithCredentials` (Task 3), `ModelPickerDialog` (Task 4).

- [ ] **Step 1: Replace imports**

In `src/sidepanel.ts`, change the pi-ai import to:

```ts
import type { Api, Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
```

Remove `ModelSelector` from the `@mariozechner/pi-web-ui` import list. Add:

```ts
import { ModelPickerDialog } from "./dialogs/ModelPickerDialog.js";
import { findCustomProvider, getAvailableModels, getProvidersWithCredentials, refreshDiscoveredModels } from "./models/catalog.js";
import type { AvailableModel } from "./models/resolve.js";
```

- [ ] **Step 2: Add a default-model resolver and replace the two existing lookups**

Below `DEFAULT_MODELS`, add:

```ts
/**
 * Default model chain over the live catalog: saved model, DEFAULT_MODELS entry
 * for a provider with credentials, first model of a provider with credentials.
 * Returns undefined when nothing is available.
 */
async function resolveDefaultModel(): Promise<Model<Api> | undefined> {
	const available = await getAvailableModels();
	if (available.length === 0) return undefined;
	const saved = await storage.settings.get<Model<Api>>("lastUsedModel");
	if (saved) {
		const match = available.find((a) => a.model.provider === saved.provider && a.model.id === saved.id);
		if (match) return match.model;
	}
	const providers = await getProvidersWithCredentials();
	for (const provider of providers) {
		const wanted = DEFAULT_MODELS[provider];
		const match = available.find((a) => a.model.provider === provider && (wanted ? a.model.id === wanted : true));
		if (match) return match.model;
	}
	const byPriority = (a: AvailableModel, b: AvailableModel) => (a.priority ?? 999) - (b.priority ?? 999);
	return [...available].sort(byPriority)[0]?.model;
}
```

Replace the body of `selectDefaultModelForAvailableProvider` with:

```ts
async function selectDefaultModelForAvailableProvider() {
	if (!agent) return;
	const model = await resolveDefaultModel();
	if (!model) return;
	agent.setModel(model);
	await storage.settings.set("lastUsedModel", model);
	await updateAuthLabel();
	renderApp();
}
```

Replace `getProvidersWithKeys` with a thin alias so other call sites keep working:

```ts
async function getProvidersWithKeys(): Promise<string[]> {
	return getProvidersWithCredentials();
}
```

In the startup block that begins `// Determine default model: saved > default for a provider with key > gemini flash fallback`, replace everything from `let defaultModel` through the `// Final fallback` block with:

```ts
	let defaultModel: Model<Api> | undefined;
	if (!initialState?.model) {
		defaultModel = await resolveDefaultModel();
		if (!defaultModel) defaultModel = getModel("anthropic", "claude-sonnet-4-6");
	}
```

- [ ] **Step 3: Key resolution and auth label**

Replace the agent's `getApiKey` option with:

```ts
		getApiKey: async (provider: string) => {
			const stored = await storage.providerKeys.get(provider);
			if (stored) {
				const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
				const proxyUrl = proxyEnabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
				return resolveApiKey(stored, provider, storage.providerKeys, proxyUrl);
			}
			const custom = await findCustomProvider(provider);
			// ponytail: pi-ai's OpenAI client throws on an empty key; local servers ignore the bearer value
			return custom ? custom.apiKey || "none" : undefined;
		},
```

Replace `updateAuthLabel` with:

```ts
async function updateAuthLabel() {
	if (!agent) {
		authLabel = "";
		return;
	}
	const provider = agent.state.model.provider;
	const stored = await storage.providerKeys.get(provider);
	if (stored) {
		authLabel = isOAuthCredentials(stored) ? "subscription" : "api key";
		return;
	}
	authLabel = (await findCustomProvider(provider)) ? "custom" : "";
}
```

- [ ] **Step 4: Send preflight and picker**

In `chatPanel.setAgent(...)`, replace `onApiKeyRequired` and `onModelSelect`:

```ts
		onApiKeyRequired: async (provider: string) => {
			if (await findCustomProvider(provider)) return true;
			return await ApiKeyOrOAuthDialog.prompt(provider);
		},
		onModelSelect: async () => {
			const available = await getAvailableModels();
			if (available.length === 0) {
				openApiKeysDialog();
				return;
			}
			ModelPickerDialog.open(agent.state.model, (model) => {
				agent.setModel(model);
				chatPanel.agentInterface?.requestUpdate();
				updateAuthLabel().catch(() => {});
				renderApp();
			});
		},
```

After `await updateAuthLabel();` that follows agent construction, add a background refresh so a fresh Codex login populates before the picker is first opened:

```ts
	refreshDiscoveredModels().catch((err) => console.warn("Background model refresh failed:", err));
```

- [ ] **Step 5: Run checks**

Run: `./check.sh`
Expected: clean. If `tsc` reports `getModels` or `ModelSelector` unused, delete the leftover references.

---

### Task 6: Custom provider dialog and settings section

**Files:**
- Create: `src/dialogs/CustomProviderDialog.ts`
- Modify: `src/dialogs/ApiKeysOAuthTab.ts`

**Interfaces:**
- Consumes: `SitegeistCustomProvider`, `SitegeistProviderType`, `getCustomProviders`, `saveCustomProvider`, `deleteCustomProvider`, `discoverCustomProvider`, `refreshDiscoveredModels`, `customCacheKey` (Task 3); `getProviders` from pi-ai.
- Produces: `CustomProviderDialog.open(existing: SitegeistCustomProvider | undefined, onSaved: () => void): void`

- [ ] **Step 1: Write `src/dialogs/CustomProviderDialog.ts`**

```ts
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import { getProviders } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
	discoverCustomProvider,
	getCustomProviders,
	type SitegeistCustomProvider,
	type SitegeistProviderType,
	saveCustomProvider,
} from "../models/catalog.js";
import type { DiscoveredModel } from "../models/discovery.js";

const DEFAULT_URLS: Record<SitegeistProviderType, string> = {
	"openai-compatible": "http://localhost:8080",
	ollama: "http://localhost:11434",
};

@customElement("sitegeist-custom-provider-dialog")
export class CustomProviderDialog extends DialogBase {
	private existing?: SitegeistCustomProvider;
	private onSaved?: () => void;

	@state() private name = "";
	@state() private type: SitegeistProviderType = "openai-compatible";
	@state() private baseUrl = DEFAULT_URLS["openai-compatible"];
	@state() private apiKey = "";
	@state() private testing = false;
	@state() private saving = false;
	@state() private error = "";
	@state() private found: DiscoveredModel[] | null = null;

	protected override modalWidth = "min(520px, 90vw)";
	protected override modalHeight = "auto";

	static open(existing: SitegeistCustomProvider | undefined, onSaved: () => void) {
		const dialog = new CustomProviderDialog();
		dialog.existing = existing;
		dialog.onSaved = onSaved;
		if (existing) {
			dialog.name = existing.name;
			dialog.type = existing.type;
			dialog.baseUrl = existing.baseUrl;
			dialog.apiKey = existing.apiKey ?? "";
		}
		dialog.open();
	}

	private current(): SitegeistCustomProvider {
		return {
			id: this.existing?.id ?? crypto.randomUUID(),
			name: this.name.trim(),
			type: this.type,
			baseUrl: this.baseUrl.trim(),
			apiKey: this.apiKey.trim() || undefined,
		};
	}

	private async validate(): Promise<string> {
		const name = this.name.trim();
		if (!name) return "Name is required";
		if (!this.baseUrl.trim()) return "Base URL is required";
		try {
			new URL(this.baseUrl.trim());
		} catch {
			return "Base URL must be a valid URL";
		}
		const lower = name.toLowerCase();
		if (getProviders().some((p) => p.toLowerCase() === lower)) return `"${name}" is a built-in provider name`;
		const clash = (await getCustomProviders()).find((p) => p.name.toLowerCase() === lower && p.id !== this.existing?.id);
		if (clash) return `A custom provider named "${name}" already exists`;
		return "";
	}

	private async test() {
		this.testing = true;
		this.error = "";
		this.found = null;
		try {
			this.found = await discoverCustomProvider(this.current());
			if (this.found.length === 0) this.error = "Connected, but the server listed no usable models";
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.testing = false;
		}
	}

	private async save() {
		this.error = await this.validate();
		if (this.error) return;
		this.saving = true;
		try {
			await saveCustomProvider(this.current(), this.existing?.name);
			this.onSaved?.();
			this.close();
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.saving = false;
		}
	}

	protected override renderContent(): TemplateResult {
		return html`
			<div class="p-6 flex flex-col gap-4">
				${DialogHeader({ title: this.existing ? "Edit Provider" : "Add Provider" })}
				<div class="flex flex-col gap-1">
					${Label({ htmlFor: "cp-name", children: "Name" })}
					${Input({
						value: this.name,
						placeholder: "e.g. Local Ollama",
						onInput: (e: Event) => {
							this.name = (e.target as HTMLInputElement).value;
						},
					})}
				</div>
				<div class="flex flex-col gap-1">
					${Label({ htmlFor: "cp-type", children: "Type" })}
					${Select({
						value: this.type,
						options: [
							{ value: "openai-compatible", label: "OpenAI-compatible (vLLM, llama.cpp, LM Studio, gateways)" },
							{ value: "ollama", label: "Ollama" },
						],
						onChange: (value: string) => {
							const next = value as SitegeistProviderType;
							const wasDefault = this.baseUrl === DEFAULT_URLS[this.type] || this.baseUrl === "";
							this.type = next;
							if (wasDefault) this.baseUrl = DEFAULT_URLS[next];
						},
						width: "100%",
					})}
				</div>
				<div class="flex flex-col gap-1">
					${Label({ htmlFor: "cp-url", children: "Base URL" })}
					${Input({
						value: this.baseUrl,
						placeholder: "http://localhost:8080",
						onInput: (e: Event) => {
							this.baseUrl = (e.target as HTMLInputElement).value;
						},
					})}
					<div class="text-xs text-muted-foreground">Without the /v1 suffix. Models are listed from /v1/models.</div>
				</div>
				<div class="flex flex-col gap-1">
					${Label({ htmlFor: "cp-key", children: "API key (optional)" })}
					${Input({
						type: "password",
						value: this.apiKey,
						placeholder: "Leave empty for local servers",
						onInput: (e: Event) => {
							this.apiKey = (e.target as HTMLInputElement).value;
						},
					})}
				</div>
				<div class="flex items-center gap-3">
					${Button({
						variant: "outline",
						size: "sm",
						disabled: this.testing || !this.baseUrl.trim(),
						loading: this.testing,
						onClick: () => this.test(),
						children: "Test connection",
					})}
					${
						this.found && this.found.length > 0
							? html`<span class="text-sm text-muted-foreground">${this.found.length} models: ${this.found
									.slice(0, 4)
									.map((m) => m.id)
									.join(", ")}${this.found.length > 4 ? ", ..." : ""}</span>`
							: ""
					}
				</div>
				${this.error ? html`<div class="text-sm text-destructive">${this.error}</div>` : ""}
				<div class="flex justify-end gap-2">
					${Button({ variant: "ghost", onClick: () => this.close(), children: "Cancel" })}
					${Button({ variant: "default", disabled: this.saving, loading: this.saving, onClick: () => this.save(), children: "Save" })}
				</div>
			</div>
		`;
	}
}
```

- [ ] **Step 2: Add the Custom Providers section to `ApiKeysOAuthTab`**

Add imports at the top of `src/dialogs/ApiKeysOAuthTab.ts`:

```ts
import { icon } from "@mariozechner/mini-lit";
import { Plus, RefreshCw } from "lucide";
import {
	customCacheKey,
	deleteCustomProvider,
	getCustomProviders,
	refreshDiscoveredModels,
	type SitegeistCustomProvider,
} from "../models/catalog.js";
import { CustomProviderDialog } from "./CustomProviderDialog.js";
```

Add fields to the class:

```ts
	private customProviders: SitegeistCustomProvider[] = [];
	private customCounts: Record<string, number | "error"> = {};
	private refreshingCustom: Set<string> = new Set();
	private pendingDelete: string | null = null;
```

In `connectedCallback`, after `await this.loadOAuthStatuses();` add `await this.loadCustomProviders();`.

Add methods:

```ts
	private async loadCustomProviders() {
		this.customProviders = await getCustomProviders();
		const cache = (await getAppStorage().settings.get<Record<string, { models: unknown[] }>>("discoveredModels")) ?? {};
		for (const p of this.customProviders) {
			const entry = cache[customCacheKey(p.id)];
			this.customCounts[p.id] = entry ? entry.models.length : "error";
		}
		this.requestUpdate();
	}

	private async refreshCustom(p: SitegeistCustomProvider) {
		this.refreshingCustom.add(p.id);
		this.requestUpdate();
		try {
			await refreshDiscoveredModels({ keys: [customCacheKey(p.id)], force: true });
		} finally {
			this.refreshingCustom.delete(p.id);
			await this.loadCustomProviders();
		}
	}

	private async confirmDelete(p: SitegeistCustomProvider) {
		await deleteCustomProvider(p.id);
		this.pendingDelete = null;
		Toast.success(`Removed ${p.name}`);
		await this.loadCustomProviders();
	}

	private renderCustomProvider(p: SitegeistCustomProvider): TemplateResult {
		const count = this.customCounts[p.id];
		const refreshing = this.refreshingCustom.has(p.id);
		const deleting = this.pendingDelete === p.id;
		return html`
			<div class="flex items-center justify-between p-4 rounded-lg border border-border bg-card gap-3">
				<div class="flex-1 min-w-0">
					<div class="text-sm font-medium text-foreground truncate">${p.name}</div>
					<div class="text-xs text-muted-foreground mt-1 truncate">${p.type} ${"•"} ${p.baseUrl}</div>
					<div class="text-xs text-muted-foreground mt-1">
						${count === "error" ? html`<span class="text-destructive">Not reachable</span>` : `${count} models`}
					</div>
				</div>
				<div class="flex gap-2">
					${Button({
						variant: "ghost",
						size: "sm",
						title: "Refresh models",
						disabled: refreshing,
						onClick: () => this.refreshCustom(p),
						children: html`<span class="${refreshing ? "animate-spin" : ""}">${icon(RefreshCw, "sm")}</span>`,
					})}
					${Button({
						variant: "outline",
						size: "sm",
						onClick: () => CustomProviderDialog.open(p, () => this.loadCustomProviders()),
						children: "Edit",
					})}
					${
						deleting
							? html`${Button({ variant: "outline", size: "sm", onClick: () => this.confirmDelete(p), children: "Confirm delete" })}
								${Button({
									variant: "ghost",
									size: "sm",
									onClick: () => {
										this.pendingDelete = null;
										this.requestUpdate();
									},
									children: "Cancel",
								})}`
							: Button({
									variant: "ghost",
									size: "sm",
									onClick: () => {
										this.pendingDelete = p.id;
										this.requestUpdate();
									},
									children: "Delete",
								})
					}
				</div>
			</div>
		`;
	}

	private renderCustomProvidersSection(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				<div class="flex items-start justify-between gap-4">
					<div>
						<h3 class="text-sm font-semibold text-foreground mb-2">Custom Providers</h3>
						<p class="text-sm text-muted-foreground">
							Local servers and OpenAI-compatible endpoints. Models are discovered from the server.
						</p>
					</div>
					${Button({
						variant: "default",
						size: "sm",
						onClick: () => CustomProviderDialog.open(undefined, () => this.loadCustomProviders()),
						children: html`<span class="inline-flex items-center gap-1">${icon(Plus, "sm")} Add provider</span>`,
					})}
				</div>
				<div class="flex flex-col gap-3">
					${
						this.customProviders.length === 0
							? html`<div class="text-sm text-muted-foreground">No custom providers yet.</div>`
							: this.customProviders.map((p) => this.renderCustomProvider(p))
					}
				</div>
			</div>
		`;
	}
```

Change `render()` to:

```ts
	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-8">
				${this.renderOAuthSection()}
				<div class="border-t border-border"></div>
				${this.renderApiKeysSection()}
				<div class="border-t border-border"></div>
				${this.renderCustomProvidersSection()}
			</div>
		`;
	}
```

- [ ] **Step 3: Refresh discovery after an OAuth login**

In `handleLogin`, directly after `Toast.success(...)`, add:

```ts
			refreshDiscoveredModels({ keys: [key], force: true }).catch((err) =>
				console.warn(`Model discovery after login failed for ${key}:`, err),
			);
```

- [ ] **Step 4: Run checks**

Run: `./check.sh`
Expected: clean.

---

### Task 7: Changelog and manual verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` add:

```markdown
### Added

- Live model discovery for Anthropic, OpenAI, Google, Groq, OpenRouter, xAI, Mistral, Cerebras, HuggingFace, Vercel AI Gateway, GitHub Copilot and OpenAI Codex (ChatGPT) accounts. New models appear in the picker without an extension update.
- Custom providers: add any OpenAI-compatible endpoint or Ollama server under Settings > API Keys & OAuth. Multiple providers supported.
- Model pricing overrides: set or correct per-million-token rates for discovered and custom models so cost tracking stays accurate.
- Model picker groups by provider, has a Refresh button, and marks newly discovered models.

### Changed

- OpenAI Codex (ChatGPT) models now come from the account's live list. The previous static entries (gpt-5.1 through gpt-5.4) are no longer offered because the server rejects them.
- Default model selection uses the live model list.

### Fixed

- Selecting a Codex model no longer fails with "model is not supported when using Codex with a ChatGPT account".
```

- [ ] **Step 2: Full check and tests**

Run: `./check.sh && npm test`
Expected: both clean.

- [ ] **Step 3: Manual verification (user runs the build)**

Ask the user to run, from the worktree, `npm run build` and load `/Applications/Python/sitegeist-feature/dist-chrome` as a second unpacked extension. Then verify:

1. Settings > API Keys & OAuth shows the Custom Providers section. Add an Ollama or OpenAI-compatible server, Test connection lists models, Save.
2. Open the model picker: provider headers, the custom provider's models at the bottom, Refresh spins and returns.
3. With a ChatGPT login: the openai-codex group lists gpt-6-* models, none of the gpt-5.1 to gpt-5.4 entries. Select gpt-6-sol and send a message.
4. With an Anthropic key: pick a model missing from the catalog if one exists, confirm the "new" badge and the dash for unknown cost, set a price, send a message, confirm the Costs tab records a non-zero amount.
5. Edit the custom provider's URL to a wrong port, Save, open the picker: its models are gone (discovery failed) and the row says Not reachable. Fix the URL, Save, models return.
6. Delete the custom provider while it is the selected model: reopening the extension falls back to another provider's default.

Report what passed and what did not, with console output for failures.
