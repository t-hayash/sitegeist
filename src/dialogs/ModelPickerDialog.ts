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

	/** Flat, ordered list after search and filters. Search results are score-ordered, otherwise grouped by provider. */
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
						${
							entry.unknownCost
								? html`<span title="Price unknown">${"—"}</span>`
								: html`<span>${formatModelCost(model.cost)}</span>`
						}
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
