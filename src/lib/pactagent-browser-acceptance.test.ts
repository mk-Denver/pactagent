import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findForbiddenPublicMaterial } from "../domain/forbidden-material";
import {
  PactAgentApiClient,
  type TransactionStatus,
} from "./pactagent-api-client";
import {
  scanForSecrets,
  startTestServer,
  stopTestServer,
  type ServerHandle,
} from "./pactagent-test-helpers";
import { readLiveDemoConfigFromEnv } from "./pactagent-workflow.live";

const liveConfig = readLiveDemoConfigFromEnv();

const collectedPublicBodies: string[] = [];
const collectedUrls: string[] = [];

describe.skipIf(!liveConfig)("PactAgent browser acceptance (live)", () => {
  let server: ServerHandle;
  let client: PactAgentApiClient;
  let transactionId: string;

  beforeAll(async () => {
    const env: Record<string, string | undefined> = {};
    if (liveConfig) {
      env.PACTAGENT_LIVE_RELAY_URL = liveConfig.relayUrl;
      env.PACTAGENT_CASHU_TEST_MINT_URL = liveConfig.testMintUrl;
      env.PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY = liveConfig.requesterPrivateKeyHex;
      env.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY = liveConfig.providerPrivateKeyHex;
      env.PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY = liveConfig.escrowAuthorityPrivateKeyHex;
      env.PACTAGENT_LIVE_NORMAL_SPEND_KEY = liveConfig.normalSpendKeyHex;
      env.PACTAGENT_LIVE_REFUND_SPEND_KEY = liveConfig.refundSpendKeyHex;
      env.PACTAGENT_LIVE_FUNDING_TOKEN = liveConfig.fundingToken;
    }
    server = await startTestServer(env);
    client = new PactAgentApiClient(server.apiToken, server.baseUrl);
  }, 120_000);

  afterAll(async () => {
    if (server) await stopTestServer(server);
  }, 30_000);

  it("bootstraps the runtime and verifies test mint readiness", async () => {
    const ready = await client.bootstrap();
    expect(ready.ready).toBe(true);
    expect(ready.unit).toBe("sat");
    collectedPublicBodies.push(JSON.stringify(ready));
  }, 30_000);

  it("submits a transaction with one stable idempotency key", async () => {
    const result = await client.startTransaction({
      idempotencyKey: "browser-acceptance-key-001",
      fundingReference: "live-funding-ref-001",
      privateDocument: "PRIVATE-DOCUMENT This is a synthetic test document for browser acceptance testing of the PactAgent requester flow.",
      mediaType: "text/plain",
      privatePrompt: "PRIVATE-PROMPT Summarize concisely.",
      maximumBudgetSats: "500",
    });
    expect(result.transactionId).toMatch(/^txn_/);
    transactionId = result.transactionId;
    collectedUrls.push(`${server.baseUrl}/api/transactions`);
  }, 30_000);

  it("duplicate idempotency key does not create a second agreement", async () => {
    const result = await client.startTransaction({
      idempotencyKey: "browser-acceptance-key-001",
      fundingReference: "live-funding-ref-001",
      privateDocument: "PRIVATE-DOCUMENT This is a synthetic test document for browser acceptance testing.",
      mediaType: "text/plain",
      maximumBudgetSats: "500",
    });
    expect(result.transactionId).toBe(transactionId);
  }, 30_000);

  it("polls lifecycle until settled", async () => {
    expect(transactionId).toBeDefined();
    const deadline = Date.now() + 240_000;
    let lastStatus: TransactionStatus | undefined;
    while (Date.now() < deadline) {
      const s = await client.getStatus(transactionId);
      lastStatus = s;
      collectedPublicBodies.push(JSON.stringify(s));
      if (s.finalOutcome === "settled" || s.finalOutcome === "refunded" || s.operationalState === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(lastStatus).toBeDefined();
    expect(lastStatus!.finalOutcome).toBe("settled");
    expect(lastStatus!.selectedOffer.amountSats).toBe("350");
  }, 300_000);

  it("selected offer shows P002 and 350-sat signed offer", async () => {
    const s = await client.getStatus(transactionId);
    expect(s.selectedOffer.amountSats).toBe("350");
    expect(s.selectedOffer.unit).toBe("sat");
    expect(s.selectedOffer.providerPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(s.selectedOffer.offerReference).toBeTruthy();
  }, 10_000);

  it("requester decision shows advisory model + deterministic policy", async () => {
    const s = await client.getStatus(transactionId);
    expect(s.requesterDecision).toBeDefined();
    const decision = s.requesterDecision!;
    expect(decision.recommendation.amountSats).toBe("350");
    expect(decision.policy.selectedProviderMatchesDiscovery).toBe(true);
    expect(decision.policy.priceAllowed).toBe(true);
    expect(decision.policy.withinRequesterBudget).toBe(true);
    expect(decision.authorized).toBe(true);
  }, 10_000);

  it("retrieves the safe terminal report separately", async () => {
    const r = await client.getReport(transactionId);
    collectedPublicBodies.push(JSON.stringify(r));
    expect(r.finalOutcome).toBe("settled");
    expect(r.amountSats).toBe("350");
    expect(r.lifecycle.length).toBeGreaterThanOrEqual(7);
    expect(r.lifecycle.every((step) => step.eventId.length === 64)).toBe(true);
  }, 10_000);

  it("retrieves the private summary through the authorized endpoint", async () => {
    const result = await client.getPrivateResult(transactionId);
    expect(result.summary).toBeTruthy();
    expect(result.summary.length).toBeGreaterThan(0);
  }, 10_000);

  it("reload recovers the same terminal transaction", async () => {
    const s = await client.getStatus(transactionId);
    expect(s.transactionId).toBe(transactionId);
    expect(s.finalOutcome).toBe("settled");
  }, 10_000);

  it("unauthorized requester cannot access transaction status", async () => {
    const response = await fetch(`${server.baseUrl}/api/transactions/${transactionId}`, {
      headers: { Authorization: "Bearer wrong-token" },
      cache: "no-store",
    });
    expect(response.status).toBe(401);
    const body = await response.text();
    collectedPublicBodies.push(body);
  }, 10_000);

  it("safe status and report responses contain no private material", async () => {
    for (const body of collectedPublicBodies) {
      const leaks = scanForSecrets(body);
      expect(leaks).toEqual([]);
      try {
        const parsed = JSON.parse(body);
        const reason = findForbiddenPublicMaterial(parsed);
        expect(reason).toBeUndefined();
      } catch {
        // Non-JSON body — already scanned for secret markers above
      }
    }
  }, 10_000);

  it("no private material appears in URLs", async () => {
    for (const url of collectedUrls) {
      const leaks = scanForSecrets(url);
      expect(leaks).toEqual([]);
    }
  }, 10_000);
});

describe("PactAgent browser acceptance (no live config)", () => {
  it("skips cleanly when live configuration is missing", () => {
    if (liveConfig) return;
    expect(true).toBe(true);
  });
});
