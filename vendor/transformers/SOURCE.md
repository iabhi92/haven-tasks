# Transformers.js 4.2.0 (browser build) + onnxruntime-web 1.26.0-dev runtime

Downloaded via `npm pack` of `@huggingface/transformers@4.2.0` and `onnxruntime-web@1.26.0-dev.20260416-b7804b056c`
(the exact version transformers.js 4.2.0 depends on), from the public npm registry. Vendored locally for the
same reason as `vendor/gsap` — the site's CSP is `script-src 'self'`, so every script the page runs has to be
a same-origin file, this one included. See docs/ARCHITECTURE.md "On-device AI assistant" for how it's used.

Files:
- `transformers.min.js` — `dist/transformers.web.min.js` from `@huggingface/transformers`,
  **hand-patched** (see "Why `transformers.min.js` is patched" below) — not a vendored-unmodified
  file like the others here.
- `ort-wasm-simd-threaded.asyncify.wasm` / `.mjs` — the onnxruntime-web WASM runtime pair. This is the one
  onnxruntime-web build that both the plain CPU ("wasm") and WebGPU execution providers load by default in
  non-Safari browsers (Safari gets a different, non-asyncify pair upstream — not vendored here, so this
  feature has a known gap on Safari; see the scope note in ARCHITECTURE.md).
- `ort.webgpu.bundle.min.mjs` — onnxruntime-web's WebGPU backend entry point.
- `onnxruntime-common/` — onnxruntime-common's ESM build (`dist/esm/*.js`, unmodified, whole directory since
  its files import each other by relative path).

## Why `transformers.min.js` is patched

`transformers.min.js` ships with two *static* top-level `import` statements for bare specifiers —
`import * as X from "onnxruntime-web/webgpu"` and (transitively) `from "onnxruntime-common"` — left
unresolved by its own build. This is normal for a package meant to be consumed through a bundler (Vite,
webpack, esbuild) that rewrites bare specifiers to real paths. Haven has no build step by design (see
"Verifiable frontend" in ARCHITECTURE.md), so those two specifiers are resolved instead by patching this
one file's two `import` lines to relative paths pointing at the two files above:

```
from"onnxruntime-web/webgpu"   →   from"./ort.webgpu.bundle.min.mjs"
from"onnxruntime-common"       →   from"./onnxruntime-common/index.js"
```

This is required even though the feature forces `device: "wasm"` — both specifiers are imported
unconditionally at module-load time regardless of which device is actually requested at runtime.

**This wasn't the first fix tried.** The original approach was a native browser **import map**
(`app.html`'s `<script type="importmap">`, mapping both bare names to these vendored files) — it
worked for the main-thread load path, but broke once the AI assistant moved into a dedicated Web
Worker (`js/ai-worker.js`, see docs/ARCHITECTURE.md §4h "Runs in a Web Worker, not the main
thread"): **import maps only apply to the document that declares them — a module worker gets
none of it**, so the exact same "failed to resolve bare specifier" error came back inside the
worker. The relative-path patch above fixes both contexts at once, since relative specifiers
resolve against the *importing module's own URL* regardless of which module graph (main document
or worker) loaded it. This also made the import map's CSP `sha256-` hash allowance (in both
`app.html`'s `<meta>` tag and `_headers`) unnecessary — one fewer standing CSP grant, not an
additional one. Two `script-src` tokens are still needed, each found the same way — by actually
running the pipeline under this site's real (not a permissive scratch) CSP and fixing what broke:
`blob:` (onnxruntime-web's worker-loading path dynamically imports a `blob:` URL) and
`'wasm-unsafe-eval'` (the CSP Level 3 token `WebAssembly.instantiate()` itself needs — narrower
than the general `'unsafe-eval'`, which grants arbitrary `eval()`/`Function()` and was deliberately
not added). See docs/THREAT_MODEL.md's A5 entry for the security cost of both, stated plainly.

**Re-applying this patch after a version bump:** if `transformers.min.js` is ever re-vendored from
a newer `@huggingface/transformers` release, re-run the same two string replacements above (confirm
first with `grep -c 'from"onnxruntime-web/webgpu"' transformers.min.js` — `1` means unpatched,
needs the patch; `0` means already patched or the upstream build changed shape and this whole note
needs re-verifying against the new file).

The actual model weights (~140MB) are **not** vendored — see the "On-device AI assistant" scope note in
ARCHITECTURE.md for why (git/GitHub file-size limits, and it self-updates rarely enough that fetching from
Hugging Face's CDN on first use, then caching locally via the browser's Cache API, is the honest trade-off).

License: Apache-2.0 (transformers.js, onnxruntime-web, onnxruntime-common all Apache-2.0).
