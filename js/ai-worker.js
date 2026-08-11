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

// Upgraded from HuggingFaceTB/SmolLM2-135M-Instruct (2026-08-11) — same SmolLM2 family, ~2.6x more
// parameters, a real capability step up while staying browser-feasible (verified against the
// onnx-community org's real ONNX conversion, model_quantized.onnx at 363MB, not vendored — same
// "fetched once, cached via the browser's Cache API" pattern as before). See
// docs/ARCHITECTURE.md "On-device AI assistant" for real, measured load/generation timing —
// meaningfully slower than the 135M model, not assumed proportional without testing.
const MODEL_ID = "onnx-community/SmolLM2-360M-Instruct-ONNX";
// Standard small sentence-embedding model for transformers.js semantic search (384-dim,
// mean-pooled, q8 quantized — a few MB, independent opt-in from the ~140MB chat model above
// since someone may want fast local search without the heavier generation model).
const EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
// English-only tiny Whisper (~39M params, q8 quantized) for on-device voice input. Reverses
// the earlier "no voice input" call in this project's history -- that decision was about
// *cloud* speech-to-text sending raw audio to a provider, which this doesn't: the audio never
// leaves the tab, same as every other model here.
const ASR_MODEL_ID = "Xenova/whisper-tiny.en";

let generator = null;
let loadPromise = null;
let embedder = null;
let embedLoadPromise = null;
let transcriber = null;
let transcriberLoadPromise = null;

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

async function loadTranscriber(id) {
  if (!transcriber && !transcriberLoadPromise) {
    transcriberLoadPromise = (async () => {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      env.backends.onnx.wasm.wasmPaths = {
        wasm: "/vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm",
        mjs: "/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs",
      };
      env.backends.onnx.wasm.numThreads = 1; // same cross-origin-isolation constraint as load()

      // fp32, not q8 like the two pipelines above -- both explicit "q8" and this model's own
      // default dtype hit the same real ORT error while testing ("Can't create a session...
      // Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale"): the
      // quantized decoder variant available for this model needs a newer onnxruntime-web
      // MatMulNBits/QDQ feature than the vendored 1.26.0-dev build supports. fp32 sidesteps
      // the quantization graph entirely -- a larger download, but the one that actually works.
      transcriber = await pipeline("automatic-speech-recognition", ASR_MODEL_ID, {
        device: "wasm",
        dtype: "fp32",
        progress_callback: (progress) => postMessage({ type: "progress", progress }),
      });
    })();
  }

  try {
    await transcriberLoadPromise;
    postMessage({ id, type: "done", result: null });
  } catch (err) {
    transcriberLoadPromise = null;
    postMessage({ id, type: "error", error: String(err?.message || err) });
  }
}

// audioData: Float32Array of mono PCM samples at 16kHz (see js/ai.js's decodeAudioForAsr for
// how a MediaRecorder blob gets converted to this shape before reaching here).
async function transcribe(id, audioData) {
  try {
    if (!transcriber) throw new Error("Transcriber not loaded yet.");
    const out = await transcriber(audioData);
    postMessage({ id, type: "done", result: String(out?.text || "").trim() });
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
  else if (type === "loadTranscriber") loadTranscriber(id);
  else if (type === "transcribe") transcribe(id, event.data.audioData);
});
