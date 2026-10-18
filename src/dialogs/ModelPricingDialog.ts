import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import type { Api, Model } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getPricingOverrides, setModelPricing } from "../models/catalog.js";
import type { ModelCost } from "../models/discovery.js";
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
