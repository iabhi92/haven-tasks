# Transformers.js 4.2.0 (browser build) + onnxruntime-web 1.26.0-dev runtime

Downloaded via `npm pack` of `@huggingface/transformers@4.2.0` and `onnxruntime-web@1.26.0-dev.20260416-b7804b056c`
(the exact version transformers.js 4.2.0 depends on), from the public npm registry. Vendored locally for the
same reason as `vendor/gsap` — the site's CSP is `script-src 'self'`, so every script the page runs has to be
a same-origin file, this one included. See docs/ARCHITECTURE.md "On-device AI assistant" for how it's used.

Files:
- `transformers.min.js` — `dist/transformers.web.min.js` from `@huggingface/transformers`, unmodified.
- `ort-wasm-simd-threaded.asyncify.wasm` / `.mjs` — the onnxruntime-web WASM runtime pair. This is the one
  onnxruntime-web build that both the plain CPU ("wasm") and WebGPU execution providers load by default in
  non-Safari browsers (Safari gets a different, non-asyncify pair upstream — not vendored here, so this
  feature has a known gap on Safari; see the scope note in ARCHITECTURE.md).
- `ort.webgpu.bundle.min.mjs` — onnxruntime-web's WebGPU backend entry point.
- `onnxruntime-common/` — onnxruntime-common's ESM build (`dist/esm/*.js`, unmodified, whole directory since
  its files import each other by relative path).

## Why `onnxruntime-common/` and `ort.webgpu.bundle.min.mjs` are vendored at all

`transformers.min.js` contains two *static* top-level `import` statements for bare specifiers —
`import * as X from "onnxruntime-web/webgpu"` and (transitively) `from "onnxruntime-common"` — left
unresolved by its own build. This is normal for a package meant to be consumed through a bundler (Vite,
webpack, esbuild) that rewrites bare specifiers to real paths. Haven has no build step by design (see
"Verifiable frontend" in ARCHITECTURE.md), so those two specifiers are resolved instead with a native
browser **import map** (`app.html`'s `<script type="importmap">`, pointing both names at these vendored
files). This is required even though the feature forces `device: "wasm"` — both specifiers are imported
unconditionally at module-load time regardless of which device is actually requested at runtime.

The import map ships **inline**, not as an external `<script type="importmap" src="...">` file. External
was tried first — it needs no CSP script hash at all, and doesn't go stale if the map's content ever
changes — but in testing it didn't reliably finish resolving before the module graph that needs it started
loading, causing the same "failed to resolve bare specifier" error the map exists to fix. Inline works
reliably but is still a `<script>` element, so it needs an explicit CSP allowance: this exact block's
`sha256-` hash is in both `app.html`'s `<meta>` CSP tag and `_headers`' `script-src`. Two more `script-src`
tokens were needed beyond that, each found the same way — by actually running the pipeline under this
site's real (not a permissive scratch) CSP and fixing what broke: `blob:` (onnxruntime-web's worker-
loading path dynamically imports a `blob:` URL) and `'wasm-unsafe-eval'` (the CSP Level 3 token
`WebAssembly.instantiate()` itself needs — narrower than the general `'unsafe-eval'`, which grants
arbitrary `eval()`/`Function()` and was deliberately not added). See docs/THREAT_MODEL.md's A5 entry for
the security cost of all three, stated plainly.

The actual model weights (~140MB) are **not** vendored — see the "On-device AI assistant" scope note in
ARCHITECTURE.md for why (git/GitHub file-size limits, and it self-updates rarely enough that fetching from
Hugging Face's CDN on first use, then caching locally via the browser's Cache API, is the honest trade-off).

License: Apache-2.0 (transformers.js, onnxruntime-web, onnxruntime-common all Apache-2.0).
