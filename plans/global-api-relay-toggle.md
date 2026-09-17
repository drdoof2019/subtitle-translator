# Global "API Relay" Toggle (CORS Bypass) — Plan

## ADDENDUM (round 2) — Local server-side relay for custom endpoints

User case: OpenCode **Go** subscription base URL `https://opencode.ai/zen/go/v1` pasted into
Custom (OpenAI-compatible) + relay ON + empty relayBase → still CORS. Correct by design:
the built-in Cloudflare Worker has no `llm` route and no allowlist entry for that address,
so `relayWouldServe` sends it direct. Worker source is not in this repo → cannot be extended.

Fix: a **local server-side relay** (same pattern as `PROXY_ENDPOINTS.deepl` → `/api/deepl`).
User runs `npm run dev`, so `useLocalApi === true` and Next.js route handlers exist.

1. New `src/app/api/relay/route.ts`
   - `POST /api/relay?endpoint=<absolute http(s) url>`; validates endpoint (reject non-http(s),
     reject localhost/private-IP? → NO: local runtimes (LM Studio) are the primary use case and
     this route runs on the user's own machine; only reject non-http(s) schemes).
   - Forwards `Authorization`, `x-api-key`, `anthropic-version`, `Content-Type`, `x-opencode-*`
     + raw body via server-side `fetch` (no browser → no CORS).
   - Pipes upstream status + body back. 400 JSON when endpoint missing/invalid.
   - `export const dynamic = "force-dynamic"`.
2. `services/shared.ts`
   - Export `LOCAL_RELAY_ENABLED = useLocalApi` and `LOCAL_RELAY_PATH = "/api/relay"`.
   - `relayBaseUrl`: empty base + `useLocalApi` → `LOCAL_RELAY_PATH` (instead of the Worker).
     Non-empty (self-hosted) base unchanged. Static-export prod unchanged (Worker).
3. `registry.ts`
   - `relayWouldServe`: the `URL_IS_PRIMARY_CRED` block applies only to the **remote** built-in
     Worker. When `useLocalApi` and base is empty, the built-in IS the local relay → custom and
     local endpoints are servable → return true.
4. UI (`TranslationSettings.tsx`)
   - `forceRelayBuiltinNoCustom` / `useRelayCustomUrl` notes must not claim "can't forward" when
     the local relay is in effect → gate on `LOCAL_RELAY_ENABLED`.
   - `relayBaseExtra` tooltip: mention that in dev/Docker an empty field means the local relay.
5. Verify: `tsc`, `eslint`, then manual Test Connection with the Go URL, relay ON, empty base → 200.

Out of scope: static-export builds (no route handlers) — there the user still needs a self-hosted
Worker; UI note stays accurate for that case.

## Problem
API Relay (Cloudflare Worker, `LLM_RELAY_BASE`) exists but the per-provider `useRelay` switch is only rendered for providers whose defaults carry a `useRelay` field (`isRelayCapable` in registry.ts). Users hitting CORS with Custom (OpenAI-compatible) endpoints have no switch at all — the service layer never even consults the relay (`llm` service uses `requireUrl` directly, llm.ts:586).

## Desired semantics (user-approved direction)
- Toggle **OFF (default)** → behavior byte-identical to today. Zero risk.
- Toggle **ON** → relay forced for **every provider that can physically use it**; providers that can't show an explanatory note (never a silent failure).

## Physical constraints (must be surfaced in UI, not fought)
The built-in Worker is **not an open proxy**: it forwards only endpoints in its per-provider allowlist (`?endpoint=` exact-match validation, shared.ts:38). Therefore:
- Official vendor endpoints (openai-compat family, Claude, Yandex) → built-in relay works. ✅
- Custom/local endpoints (LM Studio `127.0.0.1`, Together, Fireworks, self-hosted gateways) → built-in Worker would 400 (or can't reach localhost at all). Relay only possible with a **self-hosted `relayBase`** (user's own Worker deployment, whose allowlist he declares). ⚠️
- Gemini: model id is embedded in the URL path → pass-through forwarding impossible. ⚠️
- Local models (LM Studio/Ollama/llama.cpp) don't have a CORS problem to begin with (runtime sends ACAO headers) — relay would only break them.

## Changes

### 1. State plumbing
- [`types.ts`](src/app/lib/translation/types.ts) — `RuntimeGlobals` += `forceRelay: boolean | undefined` (required key → both shells fail compile until updated, per existing convention).
- [`useTranslationState.tsx`](src/app/hooks/useTranslationState.tsx) — `useLocalStorage("translation-forceRelay", false)`, export via context (alongside `relayBase`).
- **Chokepoint**: `getSelectedConfig()` merges `useRelay: forceRelay || existing.useRelay` **only when the provider config has a `useRelay` field** (same predicate as the UI switch: `config.useRelay !== undefined`). This one function feeds the translation run, status badge, Test, and preflight.
- [`hooks/translation/validation.ts`](src/app/hooks/translation/validation.ts) — buildTestConfig already takes `useRelay` from config; ensure callers pass the merged value (it flows through `getSelectedConfig`).

### 2. Extend relay capability to Custom (`llm`)
- [`registry.ts`](src/app/lib/translation/registry.ts) — add `useRelay: false` to `llm` defaults → switch renders, `isRelayCapable` true, hint logic picks it up.
- [`services/llm.ts`](src/app/lib/translation/services/llm.ts) — `llm` service: replace `completeOpenAICompatUrl(requireUrl(...))` with `resolveWireEndpoint("llm", { url, useRelay, relayBase })` + keep `requireUrl` for the empty-URL error.
- [`registry.ts`](src/app/lib/translation/registry.ts) — **close the leak in `relayWouldServe`**: for `URL_IS_PRIMARY_CRED` services (llm/translategemma/milmmt), the built-in relay must never be used (their "variant" chips are local runtimes the Worker can't reach and aren't in its allowlist). New rule: builtin base + user-supplied-cred service → direct. Self-hosted base → relay (user's machine, user's allowlist).
  - `relayWouldServe = !usesBuiltinRelay(base) ? true : classifyEndpointUrl(...).kind !== "custom" && !URL_IS_PRIMARY_CRED.has(service)`
- `resolveWireEndpoint` for `llm`: `getRelayAllowlist("llm")` returns the runtime chips — empty-URL case already blocked by `requireUrl`, so target always = user URL. No `[0]!` assumption violation (url is required here).
- TranslateGemma/MiLMMT: **no relay wiring** (they POST `/v1/completions` with pre-rendered prompts; Worker contract is chat/completions + their endpoints are local). They keep the CORS hint path (`isUserSuppliedEndpoint` → `errorHintCors`). Documented in UI note.

### 3. UI
- [`AdvancedTranslationSettings.tsx`](src/app/components/AdvancedTranslationSettings.tsx) — new `ToggleRow` in "Network / Resilience" section: **"Force API relay (CORS bypass)"** + tooltip explaining: when ON, all relay-capable providers route through the relay; providers without relay support are listed in the note; needs relay address for custom endpoints.
- [`TranslationSettings.tsx`](src/app/components/TranslationSettings.tsx):
  - `relayBase` input visibility: currently `config?.useRelay === true` → also show when `forceRelay` is ON (global field, provider-independent).
  - Per-provider switch: when `forceRelay` is ON and the provider has the field, render it **checked + disabled** with `extra` text "Forced by global API relay setting" (honest state display; the effective value is what's on the wire).
  - When `forceRelay` ON + provider is `llm` + builtin relayBase → `useRelayCustomUrl`-style note: built-in relay can't forward custom/local addresses; enter your own relay address.
- Props threading: `forceRelay`/`setForceRelay` via `useTranslationContext` (already carries `relayBase`).

### 4. Settings file + CLI parity
- [`settingsSchema.ts`](src/app/lib/translation/settingsSchema.ts) — `TranslationSettings.forceRelay?: boolean`, `FIELD_KINDS.forceRelay: "boolean"`, `pickRuntimeGlobals` += forceRelay.
- [`scripts/cli.ts`](scripts/cli.ts) — CLI reads `forceRelay` from settings file via `pickRuntimeGlobals`; Node has no CORS so default (false/off) keeps direct behavior. Same merge rule as web (only providers with the field).

### 5. i18n (18 files in `messages/`)
Keys under `common`: `forceRelay`, `forceRelayTooltip`, `forceRelayActive` (switch-override note), `forceRelayNoBuiltinForCustom` (custom-endpoint note). tr + en authored fully; other 16 locales get same-key translations (existing files all carry `useRelay*` keys — mirror their style).

### 6. Verification
- `yarn tsc --noEmit` + eslint.
- Grep sweep: every `params.useRelay` consumer goes through the chokepoint.
- Manual matrix: toggle OFF → no behavior change (compare network tab); toggle ON + OpenAI → request URL is `…workers.dev/api/openai?endpoint=…`; ON + Custom + builtin base → direct (leak closed); ON + Custom + self-hosted base → relayed.

## Out of scope (explicit)
- Adding Worker routes for Gemini/MT/local endpoints (Worker source not in this repo; `scripts/llm-proxy-worker.js` referenced but absent).
- Changing built-in relay security model (allowlist stays — it's what keeps API keys from becoming an open proxy).
