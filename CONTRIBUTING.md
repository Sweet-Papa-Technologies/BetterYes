# Contributing to FOREMAN

Thanks for your interest! FOREMAN is a single-operator, self-hosted tool — contributions that
keep it simple, secure, and BYO are very welcome.

## Setup

```bash
pnpm install
pnpm foreman init --project <your-gcp-project>   # or fill .env from .env.example
pnpm dev:core      # daemon on :7777 (watch)
pnpm dev:ui        # Quasar dev server on :9000 (proxies the API)
```

Runtime state lives in `~/.foreman/` (override with `FOREMAN_HOME` for tests).

## Layout

```
packages/core      the daemon: secrets, config, db, models, director, router, coder,
                   ledger, gate, mcp-server, hermes, orchestrator, api + bin/foreman.ts
packages/shared    types shared between the daemon and the dashboard (type-only)
frontend           Quasar (Vue 3) dashboard PWA
docs/              product/design/UI specs, branding, screenshots
```

## Before you push

```bash
pnpm typecheck          # all packages must pass (tsc + vue-tsc)
pnpm foreman smoke      # the gate denies a planted write + a trivial job runs end-to-end
```

## Conventions

- **TypeScript everywhere**, ESM, strict. Match the surrounding code's style and comment density.
- The **rule gate** (`bin/foreman-gate.mjs`) is on the hot path of every tool call — keep it
  dependency-light and fail-safe (never default-allow on error).
- **Never log secrets.** Use the redactor; secret-pattern values must not reach logs or audit.
- Models, paths, and tokens are **config, not code** — nothing hardcoded.
- New surfaces against Claude Code (hooks, headless flags, `--mcp-config`) are version-sensitive;
  verify against current docs and version-gate parsers (see `coder/streamjson.ts`).

## Reporting issues

Include your `claude --version`, `node --version`, OS, and the relevant `~/.foreman/jobs/<id>/`
`events.jsonl` / `audit.jsonl` (with secrets redacted).

## License

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
