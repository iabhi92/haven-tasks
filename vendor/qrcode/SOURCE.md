# QR Code Generator for JavaScript

Vendored from `kazuhikoarase/qrcode-generator` (MIT license), commit `83b7e8f`
(`master` as of 2026-08-10), file `js/dist/qrcode.mjs` — unmodified. Same reason
every other `vendor/` library here is self-hosted: the site's CSP is
`script-src 'self'`, so every script the page runs has to be a same-origin
file, no CDN.

Only `qrcode.mjs` is vendored, not the sibling `qrcode_UTF8.mjs` add-on — the
one thing this app ever encodes into a QR code is a URL, which is already
ASCII-safe, so the UTF-8 byte-mode helper adds nothing here.

Used by `js/deadmanswitch.js` and `js/app.js` (share-link and dead-man's-switch
QR display) via `_this.createSvgTag()`, which returns a plain inline `<svg>`
string with no `<script>` content — safe to insert via `innerHTML` under this
site's CSP without any additional allowance.

License: MIT (`http://www.opensource.org/licenses/mit-license.php`), per the
header comment in the vendored file itself.
