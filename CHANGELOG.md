# Changelog

## [Unreleased]

### Added

- Live model discovery for Anthropic, OpenAI, Google, Groq, OpenRouter, xAI, Mistral, Cerebras, HuggingFace, Vercel AI Gateway, GitHub Copilot and OpenAI Codex (ChatGPT) accounts. New models appear in the picker without an extension update.
- Custom providers: add any OpenAI-compatible endpoint or Ollama server under Settings > API Keys & OAuth. Multiple providers supported.
- Model pricing overrides: set or correct per-million-token rates for discovered and custom models so cost tracking stays accurate.
- Model picker groups by provider, has a Refresh button, and marks newly discovered models.
- MiniMax and MiniMax CN model discovery.
- Remove button next to each saved API key in Settings > API Keys & OAuth.
- Custom providers have a "Models support thinking levels" toggle that enables the thinking selector for their models.

### Changed

- OpenAI Codex (ChatGPT) models now come from the account's live list. The previous static entries (gpt-5.1 through gpt-5.4) are no longer offered because the server rejects them.
- Default model selection uses the live model list.

### Fixed

- Selecting a Codex model no longer fails with "model is not supported when using Codex with a ChatGPT account".
- Custom-provider requests resolve the current endpoint and API key together, preventing a saved session from sending a changed key to the previous server.

## [1.0.0] - 2026-03-15

### Added

- Browser-based OAuth login for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), GitHub Copilot, and Google Gemini CLI
- Combined "API Keys & OAuth" settings tab with subscription login and API key entry
- Welcome setup dialog on first launch when no providers are configured
- Auto-select default model for the first provider with a key
- Provider and auth type indicator in the header bar
- Image extraction tool (`extract_image`) with selector and screenshot modes
- Subsequence-based fuzzy search in the model selector
- CORS proxy warning in OAuth sections (orange when enabled, red when disabled)
- GitHub Actions workflow for tagged releases
- `release.sh` script for version bumping and tagged releases

### Changed

- Default model changed to `claude-sonnet-4-6` with `medium` thinking level
- CORS proxy enabled by default
- Model selector only shows models from providers with configured keys
- API key prompt dialog now shows both OAuth login and API key entry for supported providers
- Tool execution set to sequential mode (parallel caused rendering issues in sidebar)
- Site converted to static (removed backend, admin, waitlist signups)
- Download links point to GitHub Releases
- License changed from MIT to AGPL-3.0

### Fixed

- Settings dialog tabs not responding to clicks (upstream `pi-web-ui` built with `tsgo` broke Lit decorator reactivity)
- CORS proxy toggle not updating (same root cause)
- Proxy not applied to API requests (esbuild bundled duplicate `streamSimple` references, breaking identity check)
- Model selector button not updating after picking a model (added `state_change` event to Agent)
- Duplicate tool component rendering during streaming (cleared streaming container on `message_end`)
- Screenshot tool capturing sidepanel instead of the webpage
