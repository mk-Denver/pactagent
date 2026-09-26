# PactAgent Requester UI (Issue #34)

The PactAgent requester UI is a thin client over the #33 runtime HTTP API.
It allows an authorized requester to submit a private document, follow
authoritative lifecycle progress, retrieve the private summary, and inspect
the safe terminal report without importing workflow, relay, signer, Cashu,
or settlement modules.

## Local frontend and runtime startup

### Requirements

- Node.js 22 or newer
- npm

### Install

```sh
npm install
```

### Build

```sh
npm run build
```

### Start the runtime

The runtime serves both the HTTP API and the frontend:

```sh
npm run runtime:start
```

Or for local test-mint development:

```sh
npm run runtime:start:local
```

### Development mode

```sh
npm run dev
```

## Required runtime/API configuration

The runtime reads these environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `PACTAGENT_RUNTIME_API_TOKEN` | Yes | Bearer token for API authorization |
| `PACTAGENT_LIVE_RELAY_URL` | Live only | WebSocket Nostr relay URL |
| `PACTAGENT_CASHU_TEST_MINT_URL` | Live only | Cashu test mint URL |
| `PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY` | Live only | Requester Nostr private key (hex) |
| `PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY` | Live only | Provider Nostr private key (hex) |
| `PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY` | Live only | Escrow authority Nostr private key (hex) |
| `PACTAGENT_LIVE_NORMAL_SPEND_KEY` | Live only | Cashu normal spending key (hex) |
| `PACTAGENT_LIVE_REFUND_SPEND_KEY` | Live only | Cashu refund spending key (hex) |
| `PACTAGENT_LIVE_FUNDING_TOKEN` | Live only | Pre-acquired test ecash token |
| `PACTAGENT_LIVE_STATE_DIRECTORY` | Live only | Durable state directory path |

Missing live configuration causes a clean error — never a fallback to
production or an arbitrary mint/relay.

## Supported document types and size limits

- **Text/plain**: up to 1 MB
- **Application/pdf**: up to 1 MB
- Private prompt: up to 2 KB

## Authentication expectations

The requester enters the runtime API token in the connect panel. The token
is sent as a `Bearer` header on every API request. No private keys, tokens,
proofs, or credentials are handled in the browser — only the API token and
funding reference.

## Safe status versus private result behavior

The UI separates two information surfaces:

- **Safe status** — public lifecycle state, selected offer, references, and
  operational state. This is the default view and contains no private
  material.
- **Private summary** — the complete document summary, retrieved only through
  the authorized `/api/transactions/{id}/result` endpoint. It is fetched
  on-demand, displayed in a separate section, and never persisted to browser
  storage.

## Transaction reload recovery

The transaction ID is retained in `sessionStorage` (not `localStorage`) so
that a page reload recovers the same transaction. On reload, the UI fetches
authoritative state from the runtime — it does not resubmit the document or
create a new transaction.

When the requester signs out or closes the transaction, all in-memory private
state (document, prompt, summary) is cleared and the session transaction ID
is removed.

## Resume and reconciliation UX

- **Resume** — shown only when the runtime reports `availableActions.resume`
  as true. Calls `POST /api/transactions/{id}/resume`.
- **Reconcile** — shown only when the runtime reports
  `availableActions.reconcile` as true. Requires explicit user action (button
  click). Calls `POST /api/transactions/{id}/reconcile`.
- Both actions are disabled while a request is in flight.
- Neither action triggers blind client-side retry loops.

## Deterministic browser verification

```sh
npm run test
```

This runs the API client unit tests which verify the client's type safety,
idempotency key generation, and session storage behavior.

## Opt-in live browser smoke verification

The live browser acceptance test launches the built Next.js server and
drives the complete flow through the HTTP API:

```sh
npm run build
npx vitest run --config vitest.live.config.ts --maxWorkers=1 src/lib/pactagent-browser-acceptance.test.ts
```

Requires the same `PACTAGENT_LIVE_*` environment variables as the runtime.
Missing configuration skips the suite cleanly.

## Browser privacy and storage guarantees

- The document, prompt, summary, funding reference, and API token are never
  placed in URLs or query strings.
- No private material is stored in `localStorage`, `IndexedDB`, or
  service-worker caches.
- Only the transaction ID is retained in `sessionStorage` for reload
  recovery.
- All API responses use `Cache-Control: no-store`.
- Runtime errors are rendered through redacted, allowlisted UI messages.
- All server-returned strings are treated as untrusted content (no
  `dangerouslySetInnerHTML`).
- The private summary is cleared from memory on sign-out or transaction
  close.

## Trust boundary view

The UI displays a trust-boundary section that distinguishes:

**Safe / public-shaped:**
- Provider identity and stable references
- Signed offer amount (350 sats)
- Lifecycle state
- Settlement / refund reference
- Opaque escrow reference

**Private:**
- Source document
- Requester prompt
- Complete summary
- Cashu proofs and secrets
- Signing and encryption keys
- Terms-commitment salt

This view is derived from runtime allowlisted metadata — it does not inspect
or expose private payloads to prove they are private.

## Requester decision view

The UI displays the requester decision as two clearly distinguished cards:

1. **AI recommendation** — the model's advisory recommendation for the
   selected 350-sat offer. Labeled as advisory only.
2. **Deterministic policy** — the six policy checks (provider match, price,
   budget, Cashu compatibility, references, execution duration) with
   pass/fail indicators, and the final authorization decision.

The frontend does not reproduce the requester-decision policy. It renders
the allowlisted projection returned by the runtime.

## Current integrated-PoC and test-mint limitations

- Only `document-summary@1` capability is supported.
- Only `text/plain` and `application/pdf` media types are accepted.
- Only one provider (P002) is discovered per transaction.
- The Cashu test mint uses test ecash only — no production funds.
- The model is deterministic (no external AI vendor integration).
- No multi-mint routing, multi-asset settlement, or marketplace features.
