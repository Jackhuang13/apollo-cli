# Vendored Parser Bundle

This directory contains vendored, self-contained parser assets for `apollo-cli-runtime`:

- `parser.js`: Inlined `@oxc-parser/wasm@0.60.0` with base64 WebAssembly payload.
  - Zero external `node_modules` dependency required.
  - Exposes `parseSync(source, options)`.

## Regeneration

To regenerate or upgrade this bundle:
```bash
node scripts/bundle-vendor-parser.mjs
```
