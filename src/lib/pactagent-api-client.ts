export interface RuntimeBootstrap {
  readonly mintUrl: string;
  readonly unit: "sat";
  readonly ready: true;
}

export interface SelectedOffer {
  readonly providerPublicKey: string;
  readonly providerDefinitionReference: string;
  readonly offerReference: string;
  readonly escrowDescriptorReference: string;
  readonly amountSats: string;
  readonly unit: "sat";
}

export interface RequesterDecisionProjection {
  readonly source: "deterministic" | "model";
  readonly recommendation: Readonly<{
    action: "recommend";
    providerPublicKey: string;
    offerReference: string;
    amountSats: string;
  }>;
  readonly policy: Readonly<{
    selectedProviderMatchesDiscovery: true;
    stableReferencesMatch: true;
    withinRequesterBudget: true;
    cashuCompatible: true;
    priceAllowed: true;
    executionDurationAllowed: true;
  }>;
  readonly authorized: true;
}

export type RuntimePhase =
  | "initialized"
  | "proposed"
  | "accepted"
  | "escrow_funded"
  | "task_delivered"
  | "result_submitted"
  | "result_verified"
  | "release_authorized"
  | "settled"
  | "refund_authorized"
  | "refunded";

export type OperationalState =
  | "active"
  | "failed"
  | "reconciliation_required"
  | "resolved_not_funded"
  | "refunded"
  | "settled";

export type ReconciliationState =
  | "funding_reconciliation_required"
  | "release_reconciliation_required"
  | "refund_reconciliation_required";

export interface TransactionStatus {
  readonly transactionId: string;
  readonly kind: "successful" | "refund";
  readonly phase: RuntimePhase;
  readonly operationalState: OperationalState;
  readonly agreementId: string;
  readonly selectedOffer: SelectedOffer;
  readonly requesterDecision?: RequesterDecisionProjection;
  readonly availableActions: Readonly<{ resume: boolean; reconcile: boolean }>;
  readonly resultAvailable: boolean;
  readonly reportAvailable: boolean;
  readonly failureCode?: "transaction_failed";
  readonly agreementRootEventId?: string;
  readonly finalOutcome?: "settled" | "refunded";
  readonly resultReference?: string;
  readonly escrowReference?: string;
  readonly settlementReference?: string;
  readonly refundReference?: string;
  readonly reconciliationRequired?: true;
  readonly reconciliationState?: ReconciliationState;
}

export interface WorkflowReport {
  readonly workflowVersion: 1;
  readonly agreementId: string;
  readonly agreementRootEventId: string;
  readonly requesterPublicKey: string;
  readonly providerPublicKey: string;
  readonly escrowAuthorityPublicKey: string;
  readonly selectedReferences: {
    readonly providerPublicKey: string;
    readonly providerDefinitionReference: string;
    readonly offerReference: string;
    readonly escrowDescriptorReference: string;
  };
  readonly amountSats: string;
  readonly unit: "sat";
  readonly lifecycle: ReadonlyArray<{
    readonly state: RuntimePhase;
    readonly eventId: string;
  }>;
  readonly escrowReference: string;
  readonly resultReference?: string;
  readonly settlementReference?: string;
  readonly refundReference?: string;
  readonly finalOutcome: "settled" | "refunded";
}

export interface PrivateResult {
  readonly summary: string;
}

export interface ApiError {
  readonly error: string;
  readonly code: string;
}

export class PactAgentApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "PactAgentApiClientError";
    this.code = code;
    this.status = status;
  }
}

function authHeaders(apiToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) {
    const error = body as ApiError;
    throw new PactAgentApiClientError(
      error.code ?? "http_error",
      error.error ?? `HTTP ${response.status}`,
      response.status,
    );
  }
  return body as T;
}

export class PactAgentApiClient {
  readonly #baseURL: string;
  readonly #apiToken: string;

  constructor(apiToken: string, baseURL?: string) {
    this.#apiToken = apiToken;
    this.#baseURL = baseURL ?? "";
  }

  async bootstrap(): Promise<RuntimeBootstrap> {
    const response = await fetch(`${this.#baseURL}/api/runtime/bootstrap`, {
      method: "POST",
      headers: authHeaders(this.#apiToken),
      cache: "no-store",
    });
    return parseResponse<RuntimeBootstrap>(response);
  }

  async startTransaction(input: {
    readonly idempotencyKey: string;
    readonly fundingReference: string;
    readonly privateDocument: string;
    readonly mediaType: "text/plain" | "application/pdf";
    readonly privatePrompt?: string;
    readonly maximumBudgetSats: string;
  }): Promise<{ transactionId: string }> {
    const response = await fetch(`${this.#baseURL}/api/transactions`, {
      method: "POST",
      headers: {
        ...authHeaders(this.#apiToken),
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        privateDocument: input.privateDocument,
        mediaType: input.mediaType,
        ...(input.privatePrompt ? { privatePrompt: input.privatePrompt } : {}),
        maximumBudgetSats: input.maximumBudgetSats,
        fundingReference: input.fundingReference,
      }),
      cache: "no-store",
    });
    return parseResponse<{ transactionId: string }>(response);
  }

  async getStatus(transactionId: string): Promise<TransactionStatus> {
    const response = await fetch(`${this.#baseURL}/api/transactions/${transactionId}`, {
      method: "GET",
      headers: authHeaders(this.#apiToken),
      cache: "no-store",
    });
    return parseResponse<TransactionStatus>(response);
  }

  async getReport(transactionId: string): Promise<WorkflowReport> {
    const response = await fetch(`${this.#baseURL}/api/transactions/${transactionId}/report`, {
      method: "GET",
      headers: authHeaders(this.#apiToken),
      cache: "no-store",
    });
    return parseResponse<WorkflowReport>(response);
  }

  async getPrivateResult(transactionId: string): Promise<PrivateResult> {
    const response = await fetch(`${this.#baseURL}/api/transactions/${transactionId}/result`, {
      method: "GET",
      headers: authHeaders(this.#apiToken),
      cache: "no-store",
    });
    return parseResponse<PrivateResult>(response);
  }

  async resume(transactionId: string): Promise<WorkflowReport> {
    const response = await fetch(`${this.#baseURL}/api/transactions/${transactionId}/resume`, {
      method: "POST",
      headers: authHeaders(this.#apiToken),
      cache: "no-store",
    });
    return parseResponse<WorkflowReport>(response);
  }

  async reconcile(transactionId: string): Promise<WorkflowReport | TransactionStatus> {
    const response = await fetch(`${this.#baseURL}/api/transactions/${transactionId}/reconcile`, {
      method: "POST",
      headers: authHeaders(this.#apiToken),
      cache: "no-store",
    });
    return parseResponse<WorkflowReport | TransactionStatus>(response);
  }
}

const STORAGE_KEY = "pactagent:txn";

export function retainTransactionId(transactionId: string): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  window.sessionStorage.setItem(STORAGE_KEY, transactionId);
}

export function loadRetainedTransactionId(): string | undefined {
  if (typeof window === "undefined" || !window.sessionStorage) return undefined;
  const value = window.sessionStorage.getItem(STORAGE_KEY);
  return value ?? undefined;
}

export function clearRetainedTransactionId(): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function generateIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
