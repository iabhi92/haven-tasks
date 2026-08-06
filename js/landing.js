// Landing-page live demo + motion. The encryption demo uses the real crypto
// module — same encryptTask() the app itself runs — with a throwaway,
// non-persisted demo key. Nothing typed here is ever stored or sent
// anywhere; it exists only to show real ciphertext bytes for a real
// plaintext, per the same idea as the app's own reveal page.
import { generateDek, encryptTask } from "./crypto.js?v=20260806a";

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

// ---------- motion ----------
// GSAP is vendored locally (vendor/gsap/ — see SOURCE.md), not loaded from a
// CDN: the site's CSP is script-src 'self', so a third-party script host
// would just get silently blocked. Still, if the vendored file were ever
// missing or failed to parse, every .reveal-up/.lp-anim-fade element must
// not stay permanently invisible — that's an accessibility floor, not a
// nice-to-have — so everything below degrades to a plain
// IntersectionObserver + CSS transition when window.gsap isn't there.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const hasGsap = typeof window.gsap !== "undefined" && typeof window.ScrollTrigger !== "undefined";

if (hasGsap) gsap.registerPlugin(ScrollTrigger);

// Splits an element's text into word spans for a mask/slide-up reveal —
// same technique as the .hero-word-line elements' one-line variant, just
// per-word instead of per-line, for the two big headlines.
function splitWords(el) {
  const words = el.textContent.trim().split(/\s+/);
  el.textContent = "";
  for (const word of words) {
    const outer = document.createElement("span");
    outer.className = "lp-split-word";
    const inner = document.createElement("span");
    inner.className = "lp-split-word-inner";
    inner.textContent = word;
    outer.appendChild(inner);
    el.appendChild(outer);
    el.appendChild(document.createTextNode(" "));
  }
  return el.querySelectorAll(".lp-split-word-inner");
}

if (hasGsap && !reducedMotion) {
  // Per <span class="hero-word-line"> so "Your tasks." and "Stay yours."
  // (or the final CTA's two lines) split and stagger independently, in the
  // right reading order, rather than one flat word-soup across both lines.
  const heroLines = document.querySelectorAll("#heroTitle .hero-word-line");
  const finalLines = document.querySelectorAll("#finalCtaTitle .hero-word-line");
  const heroWords = [...heroLines].flatMap((line) => [...splitWords(line)]);
  const finalWords = [...finalLines].flatMap((line) => [...splitWords(line)]);

  const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
  tl.from(".landing-nav", { opacity: 0, duration: 0.7 }, 0)
    .from(heroWords, { yPercent: 110, duration: 1, stagger: 0.06, ease: "power4.out" }, 0.15)
    .to(".landing-eyebrow-pill", { opacity: 1, duration: 0.6 }, 0.1)
    .to(".landing-sub", { opacity: 1, duration: 0.7 }, 0.55)
    .from(".landing-sub", { y: 16, duration: 0.7 }, 0.55)
    .to(".landing-cta-row", { opacity: 1, duration: 0.6 }, 0.65)
    .from(".landing-cta-row", { y: 16, duration: 0.6 }, 0.65)
    .to(".landing-trust-line", { opacity: 1, duration: 0.6 }, 0.72)
    .to(".landing-dataflow-card", { opacity: 1, duration: 0.6 }, 0.78)
    .from(".landing-dataflow-card", { y: 16, duration: 0.6 }, 0.78)
    .to(".landing-hero-visual", { opacity: 1, duration: 0.8 }, 0.5)
    .from(".landing-hero-visual", { y: 24, scale: 0.97, duration: 0.8 }, 0.5);

  // Scroll-triggered reveals, staggered when siblings share a parent (feature
  // cards, pills) so a grid fans in rather than popping as one block.
  const groups = new Map();
  for (const el of document.querySelectorAll(".reveal-up")) {
    const key = el.parentElement;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(el);
  }
  for (const [parent, els] of groups) {
    gsap.set(els, { opacity: 0, y: 24 });
    ScrollTrigger.create({
      trigger: parent,
      start: "top 82%",
      once: true,
      onEnter: () => gsap.to(els, { opacity: 1, y: 0, duration: 0.8, stagger: 0.1, ease: "power3.out" }),
    });
  }

  gsap.utils.toArray(".lp-fcard").forEach((card) => {
    card.addEventListener("mousemove", (e) => {
      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      gsap.to(card, { rotationY: x * 7, rotationX: -y * 7, y: -8, duration: 0.5, transformPerspective: 1000, ease: "power2.out" });
    });
    card.addEventListener("mouseleave", () => {
      gsap.to(card, { rotationY: 0, rotationX: 0, y: 0, duration: 0.7, ease: "elastic.out(1, 0.6)" });
    });
  });

  gsap.from(".landing-final-cta-card", {
    scale: 0.94,
    opacity: 0,
    duration: 1,
    ease: "power3.out",
    scrollTrigger: { trigger: ".landing-final-cta-card", start: "top 85%", once: true },
  });
  gsap.set(finalWords, { yPercent: 110 });
  ScrollTrigger.create({
    trigger: "#finalCtaTitle",
    start: "top 85%",
    once: true,
    onEnter: () => gsap.to(finalWords, { yPercent: 0, duration: 0.9, stagger: 0.04, ease: "power4.out" }),
  });
} else {
  // No-GSAP / reduced-motion fallback: everything just needs to end up
  // visible, with or without the plain fade-up transition CSS already
  // defines for .reveal-up.
  for (const el of document.querySelectorAll(".lp-anim-fade, .landing-sub, .landing-cta-row, .landing-trust-line, .landing-dataflow-card, .landing-hero-visual, .landing-eyebrow-pill")) {
    el.style.opacity = "1";
  }
  if (!reducedMotion) {
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
    for (const el of document.querySelectorAll(".reveal-up")) revealObserver.observe(el);
  } else {
    for (const el of document.querySelectorAll(".reveal-up")) el.classList.add("is-visible");
  }
}

// ---------- custom cursor ----------
// Pointer devices only (hover:hover + pointer:fine) — never engages on
// touch/coarse pointers, and bows out entirely under reduced-motion.
if (!reducedMotion && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
  const cursor = document.querySelector(".landing-cursor");
  document.body.classList.add("has-custom-cursor");
  let mx = 0, my = 0, cx = 0, cy = 0;
  document.addEventListener("mousemove", (e) => { mx = e.clientX; my = e.clientY; });
  (function animateCursor() {
    cx += (mx - cx) * 0.22;
    cy += (my - cy) * 0.22;
    cursor.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
    requestAnimationFrame(animateCursor);
  })();
  for (const el of document.querySelectorAll("a, button, .lp-fcard, .lp-pill")) {
    el.addEventListener("mouseenter", () => { cursor.style.width = "34px"; cursor.style.height = "34px"; });
    el.addEventListener("mouseleave", () => { cursor.style.width = "12px"; cursor.style.height = "12px"; });
  }
}
