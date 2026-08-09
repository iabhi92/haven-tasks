// Dedicated Web Worker for the on-device AI assistant (see js/ai.js and
// docs/ARCHITECTURE.md "On-device AI assistant"). Runs transformers.js'
// model load and generation off the main thread, so the ~25s model load
// and ~85s+ generation no longer freeze the whole tab — the real bug this
// file exists to fix (reported directly: "ai assisnt is frezzed").
//
// Static import, not dynamic: this file is itself only ever instantiated
// (via `new Worker(...)`) after the user clicks "Enable AI assistant" in
// js/ai.js, so nothing here downloads before that opt-in regardless of
// import style — same "nothing loads until you ask" guarantee as before.
//
// Workers do not inherit the document's <script type="importmap"> — this
// only works because vendor/transformers/transformers.min.js's two bare
// specifiers (onnxruntime-web/webgpu, onnxruntime-common) were patched to
// relative paths (see vendor/transformers/SOURCE.md); an import map alone
// could not have fixed this for a worker context.
import { pipeline, env } from "/vendor/transformers/transformers.min.js";

const MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct";
// Standard small sentence-embedding model for transformers.js semantic search (384-dim,
// mean-pooled, q8 quantized — a few MB, independent opt-in from the ~140MB chat model above
// since someone may want fast local search without the heavier generation model).
const EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let generator = null;
let loadPromise = null;
let embedder = null;
let embedLoadPromise = null;

function extractReply(out) {
  const generated = out?.[0]?.generated_text;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    return String(last?.content || "").trim();
  }
  return String(generated || "").trim();
}

async function load(id) {
  if (!generator && !loadPromise) {
    loadPromise = (async () => {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      env.backends.onnx.wasm.wasmPaths = {
        wasm: "/vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm",
        mjs: "/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs",
      };
      // Threaded WASM needs SharedArrayBuffer, which needs cross-origin
      // isolation headers this site doesn't set — pinned single-threaded
      // rather than silently degrading. Same reasoning applies inside a
      // worker as it did on the main thread.
      env.backends.onnx.wasm.numThreads = 1;

      generator = await pipeline("text-generation", MODEL_ID, {
        device: "wasm",
        dtype: "q8",
        progress_callback: (progress) => postMessage({ type: "progress", progress }),
      });
    })();
  }

  try {
    await loadPromise;
    postMessage({ id, type: "done", result: null });
  } catch (err) {
    loadPromise = null; // let a failed load be retried instead of wedging forever
    postMessage({ id, type: "error", error: String(err?.message || err) });
  }
}

async function generate(id, messages, maxNewTokens) {
  try {
    if (!generator) throw new Error("Assistant not loaded yet.");
    const out = await generator(messages, { max_new_tokens: maxNewTokens, do_sample: false });
    postMessage({ id, type: "done", result: extractReply(out) });
  } catch (err) {
    postMessage({ id, type: "error", error: String(err?.message || err) });
  }
}

async function loadEmbedder(id) {
  if (!embedder && !embedLoadPromise) {
    embedLoadPromise = (async () => {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      env.backends.onnx.wasm.wasmPaths = {
        wasm: "/vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm",
        mjs: "/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs",
      };
      env.backends.onnx.wasm.numThreads = 1; // same cross-origin-isolation constraint as load()

      embedder = await pipeline("feature-extraction", EMBED_MODEL_ID, {
        device: "wasm",
        dtype: "q8",
        progress_callback: (progress) => postMessage({ type: "progress", progress }),
      });
    })();
  }

  try {
    await embedLoadPromise;
    postMessage({ id, type: "done", result: null });
  } catch (err) {
    embedLoadPromise = null;
    postMessage({ id, type: "error", error: String(err?.message || err) });
  }
}

async function embed(id, texts) {
  try {
    if (!embedder) throw new Error("Embedder not loaded yet.");
    const out = await embedder(texts, { pooling: "mean", normalize: true });
    // Tensor -> plain nested arrays so it survives postMessage's structured clone.
    postMessage({ id, type: "done", result: out.tolist() });
  } catch (err) {
    postMessage({ id, type: "error", error: String(err?.message || err) });
  }
}

self.addEventListener("message", (event) => {
  const { id, type } = event.data;
  if (type === "load") load(id);
  else if (type === "generate") generate(id, event.data.messages, event.data.maxNewTokens);
  else if (type === "loadEmbedder") loadEmbedder(id);
  else if (type === "embed") embed(id, event.data.texts);
});
