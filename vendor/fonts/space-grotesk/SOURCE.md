# Space Grotesk (variable, latin subset)

Downloaded from Google Fonts' `css2` API (`family=Space+Grotesk:wght@300..700`), latin-subset
`@font-face` block, with a desktop-Chrome user agent so Google serves the single variable-font
file (wght axis 300–700) instead of separate static files. Vendored locally — not loaded via
`fonts.googleapis.com`/`fonts.gstatic.com` at runtime — because the site's CSP
(`default-src 'self'`) doesn't allow third-party font hosts, same reasoning as
`vendor/fonts/manrope/`. Used for the marketing-site neo-brutalist redesign (index.html,
compare.html, features.html, security.html) — headings only, not the app itself.

License: SIL Open Font License 1.1 (per Google Fonts).
