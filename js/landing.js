// Landing-page live demo. Uses the real crypto module — same encryptTask()
// the app itself runs — with a throwaway, non-persisted demo key. Nothing
// typed here is ever stored or sent anywhere; it exists only to show real
// ciphertext bytes for a real plaintext, per the same idea as the app's own
// reveal page.
import { generateDek, encryptTask } from "./crypto.js?v=20260804o";

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

// Subtle mouse-parallax on the hero's floating blobs — pure CSS custom
// properties updated from a mousemove listener, no animation library.
const hero = document.querySelector(".landing-hero");
const blobs = document.querySelectorAll(".landing-blob");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (hero && blobs.length && !reducedMotion) {
  hero.addEventListener("mousemove", (e) => {
    const rect = hero.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    blobs.forEach((blob, i) => {
      const depth = 14 + i * 6;
      blob.style.setProperty("--mx", `${px * depth}px`);
      blob.style.setProperty("--my", `${py * depth}px`);
    });
  });
}

// Same idea for the hero showcase card's floating spheres, at a larger
// depth range since the card is the visual focal point.
const showcase = document.getElementById("heroShowcase");
const spheres = document.querySelectorAll(".hero-sphere");
if (showcase && spheres.length && !reducedMotion) {
  showcase.addEventListener("mousemove", (e) => {
    const rect = showcase.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    spheres.forEach((sphere, i) => {
      const depth = 10 + (i % 3) * 6;
      sphere.style.transform = `translate(${px * depth}px, ${py * depth}px)`;
    });
  });
  showcase.addEventListener("mouseleave", () => {
    spheres.forEach((sphere) => { sphere.style.transform = ""; });
  });
}
