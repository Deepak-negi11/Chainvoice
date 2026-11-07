// Tracks payment transactions from the moment the wallet returns a hash, so a
// payment that is still pending survives a refresh or navigation and can be
// checked again against the chain it was sent to.
//
// The records are a convenience, never the source of truth: whether an invoice
// is paid is always read from the contract. They are kept in localStorage
// rather than the invoice IndexedDB, which holds invoice payloads and is what
// backups export; a transaction record is per browser, short-lived and small.

import { BrowserProvider } from "ethers";

export const PAYMENT_TX_STORAGE_PREFIX = "chainvoice-payment-txs-v1";

export const TX_STATUS = Object.freeze({
  /**
   * Submitted, and the node still holds it or another transaction with its
   * nonce (a sped-up copy), or it has not been checked yet.
   */
  PENDING: "pending",
  /**
   * Mined and did not revert (or, for a pre-Byzantium receipt, mined with no
   * status), or a sped-up copy of it succeeded.
   */
  CONFIRMED: "confirmed",
  /** Mined and failed. */
  REVERTED: "reverted",
  /** Its nonce was used by another transaction (sped up, cancelled, replaced). */
  REPLACED: "replaced",
  /**
   * The node no longer knows it and has nothing pending with its nonce, which
   * is still unused: dropped, or not yet seen by this node. There is no
   * evidence for either, so neither is claimed.
   */
  UNRESOLVED: "unresolved",
});

export const TX_OPERATION = Object.freeze({
  APPROVE: "approve",
  PAY: "pay",
  PAY_BATCH: "payBatch",
});

const FINAL_STATUSES = new Set([
  TX_STATUS.CONFIRMED,
  TX_STATUS.REVERTED,
  TX_STATUS.REPLACED,
]);
const STATUSES = new Set(Object.values(TX_STATUS));
const OPERATIONS = new Set(Object.values(TX_OPERATION));
const PAYMENT_OPERATIONS = new Set([TX_OPERATION.PAY, TX_OPERATION.PAY_BATCH]);
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Records kept per chain and account. Over the limit, the oldest records that
 * are not pending (finished or unresolved) are dropped first.
 */
export const MAX_PAYMENT_TX_RECORDS = 50;

// Merely touching window.localStorage throws in some privacy modes, so the
// lookup itself is guarded, not just the reads and writes.
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function sameHash(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function toTimestamp(now) {
  return now instanceof Date ? now.getTime() : Number(now);
}

export function isFinalTxStatus(status) {
  return FINAL_STATUSES.has(status);
}

/**
 * One storage entry per chain and account, so records of another wallet or
 * network are never shown or reconciled against the wrong chain.
 */
export function paymentTxStorageKey(chainId, account) {
  return `${PAYMENT_TX_STORAGE_PREFIX}:${Number(chainId)}:${String(account).toLowerCase()}`;
}

function hasScope(chainId, account) {
  return (
    chainId !== undefined &&
    chainId !== null &&
    chainId !== "" &&
    Number.isFinite(Number(chainId)) &&
    typeof account === "string" &&
    account.length > 0
  );
}

function isValidRecord(record) {
  return (
    record !== null &&
    typeof record === "object" &&
    Number.isFinite(record.chainId) &&
    typeof record.account === "string" &&
    typeof record.hash === "string" &&
    TX_HASH_PATTERN.test(record.hash) &&
    STATUSES.has(record.status) &&
    OPERATIONS.has(record.operation) &&
    Array.isArray(record.invoiceIds) &&
    record.invoiceIds.every((id) => typeof id === "string") &&
    (record.contractAddress === undefined || typeof record.contractAddress === "string")
  );
}

/**
 * The records for one chain and account. Anything unreadable, corrupt or
 * malformed is skipped, so a damaged entry can never break the page.
 *
 * @returns {Array<Object>}
 */
export function loadPaymentTxs(chainId, account, storage = defaultStorage()) {
  if (!storage || !hasScope(chainId, account)) return [];
  try {
    const raw = storage.getItem(paymentTxStorageKey(chainId, account));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A record must belong to the entry it is stored under: one that names
    // another chain or account could never be saved back, and would stay
    // pending (blocking its invoices) forever.
    const chain = Number(chainId);
    const owner = account.toLowerCase();
    return parsed.filter(
      (record) =>
        isValidRecord(record) && record.chainId === chain && record.account === owner
    );
  } catch {
    return [];
  }
}

function saveRecords(chainId, account, records, storage) {
  storage.setItem(paymentTxStorageKey(chainId, account), JSON.stringify(records));
}

/** Drops the oldest non-pending records until the list fits. */
function prune(records) {
  if (records.length <= MAX_PAYMENT_TX_RECORDS) return records;
  const removable = records
    .filter((record) => record.status !== TX_STATUS.PENDING)
    .sort((a, b) => a.submittedAt - b.submittedAt);
  const excess = records.length - MAX_PAYMENT_TX_RECORDS;
  const drop = new Set(removable.slice(0, excess).map((record) => record.hash));
  return records.filter((record) => !drop.has(record.hash));
}

/**
 * Persist a transaction as soon as the wallet returns it. Call it before
 * waiting on the transaction, so a refresh during the wait loses nothing.
 *
 * Returns false, without throwing, when there is no hash (a wallet rejection
 * never produces one) or storage is unavailable: tracking must never stop the
 * payment itself.
 *
 * @param {Object} params
 * @param {number|string} params.chainId - chain the transaction was sent on
 * @param {string} params.account - sending wallet
 * @param {{hash: string, nonce?: number}} params.tx - the wallet's response
 * @param {string} params.operation - one of TX_OPERATION
 * @param {Array<bigint|number|string>} params.invoiceIds - invoices it settles
 * @param {string} [params.tokenAddress]
 * @param {string} [params.contractAddress] - the Chainvoice contract it pays;
 *   invoice ids are only meaningful together with it
 */
export function recordSubmittedTx(
  { chainId, account, tx, operation, invoiceIds = [], tokenAddress, contractAddress },
  storage = defaultStorage(),
  now = new Date()
) {
  if (!storage || !hasScope(chainId, account)) return false;
  if (typeof tx?.hash !== "string" || !TX_HASH_PATTERN.test(tx.hash)) return false;
  if (!OPERATIONS.has(operation)) return false;

  const record = {
    // Lower-cased: ethers lower-cases the hashes it returns, but a wallet may
    // not, and the same transaction must not become two records.
    hash: tx.hash.toLowerCase(),
    chainId: Number(chainId),
    account: account.toLowerCase(),
    nonce: Number.isInteger(tx.nonce) ? tx.nonce : undefined,
    operation,
    invoiceIds: invoiceIds.map((id) => String(id)),
    tokenAddress,
    contractAddress: ADDRESS_PATTERN.test(contractAddress ?? "")
      ? contractAddress.toLowerCase()
      : undefined,
    status: TX_STATUS.PENDING,
    submittedAt: toTimestamp(now),
  };

  try {
    const records = loadPaymentTxs(chainId, account, storage);
    const existing = records.find((stored) => sameHash(stored.hash, record.hash));
    if (existing) {
      // Recorded already when the wallet returned the hash (sendTrackedTx);
      // the full transaction only adds its nonce. Status and submission time
      // stay as they are, so a settled record is not reopened.
      if (existing.nonce === undefined && record.nonce !== undefined) {
        existing.nonce = record.nonce;
        saveRecords(chainId, account, records, storage);
      }
      return true;
    }
    saveRecords(chainId, account, prune([...records, record]), storage);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge `patch` into the record with `hash`. The fields that identify a
 * record (hash, chain, account) cannot be changed. Returns whether a record
 * was updated.
 */
export function updatePaymentTx(chainId, account, hash, patch, storage = defaultStorage()) {
  if (!storage || !hasScope(chainId, account)) return false;
  try {
    const records = loadPaymentTxs(chainId, account, storage);
    const index = records.findIndex((record) => sameHash(record.hash, hash));
    if (index === -1) return false;
    const current = records[index];
    records[index] = {
      ...current,
      ...patch,
      hash: current.hash,
      chainId: current.chainId,
      account: current.account,
    };
    saveRecords(chainId, account, records, storage);
    return true;
  } catch {
    return false;
  }
}

/** Forget one record, e.g. when the user dismisses a finished payment. */
export function removePaymentTx(chainId, account, hash, storage = defaultStorage()) {
  if (!storage || !hasScope(chainId, account)) return false;
  try {
    const records = loadPaymentTxs(chainId, account, storage);
    const remaining = records.filter((record) => !sameHash(record.hash, hash));
    if (remaining.length === records.length) return false;
    saveRecords(chainId, account, remaining, storage);
    return true;
  } catch {
    return false;
  }
}

/**
 * Store the result of reconcilePaymentTx, unless the stored record was settled
 * or removed while the chain was being read. Reconciliation can overlap a
 * payment's own wait(), and a stale "pending" read must not undo the receipt
 * that wait() stored, nor bring back a record the user dismissed.
 */
export function saveReconciledTx(record, storage = defaultStorage()) {
  const stored = loadPaymentTxs(record.chainId, record.account, storage).find(
    (existing) => sameHash(existing.hash, record.hash)
  );
  if (!stored || isFinalTxStatus(stored.status)) return false;
  return updatePaymentTx(record.chainId, record.account, record.hash, record, storage);
}

/** Link to the transaction on the chain's configured block explorer, or null. */
export function txExplorerUrl(chain, hash) {
  const base = chain?.blockExplorers?.default?.url;
  if (typeof base !== "string" || !base) return null;
  return `${base.replace(/\/+$/, "")}/tx/${hash}`;
}

/**
 * The fields a receipt establishes, or null without one. A receipt means the
 * transaction was mined, so its outcome is final: reverted when its status is
 * 0, confirmed otherwise (a pre-Byzantium receipt has no status; the invoice
 * table still reads paid status from the contract).
 */
function receiptPatch(receipt, checkedAt) {
  if (!receipt) return null;
  return {
    status: receipt.status === 0 ? TX_STATUS.REVERTED : TX_STATUS.CONFIRMED,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    checkedAt,
  };
}

/**
 * Check a record against the chain and return the updated record.
 *
 * `provider` must read the chain the transaction was sent on (an ethers
 * provider pinned to that chain, see createRecordChainProvider, or anything
 * with getTransactionReceipt, getTransaction and getTransactionCount). Only
 * evidence changes the status:
 *   - a receipt decides confirmed or reverted;
 *   - a transaction the node still holds stays pending;
 *   - with neither, a confirmed nonce past ours means another transaction
 *     took the nonce (replaced); a pending nonce past ours means one with our
 *     nonce is still in the mempool (pending); otherwise unresolved.
 * A failed read keeps the previous status, so an RPC outage never reads as a
 * revert or a drop. Final records are returned untouched.
 */
export async function reconcilePaymentTx(record, provider, now = new Date()) {
  if (isFinalTxStatus(record.status)) return record;
  const checkedAt = toTimestamp(now);
  // Every answer that is not "replaced" clears a replaced suspicion.
  const settle = (fields) => ({
    ...record,
    ...fields,
    checkedAt,
    replacedSuspectedAt: undefined,
    lastError: undefined,
  });

  try {
    const receipt = await provider.getTransactionReceipt(record.hash);
    if (receipt) return settle(receiptPatch(receipt, checkedAt));

    const tx = await provider.getTransaction(record.hash);
    if (tx) {
      // A record saved when the wallet returned only the hash (sendTrackedTx)
      // learns its nonce here; later checks need it once the hash is gone.
      const nonce = Number.isInteger(record.nonce)
        ? record.nonce
        : Number.isInteger(tx.nonce)
          ? tx.nonce
          : undefined;
      return settle({ nonce, status: TX_STATUS.PENDING });
    }

    if (Number.isInteger(record.nonce)) {
      const confirmedNonce = await provider.getTransactionCount(record.account, "latest");
      if (Number(confirmedNonce) > record.nonce) {
        // Our own transaction may have been mined between the first read and
        // this one, which also moves the nonce on; only a still-missing
        // receipt means another transaction used it.
        const lateReceipt = await provider.getTransactionReceipt(record.hash);
        const patch = receiptPatch(lateReceipt, checkedAt);
        if (patch) return settle(patch);
        // "Replaced" is final, and the reads above may come from backends that
        // lag each other (a receipt index behind the nonce). So the first time
        // it stays pending and is checked again; only a second check that
        // agrees settles it.
        if (record.replacedSuspectedAt) return settle({ status: TX_STATUS.REPLACED });
        return {
          ...settle({ status: TX_STATUS.PENDING }),
          replacedSuspectedAt: checkedAt,
        };
      }
      // Nothing with our nonce is mined yet. A pending count past it means a
      // transaction with our nonce is in the mempool (a sped-up copy of ours,
      // or any other transaction on that nonce), so a second payment could
      // still collide with it.
      const pendingNonce = await provider.getTransactionCount(record.account, "pending");
      if (Number(pendingNonce) > record.nonce) {
        return settle({ status: TX_STATUS.PENDING });
      }
    }

    return settle({ status: TX_STATUS.UNRESOLVED });
  } catch (error) {
    return { ...record, checkedAt, lastError: error?.message || String(error) };
  }
}

/**
 * Whether `error` is ethers reporting that the wallet sped the transaction up
 * (same call, higher fee) and the faster copy was mined and succeeded. ethers
 * rejects wait() with TRANSACTION_REPLACED in that case too, although the
 * call went through; its `receipt` is the faster copy's.
 */
export function isSuccessfulSpeedUp(error) {
  return (
    error?.code === "TRANSACTION_REPLACED" &&
    error.reason === "repriced" &&
    error.receipt?.status === 1
  );
}

/**
 * Record `tx`, wait for it, and store the outcome. Resolves and rejects
 * exactly as `tx.wait()` does, so it can replace that call directly.
 *
 * A failure that carries no evidence (e.g. the RPC dropped mid-wait) leaves
 * the record pending for reconciliation to settle later. When the record
 * cannot be saved, `context.onNotRecorded` is called so the user can be told
 * that a refresh will lose track of this transaction; the wait goes on.
 *
 * @param {{hash: string, nonce?: number, wait: Function}} tx
 * @param {Object} context - chainId, account, operation, invoiceIds,
 *   tokenAddress, contractAddress, and optionally onNotRecorded()
 */
export async function waitForTrackedTx(tx, context, storage = defaultStorage(), now = new Date()) {
  const { chainId, account, onNotRecorded } = context;
  if (!recordSubmittedTx({ ...context, tx }, storage, now)) onNotRecorded?.();

  try {
    const receipt = await tx.wait();
    const patch = receiptPatch(receipt, Date.now());
    if (patch) updatePaymentTx(chainId, account, tx.hash, patch, storage);
    return receipt;
  } catch (error) {
    if (error?.code === "TRANSACTION_REPLACED") {
      // The receipt on this error is the replacement's, not ours, so no block
      // is copied. A sped-up copy that succeeded did make the payment.
      updatePaymentTx(
        chainId,
        account,
        tx.hash,
        {
          status: isSuccessfulSpeedUp(error) ? TX_STATUS.CONFIRMED : TX_STATUS.REPLACED,
          replacementHash: error.replacement?.hash,
          replacementReason: error.reason,
          checkedAt: Date.now(),
        },
        storage
      );
    } else {
      const patch = receiptPatch(error?.receipt, Date.now());
      if (patch) updatePaymentTx(chainId, account, tx.hash, patch, storage);
    }
    throw error;
  }
}

/**
 * The pending payment (single or batch) to `contractAddress` that covers
 * `invoiceId`, if any. Approvals and finished or unresolved payments do not
 * count: only a payment the node still holds would make a second one a
 * duplicate. Invoice ids restart at 0 on a redeployed contract, so a payment
 * to another contract on the same chain never matches.
 */
export function findPendingPaymentTx(records, invoiceId, contractAddress) {
  if (!Array.isArray(records)) return undefined;
  if (typeof contractAddress !== "string" || !contractAddress) return undefined;
  const id = String(invoiceId);
  const contract = contractAddress.toLowerCase();
  return records.find(
    (record) =>
      record.status === TX_STATUS.PENDING &&
      PAYMENT_OPERATIONS.has(record.operation) &&
      record.contractAddress === contract &&
      record.invoiceIds.includes(id)
  );
}

/**
 * waitForTrackedTx for a payment or approval: a sped-up copy that succeeded
 * resolves with its receipt instead of rejecting, because the call did go
 * through. A cancel, a different transaction or a revert still rejects.
 */
export async function waitForPaymentTx(tx, context, storage = defaultStorage(), now = new Date()) {
  try {
    return await waitForTrackedTx(tx, context, storage, now);
  } catch (error) {
    if (isSuccessfulSpeedUp(error)) return error.receipt;
    throw error;
  }
}

/**
 * Reconcile every open record of one chain and account, one at a time, and
 * save each result (see saveReconciledTx). Returns null if `isCancelled()`
 * turns true mid-way, e.g. the user switched wallet or network; otherwise
 * whether any record reached a final status (`settled`) and whether any is
 * still pending (`stillOpen`), so the caller knows to refetch and to poll again.
 */
export async function reconcileOpenPaymentTxs(
  chainId,
  account,
  provider,
  storage = defaultStorage(),
  now = new Date(),
  isCancelled = () => false
) {
  const open = loadPaymentTxs(chainId, account, storage).filter(
    (record) => !isFinalTxStatus(record.status)
  );
  let settled = false;
  let stillOpen = false;
  for (const record of open) {
    const next = await reconcilePaymentTx(record, provider, now);
    if (isCancelled()) return null;
    // Not saved: settled or dismissed meanwhile, so nothing left to watch.
    if (!saveReconciledTx(next, storage)) continue;
    if (isFinalTxStatus(next.status)) settled = true;
    // Only a pending record keeps the poll going; an unresolved one is checked
    // again on the next load or refresh instead of every few seconds forever.
    else if (next.status === TX_STATUS.PENDING) stillOpen = true;
  }
  return { settled, stillOpen };
}

/**
 * The records worth showing for the configured contract: everything not
 * confirmed (a confirmed payment shows as paid in the table, read from the
 * contract), newest first.
 */
export function getVisiblePaymentTxs(records, contractAddress) {
  if (!Array.isArray(records)) return [];
  if (typeof contractAddress !== "string" || !contractAddress) return [];
  const contract = contractAddress.toLowerCase();
  return records
    .filter(
      (record) =>
        record.status !== TX_STATUS.CONFIRMED && record.contractAddress === contract
    )
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

/**
 * A provider for reconciling records of `chainId`, reading through the
 * wallet's EIP-1193 provider. Pinned to that chain: the wallet can switch
 * networks before the app hears of it, and an unpinned provider would then
 * read the other chain, where a higher nonce would wrongly mark our
 * transaction replaced. Pinned, such reads fail with "network changed" and
 * leave the record as it was.
 *
 * ethers' 250ms cache of identical requests is turned off: reconciliation
 * re-reads a receipt right after a nonce read to catch a transaction mined in
 * between, and a cached answer would turn that payment into "replaced".
 */
export function createRecordChainProvider(eip1193Provider, chainId) {
  return new BrowserProvider(eip1193Provider, Number(chainId), { cacheTimeout: -1 });
}

// Signers with a sendTrackedTx in progress; see the overlap check there.
const trackingSigners = new WeakSet();

/**
 * Run `send` (a call such as `() => contract.payInvoice(id, overrides)`) and
 * record its transaction the moment the wallet returns the hash.
 *
 * ethers' JsonRpcSigner.sendTransaction gets the hash from the wallet, then
 * polls the node until it can return the full transaction. A refresh during
 * that poll would lose the hash, and if the poll fails ethers rejects although
 * the transaction was broadcast. So the signer's sendUncheckedTransaction,
 * which returns the hash, is wrapped for the duration of `send` only.
 * Resolves and rejects exactly as `send` does.
 *
 * One tracked send at a time per signer: an overlapping one would record its
 * hash under the other send's invoices, so it is refused with an error.
 * Sends one after another on the same signer are fine.
 *
 * @param {Object} signer - the ethers signer the contract was built with
 * @param {Object} context - as for recordSubmittedTx, plus onNotRecorded()
 * @param {() => Promise<Object>} send
 */
export async function sendTrackedTx(signer, context, send, storage = defaultStorage(), now = new Date()) {
  if (trackingSigners.has(signer)) {
    throw new Error("sendTrackedTx: this signer is already sending a tracked transaction");
  }
  trackingSigners.add(signer);
  const ownMethod = Object.prototype.hasOwnProperty.call(signer, "sendUncheckedTransaction");
  const original = signer.sendUncheckedTransaction;
  signer.sendUncheckedTransaction = async function (...args) {
    const hash = await original.apply(this, args);
    if (!recordSubmittedTx({ ...context, tx: { hash } }, storage, now)) {
      context.onNotRecorded?.();
    }
    return hash;
  };
  try {
    return await send();
  } finally {
    if (ownMethod) signer.sendUncheckedTransaction = original;
    else delete signer.sendUncheckedTransaction;
    trackingSigners.delete(signer);
  }
}

/**
 * Wraps `show` so it runs only on the first call: a payment can have several
 * steps that each fail to be saved, and the user needs to hear it once.
 */
export function createWarnOnce(show) {
  let warned = false;
  return (...args) => {
    if (warned) return;
    warned = true;
    show(...args);
  };
}
