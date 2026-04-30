# MiniMax Models

## Status

MiniMax models (M2 through M2.7-highspeed) are now **natively supported** in the upstream `badlogic/sitegeist` via `badlogic/pi-mono`'s `models.generated.ts`. No manual patching is required.

## Build setup

This repo requires two sibling directories to build:

```
/Applications/Python/
├── sitegeist/       # this repo
├── pi-mono/         # badlogic/pi-mono
└── mini-lit/        # badlogic/mini-lit
```

### First-time setup

```bash
git clone https://github.com/badlogic/pi-mono.git /Applications/Python/pi-mono
git clone https://github.com/badlogic/mini-lit.git /Applications/Python/mini-lit
# Pin pi-mono to last compatible version (see note below)
cd /Applications/Python/pi-mono && git checkout b0026866 && npm install && npm run build
cd /Applications/Python/mini-lit && npm install && npm run build
cd /Applications/Python/sitegeist && npm install && npm run build
```

### Updating

When sitegeist releases a new version, check compatibility before pulling latest pi-mono.

```bash
cd /Applications/Python/sitegeist && git pull && npm install && npm run build
```

### Compatible pi-mono version

sitegeist `main` (as of 2026-03-18) has TypeScript errors against pi-mono v0.61+.
Use pi-mono **v0.60.0** (`b0026866`) until sitegeist's source is updated.

To check if a newer pi-mono is compatible before switching:
```bash
cd /Applications/Python/sitegeist && npx tsc --noEmit
# No output = compatible. Errors = stay on b0026866.
```

The built extension is in `dist-chrome/`. Load it in Chrome via `chrome://extensions` → Load unpacked.

## After updates: verifying MiniMax models

```bash
grep -o '"MiniMax[^"]*"' dist-chrome/sidepanel.js | sort -u
```

Expected: M2, M2.1, M2.5, M2.5-highspeed, M2.7, M2.7-highspeed (and variants via other providers).

## Previous customization

The original local backup added M2.7 and M2.7-highspeed manually to a bundled `sidepanel.js`. Those changes are now upstream in `pi-mono`. The `docs/model-comparison-template.md` can be retired.
