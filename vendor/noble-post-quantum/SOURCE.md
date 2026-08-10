# noble-post-quantum (ML-DSA only)

Vendored from `@noble/post-quantum@0.7.0` (MIT license, Paul Miller), fetched via `npm pack` from
the public npm registry — same reasoning as every other `vendor/` library here: the site's CSP is
`script-src 'self'`, so every script the page runs has to be a same-origin file, no CDN. Only
`ml-dsa.js` and its actual runtime dependency closure are vendored, not the whole package (which
also includes ML-KEM, SLH-DSA, and Falcon — unused here, see docs/ARCHITECTURE.md "Post-quantum
hybrid signing" for why ML-DSA specifically, and why signing rather than a KEM, is the correctly-
scoped feature for this app).

ML-DSA-87 (FIPS 204, the standardized form of CRYSTALS-Dilithium) is the export used —
`@noble/post-quantum`'s highest security category, matching this app's existing AES-256 posture.

## Files, and why each one is here

The full runtime import graph was traced by hand (`import` statements only reach these nine files
across three npm packages — confirmed exhaustively, not assumed) rather than vendoring either
package in full:

- `ml-dsa.js` — the entry point actually imported by `js/crypto.js`.
- `_crystals.js`, `utils.js` — `ml-dsa.js`'s own direct dependencies, from the same package.
- `curves/utils.js`, `curves/abstract/fft.js`, `curves/abstract/modular.js` — from
  `@noble/curves@2.3.0`, pulled in for the NTT/finite-field math ML-DSA's lattice operations need.
- `hashes/sha3.js`, `hashes/utils.js`, `hashes/_u64.js` — from `@noble/hashes@2.3.0`, for
  SHAKE-128/256 (part of the FIPS 204 spec itself, not an incidental choice).

## Patch: bare `@noble/...` specifiers rewritten to relative paths

Same issue and same fix as `vendor/transformers/transformers.min.js` (see that directory's
`SOURCE.md`): this package ships for consumption through a bundler that rewrites bare specifiers
to real paths, which this app's no-build-step architecture doesn't have. Four files had a bare
specifier patched to a relative one pointing at the layout above (`ml-dsa.js`, `_crystals.js`,
`utils.js`, `curves/utils.js`); the rest already imported each other with relative paths and
needed no change. Only `import` statements were touched — JSDoc comments throughout showing
`import ... from '@noble/...'` as real-npm-install usage examples were deliberately left as-is,
since they're documentation, not executable code.

## Verifying this wasn't tampered with

`node scripts/generate-integrity.mjs` hashes every file here into `integrity.json`, same as every
other same-origin script this app runs — see docs/ARCHITECTURE.md §5d "Verifiable frontend" for
what that does and doesn't prove.
