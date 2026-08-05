# JetBrains Mono (variable, latin subset)

Downloaded from Google Fonts' `css2` API (`family=JetBrains+Mono:wght@400;500;600`),
latin-subset `@font-face` block, with a desktop-Chrome user agent so Google serves the single
variable-font file (wght axis 200–800) instead of five separate static files. Vendored locally —
not loaded via `fonts.googleapis.com`/`fonts.gstatic.com` at runtime — because the site's CSP
(`default-src 'self'`) doesn't allow third-party font hosts, same reasoning as
`vendor/fonts/special-elite/`.

License: SIL Open Font License 1.1 (per Google Fonts).
