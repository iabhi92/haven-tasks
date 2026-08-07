#!/usr/bin/env node
// Regenerates Subresource Integrity (SRI) hashes and the top-level
// integrity.json manifest — the mechanics behind "Verifiable frontend"
// (docs/ARCHITECTURE.md "Verifiable frontend"). Run this after editing any
// css/*.css or js/*.js file, same discipline as bumping the ?v= cache-bust
// query strings, and before every deploy — a stale hash here doesn't just
// serve old content (like a stale ?v= does), it makes the browser refuse to
// run the script/apply the stylesheet at all.
//
// No build step, no dependencies — plain Node crypto/fs, run with:
//   node scripts/generate-integrity.mjs

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sha384(bytes) {
  return "sha384-" + createHash("sha384").update(bytes).digest("base64");
}

// Entry points that get a real <script>/<link> tag — these are the ones a
// browser can actually enforce SRI on. See the "what this does NOT cover"
// note below for why the list stops here.
const ENTRY_ASSETS = [
  { file: "css/style.css", htmlFiles: ["app.html", "index.html", "shared.html", "compare.html", "features.html", "security.html"] },
  { file: "css/landing.css", htmlFiles: ["index.html", "compare.html", "features.html", "security.html"] },
  { file: "css/article.css", htmlFiles: ["compare.html", "features.html", "security.html"] },
  { file: "js/app.js", htmlFiles: ["app.html"] },
  { file: "js/landing.js", htmlFiles: ["index.html"] },
  { file: "js/shared.js", htmlFiles: ["shared.html"] },
  { file: "vendor/gsap/gsap.min.js", htmlFiles: ["index.html"] },
  { file: "vendor/gsap/ScrollTrigger.min.js", htmlFiles: ["index.html"] },
];

function listFiles(dir, ext) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// Rewrite `href`/`src` for FILE (any ?v= query string) inside an HTML file's
// <link>/<script> tag to include a fresh integrity + crossorigin attribute.
// Idempotent: replaces an existing integrity attribute rather than
// duplicating it, so this is safe to run repeatedly.
function patchHtmlTag(html, file, hash) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attrPattern = new RegExp(
    `((?:href|src)="${escaped}(?:\\?[^"]*)?")( integrity="[^"]*")?( crossorigin="[^"]*")?`,
    "g"
  );
  let matched = false;
  const patched = html.replace(attrPattern, (_m, urlAttr) => {
    matched = true;
    return `${urlAttr} integrity="${hash}" crossorigin="anonymous"`;
  });
  if (!matched) {
    throw new Error(`Could not find a <script>/<link> tag for ${file} to patch`);
  }
  return patched;
}

const manifest = {};

for (const asset of ENTRY_ASSETS) {
  const bytes = readFileSync(join(ROOT, asset.file));
  const hash = sha384(bytes);
  manifest[asset.file] = hash;
  for (const htmlFile of asset.htmlFiles) {
    const path = join(ROOT, htmlFile);
    const html = patchHtmlTag(readFileSync(path, "utf8"), asset.file, hash);
    writeFileSync(path, html);
  }
  console.log(`${asset.file} -> ${hash}`);
}

// Every other served .js/.css — these load via `import` statements inside
// app.js/landing.js/shared.js, which browsers do NOT support SRI on (the
// `integrity` attribute only applies to <script>/<link> tags, not static or
// dynamic `import`). There is no browser-enforced protection for these
// files today; the manifest below is the "compare it yourself" mechanism
// instead — see docs/SECURITY.md for exactly how to do that.
// vendor/transformers/* (the AI assistant's runtime, js/ai.js's dynamic
// import target — see vendor/transformers/SOURCE.md) is included here too,
// for the same "compare it yourself" reason, even though it's third-party
// code: it's still same-origin bytes this page can execute. The .wasm
// binary is opaque either way, but hashing it costs nothing and means a
// silent substitution wouldn't go unnoticed if anyone checks.
const otherFiles = [
  ...listFiles("js", ".js"),
  ...listFiles("js", ".mjs"),
  ...listFiles("vendor/transformers", ".js"),
  ...listFiles("vendor/transformers", ".mjs"),
  ...listFiles("vendor/transformers", ".wasm"),
  ...listFiles("vendor/transformers/onnxruntime-common", ".js"),
]
  .filter((f) => !ENTRY_ASSETS.some((a) => a.file === f))
  .concat(listFiles("css", ".css").filter((f) => !ENTRY_ASSETS.some((a) => a.file === f)));

for (const file of otherFiles.sort()) {
  const bytes = readFileSync(join(ROOT, file));
  manifest[file] = sha384(bytes);
}

const sortedManifest = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
writeFileSync(
  join(ROOT, "integrity.json"),
  JSON.stringify({ algorithm: "sha384", generatedFrom: relative(ROOT, ROOT) || ".", files: sortedManifest }, null, 2) + "\n"
);
console.log(`\nWrote integrity.json with ${Object.keys(sortedManifest).length} files.`);
