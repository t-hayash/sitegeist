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
	@state() private reasoning = false;
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
			dialog.reasoning = existing.reasoning ?? false;
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
			reasoning: this.reasoning,
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
		const clash = (await getCustomProviders()).find(
			(p) => p.name.toLowerCase() === lower && p.id !== this.existing?.id,
		);
		if (clash) return `A custom provider named "${name}" already exists`;
		return "";
	}

	private async test() {
		this.testing = true;
		this.error = "";
		this.found = null;
		try {
			const result = await discoverCustomProvider(this.current());
			this.found = result.models;
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
					<div class="text-xs text-muted-foreground">
						Server root is enough: /v1 and /api (Open WebUI) are probed automatically.
					</div>
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
				<label class="flex items-center gap-2 text-sm text-foreground cursor-pointer">
					<input
						type="checkbox"
						.checked=${this.reasoning}
						@change=${(e: Event) => {
							this.reasoning = (e.target as HTMLInputElement).checked;
						}}
					/>
					Models support thinking levels
					<span class="text-xs text-muted-foreground">(shows the thinking selector; servers that reject reasoning_effort will error)</span>
				</label>
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
					${Button({
						variant: "default",
						disabled: this.saving,
						loading: this.saving,
						onClick: () => this.save(),
						children: "Save",
					})}
				</div>
			</div>
		`;
	}
}
