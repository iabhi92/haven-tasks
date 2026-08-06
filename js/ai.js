// On-device AI assistant (Layer 3 "genuinely current, distinctive one" —
// see docs/FEATURES.md). A small instruction-tuned language model
// (HuggingFaceTB/SmolLM2-135M-Instruct, int8-quantized ONNX, ~140MB) runs
// entirely in the browser via transformers.js/onnxruntime-web's WASM
// backend. Nothing here ever sends a task, a title, or a note anywhere —
// once the model file itself is downloaded and cached, generation is a
// local WASM computation with zero network requests. See "On-device AI
// assistant" in docs/ARCHITECTURE.md for the honest scope: why WASM-only
// (not WebGPU), why this exact model, and real measured timing.
//
// This module is loaded lazily via dynamic import — only once the user
// opts in from the AI assistant panel — so the ~450KB runtime script and
// the far larger model weights are never fetched by someone who never
// clicks "Enable."

const MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct";
// Bounds worst-case generation time. Measured on single-threaded CPU WASM
// (no bundler means no WebGPU codepath here — see ARCHITECTURE.md): roughly
// 0.5-0.6s/token, so 110 tokens is "about a minute," not "instant." A bigger
// budget would make the UI feel broken long before it'd make answers better
// out of a 135M-parameter model.
const MAX_NEW_TOKENS = 110;

let generator = null;
let loadPromise = null;

export function isAssistantReady() {
  return generator !== null;
}

export async function loadAssistant(onProgress) {
  if (generator) return generator;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const { pipeline, env } = await import("../vendor/transformers/transformers.min.js");

    // We don't ship the model weights ourselves (a few hundred MB is well
    // past what belongs in this repo) — fetched from Hugging Face's CDN on
    // first use, then cached by the browser's Cache API (useBrowserCache)
    // so every use after the first is fully offline.
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    // Point the ONNX runtime's WASM loader at our own vendored copy instead
    // of its jsdelivr CDN default — every script this page runs has to be
    // same-origin under our CSP (script-src 'self'), model weights aside.
    env.backends.onnx.wasm.wasmPaths = {
      wasm: "/vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm",
      mjs: "/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs",
    };
    // Threaded WASM needs SharedArrayBuffer, which needs cross-origin
    // isolation (COOP/COEP headers) that this site doesn't set — so pin to
    // single-threaded rather than silently degrading at runtime.
    env.backends.onnx.wasm.numThreads = 1;

    generator = await pipeline("text-generation", MODEL_ID, {
      device: "wasm",
      dtype: "q8",
      progress_callback: onProgress,
    });
    return generator;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null; // let a failed load be retried instead of wedging forever
    throw err;
  }
}

function extractReply(out) {
  const generated = out?.[0]?.generated_text;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    return String(last?.content || "").trim();
  }
  return String(generated || "").trim();
}

// Only title/dueDate/priority/status feed the prompt — notes are left out
// deliberately to keep the prompt (and thus generation time) short, not as
// a privacy measure; everything here already runs fully on-device regardless.
function summarizeTasksForPrompt(tasks, limit = 25) {
  return tasks
    .filter((t) => t.status !== "done")
    .slice(0, limit)
    .map((t) => {
      const bits = [t.title];
      if (t.dueDate) bits.push(`due ${t.dueDate}`);
      bits.push(`${t.priority} priority`, t.status);
      return `- ${bits.join(", ")}`;
    })
    .join("\n");
}

export async function generateFocusSummary(tasks) {
  const gen = await loadAssistant();
  const list = summarizeTasksForPrompt(tasks);
  const messages = [
    {
      role: "system",
      content: "You are a concise, encouraging task-planning assistant. Keep answers under 80 words.",
    },
    {
      role: "user",
      content: `Here are my open tasks:\n${list || "(no open tasks)"}\n\nWhat should I focus on today, and why? Be specific but brief.`,
    },
  ];
  const out = await gen(messages, { max_new_tokens: MAX_NEW_TOKENS, do_sample: false });
  return extractReply(out);
}

export async function generateSubtaskSuggestions(task) {
  const gen = await loadAssistant();
  const messages = [
    {
      role: "system",
      content: "You break tasks into short, concrete subtasks. Reply with 3-6 items, one per line, each starting with '-'. No other text.",
    },
    {
      role: "user",
      content: `Task: ${task.title}${task.notes ? `\nNotes: ${task.notes}` : ""}\n\nBreak this into subtasks.`,
    },
  ];
  const out = await gen(messages, { max_new_tokens: MAX_NEW_TOKENS, do_sample: false });
  const reply = extractReply(out);
  return reply
    .split("\n")
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}
