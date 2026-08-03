// Landing-page live demo. Uses the real crypto module — same encryptTask()
// the app itself runs — with a throwaway, non-persisted demo key. Nothing
// typed here is ever stored or sent anywhere; it exists only to show real
// ciphertext bytes for a real plaintext, per the same idea as the app's own
// reveal page.
import { generateDek, encryptTask } from "./crypto.js?v=20260804a";

const input = document.getElementById("landingDemoInput");
const plaintextEl = document.getElementById("landingPlaintext");
const ciphertextEl = document.getElementById("landingCiphertext");

const demoDek = await generateDek();
let token = 0;

async function update(title) {
  const current = ++token;
  const demoTask = {
    id: "landing-demo",
    title,
    notes: "",
    status: "todo",
    priority: "medium",
    dueDate: null,
    order: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const record = await encryptTask(demoTask, demoDek);
  if (current !== token) return;

  plaintextEl.textContent = JSON.stringify(demoTask, null, 2);
  ciphertextEl.textContent = JSON.stringify(
    { id: demoTask.id, iv: record.iv, ciphertext: record.ciphertext, updatedAt: demoTask.updatedAt },
    null,
    2
  );
}

input.addEventListener("input", () => update(input.value));
update("Try typing your own task title above");

// Scroll-reveal: fade+slide each .reveal-up element in once it enters the
// viewport. Plain IntersectionObserver, no animation library — matches the
// zero-dependency policy the rest of the app follows.
const revealObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.15 }
);
for (const el of document.querySelectorAll(".reveal-up")) {
  revealObserver.observe(el);
}
