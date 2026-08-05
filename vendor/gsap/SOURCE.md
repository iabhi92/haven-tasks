# GSAP 3.12.5 + ScrollTrigger

Downloaded from `cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/{gsap.min.js,ScrollTrigger.min.js}`.
Vendored locally rather than loaded from cdnjs at runtime — the site's CSP is `script-src 'self'`,
which blocks third-party script hosts by design (see docs/ARCHITECTURE.md "Verifiable frontend");
every script the page runs has to be a same-origin file with a published SRI hash, GSAP included.

License: Standard GSAP license (free for this kind of use — see https://gsap.com/standard-license).
