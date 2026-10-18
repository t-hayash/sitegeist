import assert from "node:assert/strict";
import { test } from "node:test";
import { getModels } from "@mariozechner/pi-ai";
import {
	CODEX_FALLBACK_MODEL,
	customProviderBase,
	customProviderRequest,
	inheritCatalogPricing,
	mergeWithCatalog,
	overlayCache,
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

test("customProviderBase uses the stored root for openai-compatible and appends /v1 for ollama", () => {
	assert.equal(customProviderBase("openai-compatible", "https://host/api/").baseUrl, "https://host/api");
	assert.equal(
		customProviderBase("openai-compatible", "http://localhost:8080/v1//").baseUrl,
		"http://localhost:8080/v1",
	);
	assert.equal(customProviderBase("ollama", "http://localhost:11434/").baseUrl, "http://localhost:11434/v1");
	assert.equal(customProviderBase("ollama", "http://localhost:11434").api, "openai-completions");
});

test("toModel fills defaults and reads baseUrl from the base, not the discovered record", () => {
	const base = customProviderBase("openai-compatible", "http://box:1234/v1");
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
	assert.equal(
		merged.some((m) => m.model.id === "llama-9"),
		false,
	);
});

test("CODEX_FALLBACK_MODEL is a complete Codex model", () => {
	assert.equal(CODEX_FALLBACK_MODEL.provider, "openai-codex");
	assert.equal(CODEX_FALLBACK_MODEL.id, "gpt-6-sol");
	assert.equal(CODEX_FALLBACK_MODEL.api, "openai-codex-responses");
	assert.equal(CODEX_FALLBACK_MODEL.baseUrl, "https://chatgpt.com/backend-api");
	assert.equal(CODEX_FALLBACK_MODEL.contextWindow, 272000);
});

test("mergeWithCatalog gives discovered models the largest catalog limits for their protocol", () => {
	const anthropic = getModels("anthropic");
	const biggest = Math.max(...anthropic.map((m) => m.maxTokens));
	assert.ok(biggest > 8192);
	const merged = mergeWithCatalog("anthropic", [{ id: "claude-opus-9" }], {});
	const opus9 = merged.find((m) => m.model.id === "claude-opus-9");
	assert.ok(opus9);
	assert.equal(opus9.model.maxTokens, biggest);
	assert.equal(opus9.model.contextWindow, anthropic.find((m) => m.maxTokens === biggest)?.contextWindow);
});

test("overlayCache applies only fetched keys over the latest cache", () => {
	const latest = { a: { fetchedAt: 1, models: [] }, "custom:x": { fetchedAt: 2, models: [{ id: "m" }] } };
	const fetched = { a: { fetchedAt: 9, models: [{ id: "new" }] } };
	const out = overlayCache(latest, fetched);
	assert.deepEqual(out.a, fetched.a);
	assert.deepEqual(out["custom:x"], latest["custom:x"]);
	assert.equal(overlayCache(latest, {}), latest);
});

test("customProviderBase carries a reasoning flag that toModel applies when discovery reports none", () => {
	const base = customProviderBase("openai-compatible", "http://box:1234/v1", true);
	assert.equal(toModel("box", base, { id: "thinker" }, {}).model.reasoning, true);
	assert.equal(toModel("box", base, { id: "plain", reasoning: false }, {}).model.reasoning, false);
	assert.equal(toModel("box", customProviderBase("ollama", "http://h"), { id: "x" }, {}).model.reasoning, false);
});

test("custom provider requests bind a changed endpoint and key together for a stale session model", () => {
	const selected = toModel(
		"Work server",
		{ api: "openai-completions", baseUrl: "https://old.example/v1" },
		{ id: "chat-model" },
		{},
	).model;
	const request = customProviderRequest(selected, {
		type: "openai-compatible",
		baseUrl: "https://new.example/v1/",
		apiKey: "new-server-key",
	});
	assert.equal(request.model.baseUrl, "https://new.example/v1");
	assert.equal(request.apiKey, "new-server-key");
	assert.equal(request.model.id, "chat-model");
	assert.equal(selected.baseUrl, "https://old.example/v1");
});

test("custom provider requests use the current Ollama endpoint and support keyless servers", () => {
	const selected = toModel(
		"Local server",
		{ api: "openai-completions", baseUrl: "http://localhost:8080/v1" },
		{ id: "chat-model", reasoning: false },
		{},
	).model;
	const request = customProviderRequest(selected, {
		type: "ollama",
		baseUrl: "http://localhost:11434/",
		reasoning: true,
	});
	assert.equal(request.model.baseUrl, "http://localhost:11434/v1");
	assert.equal(request.apiKey, "none");
	assert.equal(request.model.reasoning, true);
});
