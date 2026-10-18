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
	overlayCache,
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
	/** Show thinking levels for this provider's models (the list endpoint cannot tell us). */
	reasoning?: boolean;
}

/** pi-web-ui's CustomProvider type lacks our extra fields; IndexedDB stores the object as is. */
function toStored(p: SitegeistCustomProvider): CustomProvider {
	return {
		id: p.id,
		name: p.name,
		type: p.type as unknown as CustomProvider["type"],
		baseUrl: p.baseUrl,
		apiKey: p.apiKey,
		reasoning: p.reasoning,
	} as CustomProvider;
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
		const reasoning = (p as { reasoning?: unknown }).reasoning;
		out.push({
			id: p.id,
			name: p.name,
			type: p.type,
			baseUrl: p.baseUrl,
			apiKey: p.apiKey,
			reasoning: typeof reasoning === "boolean" ? reasoning : undefined,
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function findCustomProvider(name: string): Promise<SitegeistCustomProvider | undefined> {
	return (await getCustomProviders()).find((p) => p.name === name);
}

export interface CustomDiscovery {
	/** Base URL to store: the resolved OpenAI root for openai-compatible, the bare host for ollama. */
	baseUrl: string;
	models: DiscoveredModel[];
}

export async function discoverCustomProvider(provider: SitegeistCustomProvider): Promise<CustomDiscovery> {
	if (provider.type === "ollama") {
		return { baseUrl: provider.baseUrl, models: await discoverOllama(provider.baseUrl) };
	}
	const { root, models } = await discoverOpenAICompatible(provider.baseUrl, provider.apiKey);
	return { baseUrl: root, models };
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

/**
 * Discover once to resolve the base URL, persist the provider with that URL,
 * and seed its cache entry. A failed discovery still saves the provider as
 * entered with an empty cache so the user can fix the URL later.
 * `previousName` handles renames.
 */
export async function saveCustomProvider(provider: SitegeistCustomProvider, previousName?: string): Promise<void> {
	let baseUrl = provider.baseUrl;
	let models: DiscoveredModel[] = [];
	try {
		const found = await discoverCustomProvider(provider);
		baseUrl = found.baseUrl;
		models = found.models;
	} catch (error) {
		console.warn(`[models] discovery failed for custom provider ${provider.name}:`, error);
	}
	await getSitegeistStorage().customProviders.set(toStored({ ...provider, baseUrl }));
	if (previousName && previousName !== provider.name) {
		await movePricing(previousName, provider.name);
		await fixLastUsedModel(previousName, provider.name);
	}
	const cache = await readCache();
	cache[customCacheKey(provider.id)] = { fetchedAt: Date.now(), models };
	await writeCache(cache);
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

	const fetched: Cache = {};
	const jobs: Promise<void>[] = [];

	for (const provider of await getProvidersWithCredentials()) {
		if (!hasDiscovery(provider) || !due(provider)) continue;
		jobs.push(
			(async () => {
				try {
					const auth = await providerAuth(provider);
					if (!auth) return;
					const models = await discoverBuiltinModels(provider, auth);
					fetched[provider] = { fetchedAt: Date.now(), models };
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
					const { baseUrl, models } = await discoverCustomProvider(custom);
					fetched[key] = { fetchedAt: Date.now(), models };
					if (baseUrl !== custom.baseUrl) {
						// Providers saved before root probing may hold a bare host; persist the resolved root.
						await getSitegeistStorage().customProviders.set(toStored({ ...custom, baseUrl }));
					}
				} catch (error) {
					console.warn(`[models] discovery failed for custom provider ${custom.name}:`, error);
				}
			})(),
		);
	}

	await Promise.all(jobs);
	// Re-read: other writers (save/delete provider, login refresh) may have changed the cache meanwhile.
	const latest = await readCache();
	const merged = overlayCache(latest, fetched);
	if (merged !== latest) await writeCache(merged);
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
		const base = customProviderBase(custom.type, custom.baseUrl, custom.reasoning);
		for (const d of cache[customCacheKey(custom.id)]?.models ?? []) {
			out.push(toModel(custom.name, base, d, overrides));
		}
	}

	return out;
}
