# FOREMAN dashboard

The Quasar (Vue 3) PWA dashboard for FOREMAN — the "developer mission control" design from
`../STITCH_BRIEF.md`. It talks to the core daemon over REST + WebSocket and shares DTOs via
`@foreman/shared`.

This is a workspace package; run it from the repo root:

```bash
pnpm dev:ui     # Quasar dev server on :9000 (daemon must run on :7777)
pnpm build      # builds the SPA into frontend/dist/spa, served by `foreman serve`
```

See the root `README.md` for the full quickstart.
