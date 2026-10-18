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
	/** Defaults for discovered models whose list endpoint reports no limits. */
	contextWindow?: number;
	maxTokens?: number;
	/** Default for discovered models whose list endpoint says nothing about thinking support. */
	reasoning?: boolean;
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
		reasoning: discovered.reasoning ?? base.reasoning ?? false,
		input: discovered.input ?? ["text"],
		cost,
		contextWindow: discovered.contextWindow ?? base.contextWindow ?? 128000,
		maxTokens: discovered.maxTokens ?? base.maxTokens ?? 8192,
	};
	if (base.headers) model.headers = { ...base.headers };
	if (base.compat !== undefined) (model as { compat?: unknown }).compat = base.compat;
	return { model, discovered: true, unknownCost, priority: discovered.priority };
}

/**
 * openai-compatible providers store the resolved OpenAI root (discovery found /models there).
 * Ollama stores its bare host because the ollama client needs it; its OpenAI root is /v1.
 */
export function customProviderBase(
	type: "openai-compatible" | "ollama",
	baseUrl: string,
	reasoning?: boolean,
): ModelBase {
	const base = normalizeBaseUrl(baseUrl);
	return { api: "openai-completions", baseUrl: type === "ollama" ? `${base}/v1` : base, reasoning };
}

/** Bind the current endpoint and credential together, even when the session model is stale. */
export function customProviderRequest(
	model: Model<Api>,
	provider: {
		type: "openai-compatible" | "ollama";
		baseUrl: string;
		apiKey?: string;
		reasoning?: boolean;
	},
): { model: Model<Api>; apiKey: string } {
	const base = customProviderBase(provider.type, provider.baseUrl, provider.reasoning);
	return {
		model: { ...model, api: base.api, baseUrl: base.baseUrl, reasoning: base.reasoning ?? model.reasoning },
		apiKey: provider.apiKey || "none",
	};
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
		// Newest catalog models carry the largest output limits; pi-ai's Anthropic provider sends maxTokens / 3.
		const template = catalog
			.filter((m) => m.api === api)
			.reduce(
				(best, m) => (m.maxTokens > best.maxTokens ? m : best),
				catalog.find((m) => m.api === api) ?? catalog[0],
			);
		const base: ModelBase = {
			api,
			baseUrl: template.baseUrl,
			headers: template.headers,
			compat: template.compat,
			contextWindow: template.contextWindow,
			maxTokens: template.maxTokens,
		};
		out.push(toModel(provider, base, d, overrides));
		known.add(d.id);
	}
	return out;
}

/**
 * Overlay freshly fetched cache entries onto the latest stored cache so a
 * refresh never clobbers keys written by a concurrent writer. Returns the
 * same object when nothing was fetched, so callers can skip the write.
 */
export function overlayCache<T>(latest: Record<string, T>, fetched: Record<string, T>): Record<string, T> {
	if (Object.keys(fetched).length === 0) return latest;
	return { ...latest, ...fetched };
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
