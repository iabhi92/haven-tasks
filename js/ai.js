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
//
// The actual model load + generation run in a dedicated Web Worker
// (js/ai-worker.js), not on the main thread — this file is a thin RPC
// wrapper around it. This exists specifically to fix a real reported bug:
// the whole tab used to freeze for the ~25s model load and ~85s+
// generation, because both used to run inline here. See js/ai-worker.js
// and CLAUDE.md's "AI assistant freezes the page" note for the fix
// history (a bare-module-specifier patch to transformers.min.js was
// required first — workers don't inherit the page's import map).

const MAX_NEW_TOKENS = 110;

let worker = null;
let ready = false;
let nextRequestId = 1;
const pending = new Map(); // requestId -> { resolve, reject }
let onProgressCallback = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./ai-worker.js?v=20260810a", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "progress") {
      if (onProgressCallback) onProgressCallback(msg.progress);
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return; // stale/unknown request id — ignore rather than throw
    pending.delete(msg.id);
    if (msg.type === "error") entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  });
  worker.addEventListener("error", (err) => {
    const failure = new Error(err?.message || "AI worker crashed.");
    for (const entry of pending.values()) entry.reject(failure);
    pending.clear();
  });
  return worker;
}

function callWorker(type, payload) {
  const id = nextRequestId++;
  const w = getWorker();
  const donePromise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  w.postMessage({ id, type, ...payload });
  return donePromise;
}

export function isAssistantReady() {
  return ready;
}

export async function loadAssistant(onProgress) {
  if (ready) return;
  onProgressCallback = onProgress || null;
  await callWorker("load", {});
  ready = true;
}

let embedderReady = false;

export function isEmbedderReady() {
  return embedderReady;
}

// A separate, smaller (~few MB vs ~140MB) opt-in from the chat assistant above — someone may
// want fast local semantic search without downloading the generation model too.
export async function loadEmbedder(onProgress) {
  if (embedderReady) return;
  onProgressCallback = onProgress || null;
  await callWorker("loadEmbedder", {});
  embedderReady = true;
}

// texts: string[] -> Promise<number[][]>, one 384-dim vector per input text, L2-normalized
// (so cosine similarity reduces to a plain dot product — see cosineSimilarity() in app.js).
export async function embedTexts(texts) {
  return callWorker("embed", { texts });
}

const ASR_SAMPLE_RATE = 16000; // what Whisper expects — MediaRecorder's own rate varies by device

let transcriberReady = false;

export function isTranscriberReady() {
  return transcriberReady;
}

// A third, independent opt-in (~40MB, separate from both the ~140MB chat model and the
// few-MB embedder) — voice input specifically, without forcing either of the other two.
export async function loadTranscriber(onProgress) {
  if (transcriberReady) return;
  onProgressCallback = onProgress || null;
  await callWorker("loadTranscriber", {});
  transcriberReady = true;
}

// Decodes a recorded MediaRecorder Blob into the mono, 16kHz Float32Array Whisper expects.
// Runs on the main thread (decodeAudioData/OfflineAudioContext need a document context) —
// only the actual model inference happens in the worker.
async function decodeAudioForAsr(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new AudioCtx();
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  decodeCtx.close();

  // Resample to 16kHz regardless of the mic's native rate (typically 44.1k/48k) by rendering
  // through an OfflineAudioContext at the target rate — the standard way to resample in the
  // browser without shipping a resampling library.
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * ASR_SAMPLE_RATE), ASR_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0); // mono Float32Array at 16kHz
}

// blob: a Blob from MediaRecorder (webm/opus, wav, whatever the browser produced) ->
// Promise<string> transcript. Caller is responsible for having called loadTranscriber() first.
export async function transcribeAudio(blob) {
  const audioData = await decodeAudioForAsr(blob);
  // audioData is a Float32Array backed by a real AudioBuffer -- structured-clone it as a plain
  // array-like the worker can pass straight to the pipeline (Float32Array itself clones fine
  // too, but .slice() ensures a plain, detached copy rather than sharing the AudioBuffer's).
  return callWorker("transcribe", { audioData: audioData.slice() });
}

function extractReply(text) {
  return String(text || "").trim();
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

async function generateChat(messages) {
  if (!ready) await loadAssistant();
  const text = await callWorker("generate", { messages, maxNewTokens: MAX_NEW_TOKENS });
  return extractReply(text);
}

export async function generateFocusSummary(tasks) {
  const list = summarizeTasksForPrompt(tasks);
  return generateChat([
    {
      role: "system",
      content: "You are a concise, encouraging task-planning assistant. Keep answers under 80 words.",
    },
    {
      role: "user",
      content: `Here are my open tasks:\n${list || "(no open tasks)"}\n\nWhat should I focus on today, and why? Be specific but brief.`,
    },
  ]);
}

// Reuses the general-purpose free-text path's grounding approach but scoped to what actually
// finished this week — a different filter/window than summarizeTasksForPrompt's "open tasks",
// so its own small helper rather than reusing that one with extra parameters.
function summarizeCompletedForPrompt(tasks, sinceMs, limit = 25) {
  return tasks
    .filter((t) => t.status === "done" && t.updatedAt >= sinceMs)
    .slice(0, limit)
    .map((t) => `- ${t.title}`)
    .join("\n");
}

export async function generateWeeklyRecap(tasks) {
  const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const list = summarizeCompletedForPrompt(tasks, sinceMs);
  return generateChat([
    {
      role: "system",
      content: "You are a concise, encouraging task-planning assistant. Keep answers under 80 words.",
    },
    {
      role: "user",
      content: `Here's what I completed in the last 7 days:\n${list || "(nothing completed this week)"}\n\nWrite a short, honest recap of my week. Be specific but brief.`,
    },
  ]);
}

export async function generateSubtaskSuggestions(task) {
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
  const reply = await generateChat(messages);
  return reply
    .split("\n")
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

// Free-text prompt — the user directly asked for this ("why isnt a box to
// enter prompt"); the two canned buttons above don't cover an open-ended
// question. Still grounded in the same task summary as "focus on today" so
// the model has real context, not just a bare question.
export async function generateFreeTextReply(prompt, tasks) {
  const list = summarizeTasksForPrompt(tasks);
  return generateChat([
    {
      role: "system",
      content: "You are a concise, helpful task-planning assistant for the user's private, on-device task list. Keep answers under 100 words.",
    },
    {
      role: "user",
      content: `Here are my open tasks:\n${list || "(no open tasks)"}\n\n${prompt}`,
    },
  ]);
}
