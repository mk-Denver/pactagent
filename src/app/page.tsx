"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  PactAgentApiClient,
  clearRetainedTransactionId,
  generateIdempotencyKey,
  loadRetainedTransactionId,
  retainTransactionId,
  type OperationalState,
  type PrivateResult,
  type RuntimeBootstrap,
  type RuntimePhase,
  type TransactionStatus,
  type WorkflowReport,
} from "@/lib/pactagent-api-client";

import { PactAgentLogo } from "./pactagent-logo";

const MAX_DOCUMENT_BYTES = 1_048_576;
const MAX_PROMPT_BYTES = 2_048;
const DEFAULT_BUDGET = "500";
const POLL_INTERVAL_MS = 2_000;

type View = "landing" | "form" | "transaction";

export default function Home() {
  const [, setApiToken] = useState("");
  const [fundingReference, setFundingReference] = useState("");
  const [view, setView] = useState<View>("landing");
  const [client, setClient] = useState<PactAgentApiClient | undefined>();
  const [bootstrap, setBootstrap] = useState<RuntimeBootstrap | undefined>();
  const [bootstrapError, setBootstrapError] = useState<string | undefined>();
  const [transactionId, setTransactionId] = useState<string | undefined>(() => loadRetainedTransactionId());
  const [status, setStatus] = useState<TransactionStatus | undefined>();
  const [report, setReport] = useState<WorkflowReport | undefined>();
  const [privateResult, setPrivateResult] = useState<PrivateResult | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [actionInFlight, setActionInFlight] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pollTrigger, setPollTrigger] = useState(0);
  const [idempotencyKey, setIdempotencyKey] = useState<string | undefined>(undefined);
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const createClient = useCallback((token: string) => {
    return new PactAgentApiClient(token);
  }, []);

  const handleConnect = useCallback(
    async (token: string, fundingRef: string) => {
      setError(undefined);
      setBootstrapError(undefined);
      const c = createClient(token);
      try {
        const ready = await c.bootstrap();
        setClient(c);
        setApiToken(token);
        setFundingReference(fundingRef);
        setBootstrap(ready);
        const retained = loadRetainedTransactionId();
        if (retained) {
          setTransactionId(retained);
          setView("transaction");
        } else {
          setView("form");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Bootstrap failed";
        setBootstrapError(message);
      }
    },
    [createClient],
  );

  const handleSignOut = useCallback(() => {
    clearRetainedTransactionId();
    setClient(undefined);
    setApiToken("");
    setBootstrap(undefined);
    setBootstrapError(undefined);
    setTransactionId(undefined);
    setStatus(undefined);
    setReport(undefined);
    setPrivateResult(undefined);
    setView("landing");
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = undefined;
    }
  }, []);

  const handleSubmit = useCallback(
    async (input: {
      idempotencyKey: string;
      document: string;
      mediaType: "text/plain" | "application/pdf";
      prompt?: string;
      budgetSats: string;
    }) => {
      if (!client) return;
      setSubmitting(true);
      setError(undefined);
      try {
        const result = await client.startTransaction({
          idempotencyKey: input.idempotencyKey,
          fundingReference,
          privateDocument: input.document,
          mediaType: input.mediaType,
          ...(input.prompt ? { privatePrompt: input.prompt } : {}),
          maximumBudgetSats: input.budgetSats,
        });
        setTransactionId(result.transactionId);
        setIdempotencyKey(input.idempotencyKey);
        retainTransactionId(result.transactionId);
        setView("transaction");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Submission failed");
      } finally {
        setSubmitting(false);
      }
    },
    [client, fundingReference],
  );

  const handleResume = useCallback(async () => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    setError(undefined);
    try {
      const r = await client.resume(transactionId);
      setReport(r);
      setPollTrigger((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resume failed");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId]);

  const handleReconcile = useCallback(async () => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    setError(undefined);
    try {
      const result = await client.reconcile(transactionId);
      if ("workflowVersion" in result) {
        setReport(result);
      }
      setPollTrigger((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconcile failed");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId]);

  const handleFetchReport = useCallback(async () => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    setError(undefined);
    try {
      const r = await client.getReport(transactionId);
      setReport(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report fetch failed");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId]);

  const handleFetchResult = useCallback(async () => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    setError(undefined);
    try {
      const r = await client.getPrivateResult(transactionId);
      setPrivateResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Result fetch failed");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId]);

  const handleCloseTransaction = useCallback(() => {
    setPrivateResult(undefined);
    setReport(undefined);
    setStatus(undefined);
    setTransactionId(undefined);
    setIdempotencyKey(undefined);
    clearRetainedTransactionId();
    setView("form");
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    if (!client || !transactionId) return;
    let cancelled = false;
    const doPoll = async (): Promise<void> => {
      try {
        const s = await client.getStatus(transactionId);
        if (cancelled) return;
        setStatus(s);
        if (
          s.finalOutcome === "settled" ||
          s.finalOutcome === "refunded" ||
          s.operationalState === "failed" ||
          s.operationalState === "reconciliation_required"
        ) {
          return;
        }
        pollRef.current = setTimeout(() => void doPoll(), POLL_INTERVAL_MS);
      } catch (err) {
        if (!cancelled && err instanceof Error) {
          setError(err.message);
        }
      }
    };
    void doPoll();
    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = undefined;
      }
    };
  }, [client, transactionId, pollTrigger]);

  return (
    <main>
      <section className="hero">
        <nav aria-label="Project identity">
          <PactAgentLogo />
        </nav>
        <div className="heroCopy">
          <p className="eyebrow">Application-level machine economy</p>
          <h1>Agents make pacts.<br /><em>Protocols keep the truth.</em></h1>
          <p className="lede">
            Submit a private document. An autonomous agent discovers a provider, signs a service agreement,
            funds Cashu escrow, executes the summary, and settles — all over Nostr and Cashu.
          </p>
        </div>
      </section>

      {view === "landing" && (
        <ConnectPanel onConnect={handleConnect} error={bootstrapError} />
      )}

      {view === "form" && bootstrap && client && (
        <TransactionForm
          bootstrap={bootstrap}
          submitting={submitting}
          onSubmit={handleSubmit}
          error={error}
        />
      )}

      {view === "transaction" && status && (
        <TransactionDetail
          status={status}
          report={report}
          privateResult={privateResult}
          idempotencyKey={idempotencyKey}
          actionInFlight={actionInFlight}
          error={error}
          onResume={handleResume}
          onReconcile={handleReconcile}
          onFetchReport={handleFetchReport}
          onFetchResult={handleFetchResult}
          onClose={handleCloseTransaction}
          onSignOut={handleSignOut}
        />
      )}

      {view === "transaction" && !status && (
        <section className="section">
          <p role="status" aria-live="polite">Loading transaction status...</p>
        </section>
      )}

      <footer>
        <span>PactAgent</span>
        <span>BOSS Battle 2026 · Freedom Stack + Machine Money</span>
      </footer>
    </main>
  );
}

function ConnectPanel({
  onConnect,
  error,
}: {
  onConnect: (token: string, fundingRef: string) => void;
  error?: string;
}) {
  const [token, setToken] = useState("");
  const [fundingRef, setFundingRef] = useState("");
  return (
    <section className="section connectPanel" aria-labelledby="connect-heading">
      <h2 id="connect-heading">Connect to PactAgent runtime</h2>
      <p className="sectionNote">
        Enter your runtime API token and pre-acquired test funding reference.
        This connects to the configured Cashu test mint — no production funds.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConnect(token, fundingRef);
        }}
        className="connectForm"
      >
        <label htmlFor="api-token">Runtime API token</label>
        <input
          id="api-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          autoComplete="off"
          aria-describedby="api-token-help"
        />
        <small id="api-token-help" className="inputHelp">
          The bearer token configured as PACTAGENT_RUNTIME_API_TOKEN on the runtime.
        </small>

        <label htmlFor="funding-ref">Funding reference</label>
        <input
          id="funding-ref"
          type="text"
          value={fundingRef}
          onChange={(e) => setFundingRef(e.target.value)}
          required
          autoComplete="off"
          aria-describedby="funding-ref-help"
        />
        <small id="funding-ref-help" className="inputHelp">
          Opaque reference to pre-acquired test ecash resolved by the runtime.
        </small>

        {error && (
          <p role="alert" className="errorText" id="connect-error">{error}</p>
        )}

        <button type="submit" disabled={!token || !fundingRef}>
          Connect
        </button>
      </form>
    </section>
  );
}

function TransactionForm({
  bootstrap,
  submitting,
  onSubmit,
  error,
}: {
  bootstrap: RuntimeBootstrap;
  submitting: boolean;
  onSubmit: (input: {
    idempotencyKey: string;
    document: string;
    mediaType: "text/plain" | "application/pdf";
    prompt?: string;
    budgetSats: string;
  }) => void;
  error?: string;
}) {
  const [document, setDocument] = useState("");
  const [mediaType, setMediaType] = useState<"text/plain" | "application/pdf">("text/plain");
  const [prompt, setPrompt] = useState("");
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [docError, setDocError] = useState<string | undefined>();
  const [promptError, setPromptError] = useState<string | undefined>();
  const [budgetError, setBudgetError] = useState<string | undefined>();
  const [idempotencyKey] = useState(() => generateIdempotencyKey());

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_DOCUMENT_BYTES) {
      setDocError(`Document exceeds ${MAX_DOCUMENT_BYTES} byte limit`);
      return;
    }
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    setMediaType(isPdf ? "application/pdf" : "text/plain");
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (isPdf) {
        const bytes = typeof result === "string"
          ? new TextEncoder().encode(result)
          : new Uint8Array(result as ArrayBuffer);
        const b64 = btoa(String.fromCharCode(...bytes));
        setDocument(b64);
        setDocError(undefined);
      } else if (typeof result === "string") {
        setDocument(result);
        setDocError(undefined);
      } else {
        const bytes = new Uint8Array(result as ArrayBuffer);
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        setDocument(decoded);
        setDocError(undefined);
      }
    };
    reader.onerror = () => setDocError("Failed to read file");
    if (isPdf) {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file);
    }
  }

  function validateAndSubmit(e: React.FormEvent) {
    e.preventDefault();
    let valid = true;
    if (!document) {
      setDocError("Document is required");
      valid = false;
    } else if (new Blob([document]).size > MAX_DOCUMENT_BYTES) {
      setDocError(`Document exceeds ${MAX_DOCUMENT_BYTES} byte limit`);
      valid = false;
    } else {
      setDocError(undefined);
    }
    if (prompt && new Blob([prompt]).size > MAX_PROMPT_BYTES) {
      setPromptError(`Prompt exceeds ${MAX_PROMPT_BYTES} byte limit`);
      valid = false;
    } else {
      setPromptError(undefined);
    }
    const budgetNum = Number(budget);
    if (!Number.isInteger(budgetNum) || budgetNum < 1) {
      setBudgetError("Budget must be a positive whole number of sats");
      valid = false;
    } else {
      setBudgetError(undefined);
    }
    if (!valid) return;
    onSubmit({
      idempotencyKey,
      document,
      mediaType,
      ...(prompt ? { prompt } : {}),
      budgetSats: budget,
    });
  }

  return (
    <section className="section" aria-labelledby="form-heading">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow dark">New transaction</p>
          <h2 id="form-heading">Summarize a document for ≤ {budget} sats</h2>
        </div>
        <p className="sectionNote">
          Cashu test mint: <code>{bootstrap.mintUrl}</code> · unit: <code>{bootstrap.unit}</code> · test ecash only
        </p>
      </div>

      <form onSubmit={validateAndSubmit} className="txnForm">
        <fieldset>
          <legend>Private document</legend>
          <label htmlFor="doc-upload">Upload document (text or PDF, max {Math.round(MAX_DOCUMENT_BYTES / 1024)} KB)</label>
          <input
            id="doc-upload"
            type="file"
            accept="text/plain,application/pdf,.txt,.pdf"
            onChange={handleFileUpload}
            aria-describedby="doc-status"
          />
          <small id="doc-status" className="inputHelp">
            {document ? `Loaded (${new Blob([document]).size} bytes)` : "No document loaded"}
          </small>
          {docError && <p role="alert" className="errorText">{docError}</p>}
          <label htmlFor="doc-text">Or paste document text</label>
          <textarea
            id="doc-text"
            value={mediaType === "text/plain" ? document : ""}
            onChange={(e) => {
              setDocument(e.target.value);
              setMediaType("text/plain");
            }}
            rows={6}
            placeholder={mediaType === "application/pdf" ? "PDF loaded as base64 — paste text to replace" : "Paste your document here..."}
            aria-describedby="doc-status"
          />
        </fieldset>

        <fieldset>
          <legend>Request parameters</legend>
          <label htmlFor="budget">Maximum budget (sats)</label>
          <input
            id="budget"
            type="number"
            min={1}
            step={1}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            required
            aria-describedby="budget-help"
          />
          <small id="budget-help" className="inputHelp">
            Whole sats only. Default: 500.
          </small>
          {budgetError && <p role="alert" className="errorText">{budgetError}</p>}

          <label htmlFor="prompt">Private prompt (optional, max {MAX_PROMPT_BYTES} bytes)</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder="e.g. Summarize concisely"
            aria-describedby="prompt-help"
          />
          <small id="prompt-help" className="inputHelp">
            Bounded instruction sent privately to the provider.
          </small>
          {promptError && <p role="alert" className="errorText">{promptError}</p>}
        </fieldset>

        {error && <p role="alert" className="errorText">{error}</p>}

        <button type="submit" disabled={submitting || !document}>
          {submitting ? "Submitting..." : "Submit transaction"}
        </button>
      </form>
    </section>
  );
}

const PHASE_LABELS: Record<RuntimePhase, string> = {
  initialized: "Initialized",
  proposed: "Proposed",
  accepted: "Accepted",
  escrow_funded: "Escrow funded",
  task_delivered: "Task delivered",
  result_submitted: "Result submitted",
  result_verified: "Result verified",
  release_authorized: "Release authorized",
  settled: "Settled",
  refund_authorized: "Refund authorized",
  refunded: "Refunded",
};

const STATE_COLORS: Record<OperationalState, string> = {
  active: "active",
  failed: "failed",
  reconciliation_required: "reconciliation",
  resolved_not_funded: "failed",
  refunded: "refunded",
  settled: "settled",
};

function TransactionDetail({
  status,
  report,
  privateResult,
  idempotencyKey,
  actionInFlight,
  error,
  onResume,
  onReconcile,
  onFetchReport,
  onFetchResult,
  onClose,
  onSignOut,
}: {
  status: TransactionStatus;
  report?: WorkflowReport;
  privateResult?: PrivateResult;
  idempotencyKey?: string;
  actionInFlight: boolean;
  error?: string;
  onResume: () => void;
  onReconcile: () => void;
  onFetchReport: () => void;
  onFetchResult: () => void;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const stateClass = STATE_COLORS[status.operationalState] ?? "active";
  const offer = status.selectedOffer;

  return (
    <>
      <section className="section txnStatusSection" aria-labelledby="txn-heading">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow dark">Transaction {status.transactionId.slice(0, 16)}...</p>
            <h2 id="txn-heading">{PHASE_LABELS[status.phase] ?? status.phase}</h2>
          </div>
          <div className="stateBadge">
            <span className={`dot ${stateClass}`} aria-hidden="true" />
            <span aria-live="polite" role="status">{status.operationalState.replace(/_/g, " ")}</span>
          </div>
        </div>

        {idempotencyKey && (
          <p className="idempotencyNote">
            Idempotency key: <code>{idempotencyKey.slice(0, 16)}...</code>
            <small> One key per logical request prevents duplicate agreements.</small>
          </p>
        )}

        <dl className="txnGrid">
          <div><dt>Agreement ID</dt><dd><code>{status.agreementId.slice(0, 24)}...</code></dd></div>
          <div><dt>Provider</dt><dd><code>{offer.providerPublicKey.slice(0, 20)}...</code></dd></div>
          <div><dt>Amount</dt><dd>{offer.amountSats} {offer.unit}</dd></div>
          <div><dt>Kind</dt><dd>{status.kind}</dd></div>
        </dl>

        {status.agreementRootEventId && (
          <p className="refNote">
            Root event: <code>{status.agreementRootEventId.slice(0, 24)}...</code>
          </p>
        )}
        {status.escrowReference && (
          <p className="refNote">Escrow: <code>{status.escrowReference}</code></p>
        )}
        {status.settlementReference && (
          <p className="refNote">Settlement: <code>{status.settlementReference}</code></p>
        )}
        {status.refundReference && (
          <p className="refNote">Refund: <code>{status.refundReference}</code></p>
        )}

        {error && <p role="alert" className="errorText">{error}</p>}

        {status.failureCode && (
          <p role="alert" className="errorText">Transaction failed: {status.failureCode.replace(/_/g, " ")}</p>
        )}

        <div className="actionRow">
          {status.availableActions.resume && (
            <button onClick={onResume} disabled={actionInFlight}>
              Resume
            </button>
          )}
          {status.availableActions.reconcile && (
            <button onClick={onReconcile} disabled={actionInFlight} className="reconcileBtn">
              Reconcile...
            </button>
          )}
          {status.reportAvailable && !report && (
            <button onClick={onFetchReport} disabled={actionInFlight}>
              Fetch safe report
            </button>
          )}
          {status.resultAvailable && !privateResult && (
            <button onClick={onFetchResult} disabled={actionInFlight}>
              Retrieve private summary
            </button>
          )}
          <button onClick={onClose} className="closeBtn">Close transaction</button>
          <button onClick={onSignOut} className="closeBtn">Sign out</button>
        </div>
      </section>

      {status.requesterDecision && (
        <RequesterDecisionView decision={status.requesterDecision} offer={offer} />
      )}

      <TrustBoundaryView status={status} />

      {report && <SafeReportView report={report} />}

      {privateResult && <PrivateResultView result={privateResult} />}
    </>
  );
}

function RequesterDecisionView({
  decision,
  offer,
}: {
  decision: NonNullable<TransactionStatus["requesterDecision"]>;
  offer: NonNullable<TransactionStatus["selectedOffer"]>;
}) {
  const checks: Array<{ label: string; passed: boolean }> = [
    { label: "Selected provider matches validated discovery", passed: decision.policy.selectedProviderMatchesDiscovery },
    { label: "Exact signed offer is 350 sats", passed: decision.policy.priceAllowed },
    { label: "Amount is within requester budget", passed: decision.policy.withinRequesterBudget },
    { label: "Cashu settlement is permitted", passed: decision.policy.cashuCompatible },
    { label: "Stable references match", passed: decision.policy.stableReferencesMatch },
    { label: "Execution duration is within policy", passed: decision.policy.executionDurationAllowed },
  ];

  return (
    <section className="section decisionSection" aria-labelledby="decision-heading">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow dark">Machine Money · Requester decision</p>
          <h2 id="decision-heading">Advisory model + deterministic policy</h2>
        </div>
        <p className="sectionNote">
          The model recommends; the deterministic policy authorizes. The model has no signing, Cashu, or settlement capability.
        </p>
      </div>

      <div className="decisionGrid">
        <article className="decisionCard">
          <p className="cardLabel">AI recommendation ({decision.source})</p>
          <strong>{decision.recommendation.providerPublicKey.slice(0, 16)}... / {offer.amountSats} sats</strong>
          <span>Recommended</span>
          <small>Advisory only — no authority to sign, publish, or settle.</small>
        </article>
        <article className="decisionCard">
          <p className="cardLabel">Deterministic policy</p>
          <ul className="policyChecks">
            {checks.map((c) => (
              <li key={c.label}>
                <span className="check" aria-hidden="true">{c.passed ? "✓" : "✗"}</span>
                {c.label}
              </li>
            ))}
          </ul>
          <strong>Decision: {decision.authorized ? "approved" : "rejected"}</strong>
        </article>
      </div>
    </section>
  );
}

function TrustBoundaryView({ status }: { status: TransactionStatus }) {
  return (
    <section className="section trustSection" aria-labelledby="trust-heading">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow dark">Trust boundary</p>
          <h2 id="trust-heading">Public lifecycle vs private payloads</h2>
        </div>
        <p className="sectionNote">
          The runtime exposes safe public references. Private material never enters public events, logs, or this view.
        </p>
      </div>

      <div className="trustGrid">
        <article className="trustCard safe">
          <p className="cardLabel">Safe / public-shaped</p>
          <ul>
            <li><span className="check" aria-hidden="true">✓</span> Provider identity and stable references</li>
            <li><span className="check" aria-hidden="true">✓</span> Signed offer amount ({status.selectedOffer.amountSats} sats)</li>
            <li><span className="check" aria-hidden="true">✓</span> Lifecycle state ({PHASE_LABELS[status.phase]})</li>
            {status.settlementReference && <li><span className="check" aria-hidden="true">✓</span> Settlement reference</li>}
            {status.refundReference && <li><span className="check" aria-hidden="true">✓</span> Refund reference</li>}
            {status.escrowReference && <li><span className="check" aria-hidden="true">✓</span> Opaque escrow reference</li>}
          </ul>
        </article>
        <article className="trustCard private">
          <p className="cardLabel">Private</p>
          <ul>
            <li><span className="lock" aria-hidden="true">🔒</span> Source document</li>
            <li><span className="lock" aria-hidden="true">🔒</span> Requester prompt</li>
            <li><span className="lock" aria-hidden="true">🔒</span> Complete summary</li>
            <li><span className="lock" aria-hidden="true">🔒</span> Cashu proofs and secrets</li>
            <li><span className="lock" aria-hidden="true">🔒</span> Signing and encryption keys</li>
            <li><span className="lock" aria-hidden="true">🔒</span> Terms-commitment salt</li>
          </ul>
        </article>
      </div>
    </section>
  );
}

function SafeReportView({ report }: { report: WorkflowReport }) {
  return (
    <section className="section reportSection" aria-labelledby="report-heading">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow dark">Safe terminal report</p>
          <h2 id="report-heading">Canonical lifecycle</h2>
        </div>
        <p className="sectionNote">
          Allowlisted public data only. No private payloads merged into this report.
        </p>
      </div>

      <ol className="lifecycleList">
        {report.lifecycle.map((step, i) => (
          <li key={step.eventId}>
            <span className="stepNum">{i + 1}</span>
            <strong>{PHASE_LABELS[step.state] ?? step.state}</strong>
            <code>{step.eventId.slice(0, 24)}...</code>
          </li>
        ))}
      </ol>

      <dl className="reportGrid">
        <div><dt>Agreement</dt><dd><code>{report.agreementId.slice(0, 24)}...</code></dd></div>
        <div><dt>Requester</dt><dd><code>{report.requesterPublicKey.slice(0, 20)}...</code></dd></div>
        <div><dt>Provider</dt><dd><code>{report.providerPublicKey.slice(0, 20)}...</code></dd></div>
        <div><dt>Amount</dt><dd>{report.amountSats} {report.unit}</dd></div>
        <div><dt>Outcome</dt><dd>{report.finalOutcome}</dd></div>
        {report.settlementReference && <div><dt>Settlement</dt><dd><code>{report.settlementReference}</code></dd></div>}
        {report.refundReference && <div><dt>Refund</dt><dd><code>{report.refundReference}</code></dd></div>}
      </dl>
    </section>
  );
}

function PrivateResultView({ result }: { result: PrivateResult }) {
  return (
    <section className="section resultSection" aria-labelledby="result-heading">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow dark">Private summary</p>
          <h2 id="result-heading">Complete result</h2>
        </div>
        <p className="sectionNote">
          Retrieved through the authorized private-result endpoint. This content is structurally separate from the safe report and is never placed in URLs, logs, or persisted storage.
        </p>
      </div>
      <div className="resultContent" role="region" aria-label="Private document summary">
        <pre>{result.summary}</pre>
      </div>
    </section>
  );
}
