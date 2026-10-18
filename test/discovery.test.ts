import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
	discoverOpenAICompatible,
	hasDiscovery,
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
	withTimeout,
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
				pricing: {
					prompt: "0.000015",
					completion: "0.000075",
					input_cache_read: "0.0000015",
					input_cache_write: "0.00001875",
				},
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
		data: [
			{
				id: "openai/gpt-6",
				name: "GPT-6",
				context_window: 400000,
				max_tokens: 128000,
				pricing: { input: "0.000002", output: "0.000008" },
			},
		],
	};
	assert.deepEqual(parseVercelModels(json), [
		{
			id: "openai/gpt-6",
			name: "GPT-6",
			contextWindow: 400000,
			maxTokens: 128000,
			cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
		},
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
				capabilities: {
					type: "chat",
					limits: { max_context_window_tokens: 400000, max_output_tokens: 64000 },
					supports: { vision: true },
				},
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
		{
			id: "gpt-6-sol",
			name: "GPT-6-Sol",
			contextWindow: 272000,
			input: ["text", "image"],
			reasoning: true,
			priority: 2,
		},
	]);
});

test("discoverOpenAICompatible rejects when the server never answers", async () => {
	const server = createServer(() => {
		// never respond
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		await assert.rejects(discoverOpenAICompatible(`http://127.0.0.1:${address.port}`, undefined, 200));
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("withTimeout rejects a promise that never settles", async () => {
	await assert.rejects(withTimeout(new Promise<never>(() => {}), 50, "ollama"), /timed out/);
	assert.equal(await withTimeout(Promise.resolve(7), 50, "x"), 7);
});

function fakeOpenAIServer(modelsPath: string) {
	const server = createServer((req, res) => {
		if (req.url === modelsPath) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ id: "served-model" }] }));
			return;
		}
		res.setHeader("content-type", "text/html");
		res.end("<!doctype html><html><body>spa</body></html>");
	});
	return server;
}

async function withServer(modelsPath: string, fn: (origin: string) => Promise<void>) {
	const server = fakeOpenAIServer(modelsPath);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		await fn(`http://127.0.0.1:${address.port}`);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

test("discoverOpenAICompatible finds models under /api (Open WebUI layout) and reports that root", async () => {
	await withServer("/api/models", async (origin) => {
		const result = await discoverOpenAICompatible(`${origin}/api`, undefined, 2000);
		assert.equal(result.root, `${origin}/api`);
		assert.deepEqual(result.models, [{ id: "served-model" }]);
	});
});

test("discoverOpenAICompatible appends /v1 for a bare host that serves /v1/models", async () => {
	await withServer("/v1/models", async (origin) => {
		const result = await discoverOpenAICompatible(origin, undefined, 2000);
		assert.equal(result.root, `${origin}/v1`);
		assert.deepEqual(result.models, [{ id: "served-model" }]);
	});
});

test("discoverOpenAICompatible explains an HTML answer instead of a JSON parse error", async () => {
	await withServer("/nowhere", async (origin) => {
		await assert.rejects(discoverOpenAICompatible(origin, undefined, 2000), /not JSON|HTML/);
	});
});

test("discoverOpenAICompatible finds Open WebUI's /api root from a bare host", async () => {
	await withServer("/api/models", async (origin) => {
		const result = await discoverOpenAICompatible(origin, undefined, 2000);
		assert.equal(result.root, `${origin}/api`);
		assert.deepEqual(result.models, [{ id: "served-model" }]);
	});
});

test("discoverOpenAICompatible reports the auth error, not the HTML one, when a JSON route rejects the key", async () => {
	const server = createServer((req, res) => {
		if (req.url === "/api/models") {
			res.statusCode = 401;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ detail: "401 Unauthorized" }));
			return;
		}
		res.setHeader("content-type", "text/html");
		res.end("<!doctype html>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		await assert.rejects(discoverOpenAICompatible(`http://127.0.0.1:${address.port}`, "bad", 2000), /HTTP 401/);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("MiniMax providers have a discovery source", () => {
	assert.equal(hasDiscovery("minimax"), true);
	assert.equal(hasDiscovery("minimax-cn"), true);
});
