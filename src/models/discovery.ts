/**
 * Live model discovery. Pure parsers over provider JSON plus thin fetchers.
 * No storage access here; catalog.ts owns caching and credentials.
 */
import { Ollama } from "ollama/browser";
import { getGitHubCopilotBaseUrl } from "../oauth/github-copilot.js";
import { getCodexAccountId } from "../oauth/openai-codex.js";

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

const FETCH_TIMEOUT_MS = 15_000;

/** Reject when `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
	const text = await response.text();
	if (!response.ok) {
		let detail = response.statusText;
		try {
			const body = JSON.parse(text) as { detail?: unknown; error?: { message?: unknown } };
			const fromBody = body.detail ?? body.error?.message;
			if (typeof fromBody === "string") detail = fromBody;
		} catch {
			// non-JSON error body; keep the status text
		}
		throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	try {
		return JSON.parse(text);
	} catch {
		const contentType = response.headers.get("content-type") ?? "unknown";
		const hint = /html/i.test(contentType) || text.trimStart().startsWith("<") ? " (got HTML, wrong base URL?)" : "";
		throw new Error(`Response is not JSON, content-type ${contentType}${hint}`);
	}
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
		headers: (auth): Record<string, string> => {
			const common = { "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
			if (auth.isOAuth) {
				return { ...common, Authorization: `Bearer ${auth.token}`, "anthropic-beta": "oauth-2025-04-20" };
			}
			return { ...common, "x-api-key": auth.token };
		},
		parse: parseAnthropicModels,
	},
	openai: { url: () => "https://api.openai.com/v1/models", headers: bearer, parse: parseOpenAIModels },
	google: {
		url: (auth) =>
			`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(auth.token)}`,
		headers: () => ({}),
		parse: parseGoogleModels,
	},
	groq: { url: () => "https://api.groq.com/openai/v1/models", headers: bearer, parse: parseGroqModels },
	openrouter: { url: () => "https://openrouter.ai/api/v1/models", headers: () => ({}), parse: parseOpenRouterModels },
	xai: { url: () => "https://api.x.ai/v1/models", headers: bearer, parse: parsePlain },
	mistral: { url: () => "https://api.mistral.ai/v1/models", headers: bearer, parse: parseMistralModels },
	cerebras: { url: () => "https://api.cerebras.ai/v1/models", headers: bearer, parse: parsePlain },
	huggingface: { url: () => "https://router.huggingface.co/v1/models", headers: bearer, parse: parsePlain },
	minimax: { url: () => "https://api.minimax.io/v1/models", headers: bearer, parse: parsePlain },
	"minimax-cn": { url: () => "https://api.minimaxi.com/v1/models", headers: bearer, parse: parsePlain },
	"vercel-ai-gateway": {
		url: () => "https://ai-gateway.vercel.sh/v1/models",
		headers: bearer,
		parse: parseVercelModels,
	},
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

export interface OpenAICompatibleDiscovery {
	/** The URL where /models answered; also where /chat/completions lives. Store this. */
	root: string;
	models: DiscoveredModel[];
}

/**
 * Find the OpenAI-compatible root for a server. Tries the URL as given, then
 * with /v1 appended, so both "https://host/api" (Open WebUI) and a bare
 * "http://localhost:11434" (Ollama, vLLM, LM Studio) work.
 */
export async function discoverOpenAICompatible(
	baseUrl: string,
	apiKey?: string,
	timeoutMs = FETCH_TIMEOUT_MS,
): Promise<OpenAICompatibleDiscovery> {
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	const base = normalizeBaseUrl(baseUrl);
	// Bare host layouts: /v1 (Ollama, vLLM, LM Studio, gateways), /api (Open WebUI).
	const candidates = /\/(v1|api)$/.test(base) ? [base] : [base, `${base}/v1`, `${base}/api`, `${base}/api/v1`];
	let htmlError: Error | undefined;
	let routeError: Error | undefined;
	for (const root of candidates) {
		try {
			const models = parsePlain(await getJson(`${root}/models`, headers, timeoutMs));
			return { root, models };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			// A JSON route that rejected us (401, 403) is the informative failure; HTML means no route there.
			if (/not JSON/.test(err.message)) htmlError = err;
			else routeError = err;
		}
	}
	throw routeError ?? htmlError ?? new Error("Discovery failed");
}

export async function discoverOllama(baseUrl: string): Promise<DiscoveredModel[]> {
	const ollama = new Ollama({ host: normalizeBaseUrl(baseUrl) });
	const { models } = await withTimeout(ollama.list(), FETCH_TIMEOUT_MS, "ollama list");
	const out: DiscoveredModel[] = [];
	for (const m of models) {
		try {
			const details = await withTimeout(ollama.show({ model: m.name }), FETCH_TIMEOUT_MS, `ollama show ${m.name}`);
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
