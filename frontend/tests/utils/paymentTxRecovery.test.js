import { BrowserProvider, Contract } from "ethers";
import {
  MAX_PAYMENT_TX_RECORDS,
  PAYMENT_TX_STORAGE_PREFIX,
  TX_OPERATION,
  TX_STATUS,
  findPendingPaymentTx,
  getVisiblePaymentTxs,
  isFinalTxStatus,
  isSuccessfulSpeedUp,
  loadPaymentTxs,
  paymentTxStorageKey,
  reconcileOpenPaymentTxs,
  reconcilePaymentTx,
  recordSubmittedTx,
  removePaymentTx,
  saveReconciledTx,
  sendTrackedTx,
  createRecordChainProvider,
  createWarnOnce,
  txExplorerUrl,
  updatePaymentTx,
  waitForPaymentTx,
  waitForTrackedTx,
} from "../../src/utils/paymentTxRecovery.js";

const ACCOUNT = "0xAbCdEf0000000000000000000000000000000001";
const OTHER_ACCOUNT = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const CONTRACT = "0x6E5Ac5C2c10b4eD34909CFf0DF776832504E9677";
const OLD_CONTRACT = "0x54a542dCDC306eE281b5De4613EcEfe6e6ABc562";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const NOW = new Date("2026-11-07T10:00:00Z");

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data,
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

function submit(storage, overrides = {}) {
  return recordSubmittedTx(
    {
      chainId: 11155111,
      account: ACCOUNT,
      tx: { hash: HASH_A, nonce: 7 },
      operation: TX_OPERATION.PAY,
      invoiceIds: [5n],
      tokenAddress: TOKEN,
      contractAddress: CONTRACT,
      ...overrides,
    },
    storage,
    NOW
  );
}

/**
 * A provider stub answering the three reads reconciliation makes. Each
 * argument is either a value or a function, so a test can change the answer
 * between calls or make one throw.
 */
function createProvider({ receipt = null, tx = null, nonce = 0 } = {}) {
  const answer = (value) => (typeof value === "function" ? value() : value);
  const calls = [];
  return {
    calls,
    getTransactionReceipt: async (hash) => {
      calls.push(["getTransactionReceipt", hash]);
      return answer(receipt);
    },
    getTransaction: async (hash) => {
      calls.push(["getTransaction", hash]);
      return answer(tx);
    },
    getTransactionCount: async (address, blockTag) => {
      calls.push(["getTransactionCount", address, blockTag]);
      return typeof nonce === "function" ? nonce(blockTag) : nonce;
    },
  };
}

function pendingRecord(overrides = {}) {
  return {
    hash: HASH_A,
    chainId: 11155111,
    account: ACCOUNT.toLowerCase(),
    nonce: 7,
    operation: TX_OPERATION.PAY,
    invoiceIds: ["5"],
    tokenAddress: TOKEN,
    contractAddress: CONTRACT.toLowerCase(),
    status: TX_STATUS.PENDING,
    submittedAt: NOW.getTime(),
    ...overrides,
  };
}

describe("paymentTxStorageKey", () => {
  test("scopes records to one chain and one lowercased account", () => {
    expect(paymentTxStorageKey(137, ACCOUNT)).toBe(
      `${PAYMENT_TX_STORAGE_PREFIX}:137:${ACCOUNT.toLowerCase()}`
    );
    expect(paymentTxStorageKey("137", ACCOUNT.toLowerCase())).toBe(
      paymentTxStorageKey(137, ACCOUNT)
    );
  });
});

describe("recordSubmittedTx", () => {
  test("persists the hash, nonce, chain, account, invoices and operation", () => {
    const storage = createStorage();

    expect(submit(storage)).toBe(true);

    expect(loadPaymentTxs(11155111, ACCOUNT, storage)).toEqual([
      {
        hash: HASH_A,
        chainId: 11155111,
        account: ACCOUNT.toLowerCase(),
        nonce: 7,
        operation: TX_OPERATION.PAY,
        invoiceIds: ["5"],
        tokenAddress: TOKEN,
        contractAddress: CONTRACT.toLowerCase(),
        status: TX_STATUS.PENDING,
        submittedAt: NOW.getTime(),
      },
    ]);
  });

  test("keeps records of other chains and accounts apart", () => {
    const storage = createStorage();
    submit(storage);

    expect(loadPaymentTxs(137, ACCOUNT, storage)).toEqual([]);
    expect(loadPaymentTxs(11155111, OTHER_ACCOUNT, storage)).toEqual([]);
  });

  test("records a batch payment once, with every invoice it covers", () => {
    const storage = createStorage();
    submit(storage, {
      operation: TX_OPERATION.PAY_BATCH,
      invoiceIds: [1n, 2n, 10n],
    });

    const [record] = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(record.operation).toBe(TX_OPERATION.PAY_BATCH);
    expect(record.invoiceIds).toEqual(["1", "2", "10"]);
  });

  test("does not duplicate a hash that is recorded twice", () => {
    const storage = createStorage();
    submit(storage);
    submit(storage);

    expect(loadPaymentTxs(11155111, ACCOUNT, storage)).toHaveLength(1);
  });

  test("records nothing without a transaction hash", () => {
    // A wallet rejection never returns a transaction, so there is no hash to
    // track and none must be invented.
    const storage = createStorage();

    expect(submit(storage, { tx: undefined })).toBe(false);
    expect(submit(storage, { tx: { hash: "" } })).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  test("returns false instead of throwing when storage fails", () => {
    expect(submit(throwingStorage)).toBe(false);
    expect(submit(null)).toBe(false);
  });

  test("drops the oldest finished records first when the list is full", () => {
    const storage = createStorage();
    for (let i = 0; i < 60; i += 1) {
      const hash = `0x${i.toString(16).padStart(64, "0")}`;
      recordSubmittedTx(
        {
          chainId: 1,
          account: ACCOUNT,
          tx: { hash, nonce: i },
          operation: TX_OPERATION.PAY,
          invoiceIds: [i],
        },
        storage,
        new Date(NOW.getTime() + i)
      );
      // Every record but the first stays pending, so the first is the only
      // one that may be pruned however full the list gets.
      if (i > 0) {
        updatePaymentTx(1, ACCOUNT, hash, { status: TX_STATUS.CONFIRMED }, storage);
      }
    }

    const records = loadPaymentTxs(1, ACCOUNT, storage);
    expect(records.length).toBeLessThanOrEqual(50);
    expect(records.some((r) => r.nonce === 0)).toBe(true);
    expect(records.some((r) => r.nonce === 59)).toBe(true);
    expect(records.some((r) => r.nonce === 1)).toBe(false);
  });
});

describe("loadPaymentTxs", () => {
  test("returns an empty list for unreadable or corrupt storage", () => {
    const key = paymentTxStorageKey(1, ACCOUNT);

    expect(loadPaymentTxs(1, ACCOUNT, throwingStorage)).toEqual([]);
    expect(loadPaymentTxs(1, ACCOUNT, null)).toEqual([]);
    expect(loadPaymentTxs(1, ACCOUNT, createStorage({ [key]: "{not json" }))).toEqual([]);
    expect(loadPaymentTxs(1, ACCOUNT, createStorage({ [key]: '{"a":1}' }))).toEqual([]);
  });

  test("skips malformed entries but keeps the valid ones", () => {
    const key = paymentTxStorageKey(1, ACCOUNT);
    const valid = pendingRecord({ chainId: 1 });
    const storage = createStorage({
      [key]: JSON.stringify([
        null,
        { hash: 42 },
        { ...valid, hash: HASH_B, status: "teleported" },
        valid,
      ]),
    });

    expect(loadPaymentTxs(1, ACCOUNT, storage)).toEqual([valid]);
  });

  test("returns nothing without a chain or an account", () => {
    const storage = createStorage();
    submit(storage);

    expect(loadPaymentTxs(undefined, ACCOUNT, storage)).toEqual([]);
    expect(loadPaymentTxs(11155111, undefined, storage)).toEqual([]);
  });
});

describe("updatePaymentTx and removePaymentTx", () => {
  test("patch one record by hash and leave the others alone", () => {
    const storage = createStorage();
    submit(storage);
    submit(storage, { tx: { hash: HASH_B, nonce: 8 } });

    updatePaymentTx(11155111, ACCOUNT, HASH_A, { status: TX_STATUS.REVERTED }, storage);
    let records = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(records.find((r) => r.hash === HASH_A).status).toBe(TX_STATUS.REVERTED);
    expect(records.find((r) => r.hash === HASH_B).status).toBe(TX_STATUS.PENDING);

    removePaymentTx(11155111, ACCOUNT, HASH_A, storage);
    records = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(records.map((r) => r.hash)).toEqual([HASH_B]);
  });

  test("ignore an unknown hash", () => {
    const storage = createStorage();
    submit(storage);

    expect(
      updatePaymentTx(11155111, ACCOUNT, HASH_B, { status: TX_STATUS.CONFIRMED }, storage)
    ).toBe(false);
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.PENDING);
  });

  test("never let a patch move a record to another hash, chain or account", () => {
    const storage = createStorage();
    submit(storage);

    updatePaymentTx(
      11155111,
      ACCOUNT,
      HASH_A,
      { hash: HASH_B, chainId: 1, account: OTHER_ACCOUNT, status: TX_STATUS.CONFIRMED },
      storage
    );

    const [record] = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(record).toMatchObject({
      hash: HASH_A,
      chainId: 11155111,
      account: ACCOUNT.toLowerCase(),
      status: TX_STATUS.CONFIRMED,
    });
  });
});

describe("isFinalTxStatus", () => {
  test("treats confirmed, reverted and replaced as final", () => {
    expect(isFinalTxStatus(TX_STATUS.CONFIRMED)).toBe(true);
    expect(isFinalTxStatus(TX_STATUS.REVERTED)).toBe(true);
    expect(isFinalTxStatus(TX_STATUS.REPLACED)).toBe(true);
    expect(isFinalTxStatus(TX_STATUS.PENDING)).toBe(false);
    expect(isFinalTxStatus(TX_STATUS.UNRESOLVED)).toBe(false);
  });
});

describe("reconcilePaymentTx", () => {
  test("marks a mined, successful transaction confirmed with its block", async () => {
    const provider = createProvider({
      receipt: { status: 1, blockNumber: 123, blockHash: HASH_B },
    });

    const result = await reconcilePaymentTx(pendingRecord(), provider, NOW);

    expect(result).toMatchObject({
      status: TX_STATUS.CONFIRMED,
      blockNumber: 123,
      blockHash: HASH_B,
      checkedAt: NOW.getTime(),
    });
  });

  test("marks a mined, failed transaction reverted", async () => {
    const provider = createProvider({
      receipt: { status: 0, blockNumber: 9, blockHash: HASH_B },
    });

    const result = await reconcilePaymentTx(pendingRecord(), provider, NOW);

    expect(result.status).toBe(TX_STATUS.REVERTED);
  });

  test("keeps a transaction the node still holds pending", async () => {
    const provider = createProvider({ tx: { hash: HASH_A } });

    const result = await reconcilePaymentTx(
      pendingRecord({ status: TX_STATUS.UNRESOLVED }),
      provider,
      NOW
    );

    expect(result.status).toBe(TX_STATUS.PENDING);
  });

  test("marks it replaced when its nonce was used by another transaction", async () => {
    // Confirmed nonce 8 means nonces 0..7 are all mined, ours (7) included,
    // yet the node has no receipt for our hash: another transaction took it.
    const provider = createProvider({ nonce: 8 });

    // The first sighting stays pending (it could be a lagging backend); a
    // second check that agrees settles it as replaced.
    const first = await reconcilePaymentTx(pendingRecord(), provider, NOW);
    expect(first.status).toBe(TX_STATUS.PENDING);
    const result = await reconcilePaymentTx(first, provider, NOW);

    expect(result.status).toBe(TX_STATUS.REPLACED);
    expect(provider.calls).toContainEqual([
      "getTransactionCount",
      ACCOUNT.toLowerCase(),
      "latest",
    ]);
  });

  test("does not call it replaced when it was mined between two reads", async () => {
    let receiptReads = 0;
    const provider = createProvider({
      receipt: () => {
        receiptReads += 1;
        return receiptReads === 1 ? null : { status: 1, blockNumber: 50, blockHash: HASH_B };
      },
      nonce: 8,
    });

    const result = await reconcilePaymentTx(pendingRecord(), provider, NOW);

    expect(result.status).toBe(TX_STATUS.CONFIRMED);
    expect(result.blockNumber).toBe(50);
  });

  test("leaves it unresolved when the node lost it but its nonce is unused", async () => {
    // Could be dropped, or not yet seen by this node: not enough evidence to
    // call it either, so the user is told the outcome is unknown.
    const provider = createProvider({ nonce: 7 });

    const result = await reconcilePaymentTx(pendingRecord(), provider, NOW);

    expect(result.status).toBe(TX_STATUS.UNRESOLVED);
  });

  test("leaves it unresolved without a stored nonce to compare", async () => {
    const provider = createProvider({ nonce: 100 });

    const result = await reconcilePaymentTx(pendingRecord({ nonce: undefined }), provider, NOW);

    expect(result.status).toBe(TX_STATUS.UNRESOLVED);
  });

  test("keeps the previous status when an RPC read fails", async () => {
    const provider = createProvider({
      receipt: () => {
        throw new Error("could not detect network");
      },
    });

    const result = await reconcilePaymentTx(pendingRecord(), provider, NOW);

    expect(result.status).toBe(TX_STATUS.PENDING);
    expect(result.lastError).toBe("could not detect network");
    expect(result.checkedAt).toBe(NOW.getTime());
  });

  test("does not touch a record whose outcome is already final", async () => {
    const provider = createProvider({ nonce: 100 });
    const record = pendingRecord({ status: TX_STATUS.CONFIRMED, blockNumber: 1 });

    const result = await reconcilePaymentTx(record, provider, NOW);

    expect(result).toBe(record);
    expect(provider.calls).toEqual([]);
  });

  test("treats a mined receipt without a 0/1 status as confirmed, never reverted", async () => {
    // Pre-Byzantium receipts carry no status. The transaction is mined, so it
    // is final; whether the invoice got paid is read from the contract.
    const provider = createProvider({ receipt: { status: null, blockNumber: 3 } });

    const result = await reconcilePaymentTx(pendingRecord(), provider, NOW);

    expect(result.status).toBe(TX_STATUS.CONFIRMED);
    expect(result.blockNumber).toBe(3);
  });
});

describe("waitForTrackedTx", () => {
  const context = {
    chainId: 11155111,
    account: ACCOUNT,
    operation: TX_OPERATION.APPROVE,
    invoiceIds: [5n],
    tokenAddress: TOKEN,
  };

  test("records the transaction before waiting and confirms it after", async () => {
    const storage = createStorage();
    let statusWhileWaiting;
    const tx = {
      hash: HASH_A,
      nonce: 3,
      wait: async () => {
        statusWhileWaiting = loadPaymentTxs(11155111, ACCOUNT, storage)[0]?.status;
        return { status: 1, blockNumber: 77, blockHash: HASH_B };
      },
    };

    const receipt = await waitForTrackedTx(tx, context, storage, NOW);

    expect(receipt.blockNumber).toBe(77);
    expect(statusWhileWaiting).toBe(TX_STATUS.PENDING);
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0]).toMatchObject({
      operation: TX_OPERATION.APPROVE,
      status: TX_STATUS.CONFIRMED,
      blockNumber: 77,
    });
  });

  test("stores the receipt of a revert and rethrows the error", async () => {
    const storage = createStorage();
    const revert = Object.assign(new Error("execution reverted"), {
      code: "CALL_EXCEPTION",
      receipt: { status: 0, blockNumber: 78, blockHash: HASH_B },
    });
    const tx = {
      hash: HASH_A,
      nonce: 3,
      wait: async () => {
        throw revert;
      },
    };

    await expect(waitForTrackedTx(tx, context, storage, NOW)).rejects.toBe(revert);
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.REVERTED);
  });

  test("marks it replaced, not by the replacement's receipt, when cancelled", async () => {
    // ethers attaches the *replacement's* receipt to this error. Copying its
    // block onto our record would report our hash as mined, which it never was.
    const storage = createStorage();
    const replaced = Object.assign(new Error("transaction was replaced"), {
      code: "TRANSACTION_REPLACED",
      reason: "cancelled",
      replacement: { hash: HASH_B },
      receipt: { status: 1, blockNumber: 80, blockHash: HASH_B },
    });
    const tx = {
      hash: HASH_A,
      nonce: 3,
      wait: async () => {
        throw replaced;
      },
    };

    await expect(waitForTrackedTx(tx, context, storage, NOW)).rejects.toBe(replaced);
    const [record] = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(record).toMatchObject({
      hash: HASH_A,
      status: TX_STATUS.REPLACED,
      replacementHash: HASH_B,
      replacementReason: "cancelled",
    });
    expect(record.blockNumber).toBeUndefined();
  });

  test("marks a successful speed-up confirmed, through the faster copy's hash", async () => {
    // The payment went through, so nothing about it should read as a warning.
    const storage = createStorage();
    const spedUp = Object.assign(new Error("transaction was replaced"), {
      code: "TRANSACTION_REPLACED",
      reason: "repriced",
      replacement: { hash: HASH_B },
      receipt: { status: 1, blockNumber: 80, blockHash: HASH_B },
    });
    const tx = { hash: HASH_A, nonce: 3, wait: async () => { throw spedUp; } };

    await expect(waitForTrackedTx(tx, context, storage, NOW)).rejects.toBe(spedUp);
    const [record] = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(record).toMatchObject({
      hash: HASH_A,
      status: TX_STATUS.CONFIRMED,
      replacementHash: HASH_B,
      replacementReason: "repriced",
    });
    expect(record.blockNumber).toBeUndefined();
  });

  test("stamps the outcome with the time it was learned, not the submission time", async () => {
    const storage = createStorage();
    const before = Date.now();
    const tx = { hash: HASH_A, nonce: 3, wait: async () => ({ status: 1, blockNumber: 9 }) };

    await waitForTrackedTx(tx, context, storage, new Date(0));

    const [record] = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(record.submittedAt).toBe(0);
    expect(record.checkedAt).toBeGreaterThanOrEqual(before);
  });

  test("leaves the record pending when waiting fails without a receipt", async () => {
    // e.g. the RPC dropped mid-wait: the transaction may still be mined, so
    // reconciliation decides later instead of this failure.
    const storage = createStorage();
    const tx = {
      hash: HASH_A,
      nonce: 3,
      wait: async () => {
        throw new Error("network error");
      },
    };

    await expect(waitForTrackedTx(tx, context, storage, NOW)).rejects.toThrow("network error");
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.PENDING);
  });

  test("still waits for the transaction when storage is unavailable", async () => {
    const tx = { hash: HASH_A, nonce: 3, wait: async () => ({ status: 1, blockNumber: 1 }) };

    await expect(waitForTrackedTx(tx, context, throwingStorage, NOW)).resolves.toEqual({
      status: 1,
      blockNumber: 1,
    });
  });
});

describe("findPendingPaymentTx", () => {
  const records = [
    pendingRecord({ hash: HASH_A, invoiceIds: ["5"], status: TX_STATUS.REVERTED }),
    pendingRecord({
      hash: HASH_B,
      operation: TX_OPERATION.PAY_BATCH,
      invoiceIds: ["9", "10"],
      status: TX_STATUS.PENDING,
    }),
    pendingRecord({
      hash: `0x${"c".repeat(64)}`,
      operation: TX_OPERATION.APPROVE,
      invoiceIds: ["11"],
      status: TX_STATUS.PENDING,
    }),
  ];

  test("finds a pending payment covering the invoice, single or batch", () => {
    expect(findPendingPaymentTx(records, 10n, CONTRACT)?.hash).toBe(HASH_B);
    expect(findPendingPaymentTx(records, "9", CONTRACT)?.hash).toBe(HASH_B);
  });

  test("does not block on a payment that is unresolved, confirmed or replaced", () => {
    // An unresolved payment may have been dropped; blocking on it would lock
    // the invoice for good. Whether it was paid is the contract's call.
    for (const status of [TX_STATUS.UNRESOLVED, TX_STATUS.CONFIRMED, TX_STATUS.REPLACED]) {
      expect(findPendingPaymentTx([pendingRecord({ status })], 5, CONTRACT)).toBeUndefined();
    }
  });

  test("only counts payments to the contract this build is configured for", () => {
    // A redeploy on the same chain restarts invoice ids at 0, so invoice #5
    // on the old contract is a different invoice from #5 on the new one.
    const old = [pendingRecord({ contractAddress: OLD_CONTRACT.toLowerCase() })];

    expect(findPendingPaymentTx(old, 5, CONTRACT)).toBeUndefined();
    expect(findPendingPaymentTx(old, 5, OLD_CONTRACT)?.hash).toBe(HASH_A);
  });

  test("matches nothing when the configured contract is unknown", () => {
    expect(findPendingPaymentTx(records, 10n, undefined)).toBeUndefined();
    expect(findPendingPaymentTx(records, 10n, "")).toBeUndefined();
  });

  test("ignores finished payments and approvals", () => {
    expect(findPendingPaymentTx(records, 5, CONTRACT)).toBeUndefined();
    expect(findPendingPaymentTx(records, 11, CONTRACT)).toBeUndefined();
    expect(findPendingPaymentTx(records, 1, CONTRACT)).toBeUndefined();
    expect(findPendingPaymentTx(undefined, 1)).toBeUndefined();
  });
});

describe("saveReconciledTx", () => {
  test("stores a reconciled result over a still-open record", () => {
    const storage = createStorage();
    submit(storage);

    expect(
      saveReconciledTx(pendingRecord({ status: TX_STATUS.UNRESOLVED }), storage)
    ).toBe(true);
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.UNRESOLVED);
  });

  test("never overwrites an outcome that was settled while it was reading", () => {
    // The poller read "pending", then the payment's own wait() stored the
    // receipt before the poller wrote back: the stale read must not win.
    const storage = createStorage();
    submit(storage);
    updatePaymentTx(11155111, ACCOUNT, HASH_A, { status: TX_STATUS.CONFIRMED }, storage);

    expect(saveReconciledTx(pendingRecord(), storage)).toBe(false);
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.CONFIRMED);
  });

  test("does not bring back a record dismissed while it was reading", () => {
    const storage = createStorage();
    submit(storage);
    removePaymentTx(11155111, ACCOUNT, HASH_A, storage);

    expect(saveReconciledTx(pendingRecord(), storage)).toBe(false);
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)).toEqual([]);
  });
});

describe("txExplorerUrl", () => {
  test("builds the transaction link from the chain's configured explorer", () => {
    const chain = { blockExplorers: { default: { url: "https://sepolia.etherscan.io/" } } };

    expect(txExplorerUrl(chain, HASH_A)).toBe(`https://sepolia.etherscan.io/tx/${HASH_A}`);
  });

  test("returns null when the chain has no explorer", () => {
    expect(txExplorerUrl({}, HASH_A)).toBeNull();
    expect(txExplorerUrl(undefined, HASH_A)).toBeNull();
  });
});

describe("isSuccessfulSpeedUp", () => {
  const replaced = (reason, receipt) =>
    Object.assign(new Error("transaction was replaced"), {
      code: "TRANSACTION_REPLACED",
      reason,
      receipt,
    });

  test("is true when a sped-up copy of the same call was mined and succeeded", () => {
    // ethers rejects wait() with TRANSACTION_REPLACED even then, although the
    // payment went through.
    expect(isSuccessfulSpeedUp(replaced("repriced", { status: 1 }))).toBe(true);
  });

  test("is false when the sped-up copy reverted", () => {
    expect(isSuccessfulSpeedUp(replaced("repriced", { status: 0 }))).toBe(false);
  });

  test("is false for a cancel or a different transaction on the same nonce", () => {
    expect(isSuccessfulSpeedUp(replaced("cancelled", { status: 1 }))).toBe(false);
    expect(isSuccessfulSpeedUp(replaced("replaced", { status: 1 }))).toBe(false);
  });

  test("is false for any other error", () => {
    expect(isSuccessfulSpeedUp(new Error("user rejected"))).toBe(false);
    expect(isSuccessfulSpeedUp(undefined)).toBe(false);
    expect(isSuccessfulSpeedUp(replaced("repriced", undefined))).toBe(false);
  });
});

describe("waitForTrackedTx when the record cannot be saved", () => {
  test("tells the caller, and still waits for the transaction", async () => {
    let notified = 0;
    const tx = { hash: HASH_A, nonce: 1, wait: async () => ({ status: 1, blockNumber: 2 }) };

    const receipt = await waitForTrackedTx(
      tx,
      {
        chainId: 1,
        account: ACCOUNT,
        operation: TX_OPERATION.PAY,
        invoiceIds: [1],
        onNotRecorded: () => {
          notified += 1;
        },
      },
      throwingStorage,
      NOW
    );

    expect(receipt.blockNumber).toBe(2);
    expect(notified).toBe(1);
  });

  test("does not call it when the record was saved", async () => {
    let notified = 0;
    const storage = createStorage();
    const tx = { hash: HASH_A, nonce: 1, wait: async () => ({ status: 1, blockNumber: 2 }) };

    await waitForTrackedTx(
      tx,
      {
        chainId: 1,
        account: ACCOUNT,
        operation: TX_OPERATION.PAY,
        invoiceIds: [1],
        onNotRecorded: () => {
          notified += 1;
        },
      },
      storage,
      NOW
    );

    expect(notified).toBe(0);
    expect(loadPaymentTxs(1, ACCOUNT, storage)[0]).not.toHaveProperty("onNotRecorded");
  });
});

describe("waitForPaymentTx", () => {
  const context = {
    chainId: 11155111,
    account: ACCOUNT,
    contractAddress: CONTRACT,
    operation: TX_OPERATION.PAY,
    invoiceIds: [5n],
  };

  test("resolves with the faster copy's receipt when a sped-up payment succeeded", async () => {
    const storage = createStorage();
    const fasterReceipt = { status: 1, blockNumber: 90, blockHash: HASH_B };
    const tx = {
      hash: HASH_A,
      nonce: 3,
      wait: async () => {
        throw Object.assign(new Error("transaction was replaced"), {
          code: "TRANSACTION_REPLACED",
          reason: "repriced",
          replacement: { hash: HASH_B },
          receipt: fasterReceipt,
        });
      },
    };

    await expect(waitForPaymentTx(tx, context, storage, NOW)).resolves.toBe(fasterReceipt);
    // Stored as confirmed, so no "replaced" warning sits beside the success toast.
    const stored = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(stored[0].status).toBe(TX_STATUS.CONFIRMED);
    expect(getVisiblePaymentTxs(stored, CONTRACT)).toEqual([]);
  });

  test("still rejects a cancelled or reverted replacement", async () => {
    for (const [reason, status] of [["cancelled", 1], ["repriced", 0], ["replaced", 1]]) {
      const error = Object.assign(new Error("transaction was replaced"), {
        code: "TRANSACTION_REPLACED",
        reason,
        receipt: { status },
      });
      const tx = { hash: HASH_A, nonce: 3, wait: async () => { throw error; } };

      await expect(waitForPaymentTx(tx, context, createStorage(), NOW)).rejects.toBe(error);
    }
  });

  test("resolves like wait() on a normal confirmation", async () => {
    const receipt = { status: 1, blockNumber: 7 };
    const tx = { hash: HASH_A, nonce: 3, wait: async () => receipt };

    await expect(waitForPaymentTx(tx, context, createStorage(), NOW)).resolves.toBe(receipt);
  });
});

describe("reconcileOpenPaymentTxs", () => {
  test("checks only open records, saves results and reports what changed", async () => {
    const storage = createStorage();
    submit(storage, { tx: { hash: HASH_A, nonce: 7 } });
    submit(storage, { tx: { hash: HASH_B, nonce: 8 } });
    const third = `0x${"c".repeat(64)}`;
    submit(storage, { tx: { hash: third, nonce: 1 } });
    updatePaymentTx(11155111, ACCOUNT, third, { status: TX_STATUS.REVERTED }, storage);

    const provider = {
      calls: [],
      getTransactionReceipt: async (hash) => {
        provider.calls.push(hash);
        return hash === HASH_A ? { status: 1, blockNumber: 5, blockHash: HASH_B } : null;
      },
      getTransaction: async (hash) => (hash === HASH_B ? { hash } : null),
      getTransactionCount: async () => 0,
    };

    const result = await reconcileOpenPaymentTxs(11155111, ACCOUNT, provider, storage, NOW);

    expect(result).toEqual({ settled: true, stillOpen: true });
    expect(provider.calls).not.toContain(third);
    const byHash = Object.fromEntries(
      loadPaymentTxs(11155111, ACCOUNT, storage).map((r) => [r.hash, r.status])
    );
    expect(byHash).toEqual({
      [HASH_A]: TX_STATUS.CONFIRMED,
      [HASH_B]: TX_STATUS.PENDING,
      [third]: TX_STATUS.REVERTED,
    });
  });

  test("reports nothing settled or open when every record is final", async () => {
    const storage = createStorage();
    submit(storage);
    updatePaymentTx(11155111, ACCOUNT, HASH_A, { status: TX_STATUS.CONFIRMED }, storage);
    const provider = createProvider();

    expect(await reconcileOpenPaymentTxs(11155111, ACCOUNT, provider, storage, NOW)).toEqual({
      settled: false,
      stillOpen: false,
    });
    expect(provider.calls).toEqual([]);
  });

  test("stops without saving once cancelled, e.g. after a network switch", async () => {
    const storage = createStorage();
    submit(storage);
    let cancelled = false;
    const provider = createProvider({
      receipt: () => {
        cancelled = true;
        return { status: 1, blockNumber: 5 };
      },
    });

    const result = await reconcileOpenPaymentTxs(
      11155111,
      ACCOUNT,
      provider,
      storage,
      NOW,
      () => cancelled
    );

    expect(result).toBeNull();
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.PENDING);
  });

  test("does not count a stale result that lost to a settled record", async () => {
    const storage = createStorage();
    submit(storage);
    const provider = createProvider({
      receipt: () => {
        // The payment's own wait() stores the receipt while this read runs.
        updatePaymentTx(11155111, ACCOUNT, HASH_A, { status: TX_STATUS.CONFIRMED }, storage);
        return null;
      },
      tx: { hash: HASH_A },
    });

    const result = await reconcileOpenPaymentTxs(11155111, ACCOUNT, provider, storage, NOW);

    expect(result).toEqual({ settled: false, stillOpen: false });
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.CONFIRMED);
  });
});

describe("getVisiblePaymentTxs", () => {
  test("lists unfinished and failed records for this contract, newest first", () => {
    const records = [
      pendingRecord({ hash: HASH_A, submittedAt: 1 }),
      pendingRecord({ hash: HASH_B, status: TX_STATUS.REVERTED, submittedAt: 3 }),
      pendingRecord({ hash: `0x${"c".repeat(64)}`, status: TX_STATUS.CONFIRMED, submittedAt: 2 }),
      pendingRecord({
        hash: `0x${"d".repeat(64)}`,
        contractAddress: OLD_CONTRACT.toLowerCase(),
        submittedAt: 4,
      }),
    ];

    expect(getVisiblePaymentTxs(records, CONTRACT).map((r) => r.hash)).toEqual([HASH_B, HASH_A]);
  });

  test("shows nothing without a configured contract", () => {
    expect(getVisiblePaymentTxs([pendingRecord()], undefined)).toEqual([]);
    expect(getVisiblePaymentTxs(undefined, CONTRACT)).toEqual([]);
  });
});

describe("break-it regressions", () => {
  // F2
  test("keeps a payment pending while a transaction with its nonce is in the mempool", async () => {
    // The wallet sped it up: our hash left the mempool, the faster copy with
    // the same nonce is still pending, nothing is mined yet.
    const provider = createProvider({ nonce: (tag) => (tag === "pending" ? 8 : 7) });

    const result = await reconcilePaymentTx(pendingRecord(), provider, NOW);

    expect(result.status).toBe(TX_STATUS.PENDING);
    expect(findPendingPaymentTx([result], 5, CONTRACT)).toBeDefined();
  });

  // F4
  test("ignores records whose chain or account does not match their storage entry", () => {
    const key = paymentTxStorageKey(11155111, ACCOUNT);
    const storage = createStorage({
      [key]: JSON.stringify([
        { ...pendingRecord(), account: undefined },
        { ...pendingRecord({ hash: HASH_B }), chainId: undefined },
        { ...pendingRecord({ hash: `0x${"c".repeat(64)}` }), chainId: 1 },
        { ...pendingRecord({ hash: `0x${"d".repeat(64)}` }), account: OTHER_ACCOUNT.toLowerCase() },
      ]),
    });

    expect(loadPaymentTxs(11155111, ACCOUNT, storage)).toEqual([]);
  });

  // F5
  test("prunes unresolved records like finished ones, never pending ones", () => {
    const storage = createStorage();
    for (let i = 0; i < MAX_PAYMENT_TX_RECORDS + 10; i += 1) {
      const hash = `0x${i.toString(16).padStart(64, "0")}`;
      recordSubmittedTx(
        {
          chainId: 1,
          account: ACCOUNT,
          tx: { hash, nonce: i },
          operation: TX_OPERATION.PAY,
          invoiceIds: [i],
          contractAddress: CONTRACT,
        },
        storage,
        new Date(NOW.getTime() + i)
      );
      if (i > 0) updatePaymentTx(1, ACCOUNT, hash, { status: TX_STATUS.UNRESOLVED }, storage);
    }

    const records = loadPaymentTxs(1, ACCOUNT, storage);
    expect(records.length).toBe(MAX_PAYMENT_TX_RECORDS);
    expect(records.some((r) => r.nonce === 0)).toBe(true);
    expect(records.some((r) => r.nonce === 1)).toBe(false);
  });

  test("does not keep polling for records that are only unresolved", async () => {
    const storage = createStorage();
    submit(storage);
    updatePaymentTx(11155111, ACCOUNT, HASH_A, { status: TX_STATUS.UNRESOLVED }, storage);

    const result = await reconcileOpenPaymentTxs(
      11155111,
      ACCOUNT,
      createProvider({ nonce: 7 }),
      storage,
      NOW
    );

    // Still rechecked when the page loads or refreshes, but no 15s poll for it.
    expect(result).toEqual({ settled: false, stillOpen: false });
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.UNRESOLVED);
  });

  // F3
  test("a provider pinned to the record's chain refuses to read another chain", async () => {
    const storage = createStorage();
    submit(storage);
    // The wallet already answers on mainnet, where this account's nonce is 100.
    const wallet = {
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getTransactionCount") return "0x64";
        if (method === "eth_blockNumber") return "0x10";
        return null;
      },
    };
    const provider = createRecordChainProvider(wallet, 11155111);

    await reconcileOpenPaymentTxs(11155111, ACCOUNT, provider, storage, NOW);
    provider.destroy();

    const [record] = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(record.status).toBe(TX_STATUS.PENDING);
    expect(record.lastError).toMatch(/network changed/);
  });

  // F1
  describe("sendTrackedTx", () => {
    const context = {
      chainId: 11155111,
      account: ACCOUNT,
      contractAddress: CONTRACT,
      operation: TX_OPERATION.PAY,
      invoiceIds: [5n],
    };

    test("records the hash as soon as the wallet returns it, before ethers fetches the tx", async () => {
      // ethers' JsonRpcSigner.sendTransaction gets the hash, then polls the node
      // for the full transaction; if that read fails it rejects although the
      // payment was already broadcast.
      const storage = createStorage();
      const original = async () => HASH_A;
      const signer = { sendUncheckedTransaction: original };
      const badData = Object.assign(new Error("bad data"), {
        code: "BAD_DATA",
        info: { sendTransactionHash: HASH_A },
      });

      await expect(
        sendTrackedTx(
          signer,
          context,
          async () => {
            await signer.sendUncheckedTransaction({});
            throw badData;
          },
          storage,
          NOW
        )
      ).rejects.toBe(badData);

      expect(loadPaymentTxs(11155111, ACCOUNT, storage)).toEqual([
        expect.objectContaining({ hash: HASH_A, status: TX_STATUS.PENDING, invoiceIds: ["5"] }),
      ]);
      expect(signer.sendUncheckedTransaction).toBe(original);
    });

    test("records a real ethers contract call while ethers is still waiting for the node", async () => {
      const storage = createStorage();
      const wallet = {
        request: async ({ method }) => {
          switch (method) {
            case "eth_chainId":
              return "0xaa36a7";
            case "eth_accounts":
            case "eth_requestAccounts":
              return [ACCOUNT.toLowerCase()];
            case "eth_blockNumber":
              return "0x10";
            case "eth_estimateGas":
              return "0x5208";
            case "eth_sendTransaction":
              return HASH_A;
            default:
              return null; // the node never shows the transaction
          }
        },
      };
      const provider = new BrowserProvider(wallet, 11155111);
      const signer = await provider.getSigner();
      const contract = new Contract(
        CONTRACT,
        ["function payInvoice(uint256) payable"],
        signer
      );

      const sending = sendTrackedTx(
        signer,
        context,
        () => contract.payInvoice(5n, { value: 1n }),
        storage,
        NOW
      );
      sending.catch(() => {});
      for (let i = 0; i < 50 && loadPaymentTxs(11155111, ACCOUNT, storage).length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      provider.destroy();

      expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0]).toMatchObject({
        hash: HASH_A,
        status: TX_STATUS.PENDING,
      });
    });

    test("does not reset a record when the full transaction is recorded again", () => {
      const storage = createStorage();
      recordSubmittedTx({ ...context, tx: { hash: HASH_A } }, storage, NOW);
      updatePaymentTx(11155111, ACCOUNT, HASH_A, { status: TX_STATUS.CONFIRMED }, storage);

      recordSubmittedTx(
        { ...context, tx: { hash: HASH_A, nonce: 9 } },
        storage,
        new Date(NOW.getTime() + 5000)
      );

      expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0]).toMatchObject({
        status: TX_STATUS.CONFIRMED,
        nonce: 9,
        submittedAt: NOW.getTime(),
      });
    });
  });
});

describe("break-it round 2 regressions", () => {
  // R2-F1
  test("re-reads the receipt from the node, not from ethers' 250ms request cache", async () => {
    // Our tx is mined between the first receipt read and the nonce read. The
    // re-check must reach the wallet, or the payment is stored as replaced.
    const storage = createStorage();
    submit(storage);
    let receiptRequests = 0;
    const wallet = {
      request: async ({ method }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        switch (method) {
          case "eth_chainId":
            return "0xaa36a7";
          case "eth_getTransactionReceipt":
            receiptRequests += 1;
            return receiptRequests === 1
              ? null
              : {
                  transactionHash: HASH_A,
                  blockHash: HASH_B,
                  blockNumber: "0x10",
                  transactionIndex: "0x0",
                  from: ACCOUNT.toLowerCase(),
                  to: CONTRACT.toLowerCase(),
                  contractAddress: null,
                  cumulativeGasUsed: "0x5208",
                  gasUsed: "0x5208",
                  effectiveGasPrice: "0x1",
                  logs: [],
                  logsBloom: `0x${"0".repeat(512)}`,
                  status: "0x1",
                  type: "0x2",
                };
          case "eth_getTransactionCount":
            return "0x8";
          case "eth_blockNumber":
            return "0x10";
          default:
            return null;
        }
      },
    };
    const provider = createRecordChainProvider(wallet, 11155111);

    await reconcileOpenPaymentTxs(11155111, ACCOUNT, provider, storage, NOW);
    provider.destroy();

    expect(receiptRequests).toBe(2);
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.CONFIRMED);
  });

  // R2-F2
  test("learns the nonce from the node for a record saved with only its hash", async () => {
    const storage = createStorage();
    recordSubmittedTx(
      {
        chainId: 11155111,
        account: ACCOUNT,
        tx: { hash: HASH_A },
        operation: TX_OPERATION.PAY,
        invoiceIds: [5n],
        contractAddress: CONTRACT,
      },
      storage,
      NOW
    );

    // First poll: the node still has our transaction.
    await reconcileOpenPaymentTxs(
      11155111,
      ACCOUNT,
      createProvider({ tx: { hash: HASH_A, nonce: 7 } }),
      storage,
      NOW
    );
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].nonce).toBe(7);

    // Then the wallet speeds it up: our hash is gone, the copy is pending.
    const result = await reconcileOpenPaymentTxs(
      11155111,
      ACCOUNT,
      createProvider({ nonce: (tag) => (tag === "pending" ? 8 : 7) }),
      storage,
      NOW
    );
    const stored = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(stored[0].status).toBe(TX_STATUS.PENDING);
    expect(result.stillOpen).toBe(true);
    expect(findPendingPaymentTx(stored, 5, CONTRACT)).toBeDefined();
  });

  // R2-F5
  test("refuses overlapping sends on one signer instead of mixing up their records", async () => {
    const storage = createStorage();
    let release;
    const signer = { sendUncheckedTransaction: async () => HASH_A };
    const first = sendTrackedTx(
      signer,
      { chainId: 1, account: ACCOUNT, operation: TX_OPERATION.PAY, invoiceIds: [1], contractAddress: CONTRACT },
      async () => {
        await signer.sendUncheckedTransaction({});
        await new Promise((resolve) => { release = resolve; });
        return "first";
      },
      storage,
      NOW
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      sendTrackedTx(
        signer,
        { chainId: 1, account: ACCOUNT, operation: TX_OPERATION.PAY, invoiceIds: [2], contractAddress: CONTRACT },
        async () => "second",
        storage,
        NOW
      )
    ).rejects.toThrow(/already sending/);

    release();
    await expect(first).resolves.toBe("first");
    expect(loadPaymentTxs(1, ACCOUNT, storage).map((r) => r.invoiceIds)).toEqual([["1"]]);
    // Sequential sends on the same signer (the batch loop) still work.
    await expect(
      sendTrackedTx(signer, { chainId: 1, account: ACCOUNT, operation: TX_OPERATION.PAY, invoiceIds: [3] }, async () => "third", storage, NOW)
    ).resolves.toBe("third");
  });

  // R2-F4
  test("createWarnOnce shows its warning only the first time", () => {
    let shown = 0;
    const warn = createWarnOnce(() => {
      shown += 1;
    });

    warn();
    warn();
    warn();

    expect(shown).toBe(1);
  });
});

describe("break-it round 3 regressions", () => {
  // R3-N1
  test("treats hashes case-insensitively, so a wallet's upper-case hash is one record", async () => {
    const storage = createStorage();
    const context = {
      chainId: 11155111,
      account: ACCOUNT,
      contractAddress: CONTRACT,
      operation: TX_OPERATION.PAY,
      invoiceIds: [5n],
    };
    recordSubmittedTx({ ...context, tx: { hash: `0x${"A".repeat(64)}` } }, storage, NOW);

    await waitForTrackedTx(
      { hash: HASH_A, nonce: 7, wait: async () => ({ status: 1, blockNumber: 9 }) },
      context,
      storage,
      NOW
    );

    const records = loadPaymentTxs(11155111, ACCOUNT, storage);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ hash: HASH_A, status: TX_STATUS.CONFIRMED, nonce: 7 });
  });

  test("finds a record by an upper-case hash when updating, waiting or removing", async () => {
    const storage = createStorage();
    const upper = `0x${"A".repeat(64)}`;
    submit(storage, { tx: { hash: upper, nonce: 7 } });

    expect(updatePaymentTx(11155111, ACCOUNT, upper, { status: TX_STATUS.UNRESOLVED }, storage)).toBe(true);
    await waitForTrackedTx(
      { hash: upper, nonce: 7, wait: async () => ({ status: 0, blockNumber: 3 }) },
      { chainId: 11155111, account: ACCOUNT, operation: TX_OPERATION.PAY, invoiceIds: [5n] },
      storage,
      NOW
    );
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)).toEqual([
      expect.objectContaining({ hash: HASH_A, status: TX_STATUS.REVERTED }),
    ]);
    expect(removePaymentTx(11155111, ACCOUNT, upper, storage)).toBe(true);
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)).toEqual([]);
  });

  // R3-N2
  test("needs the replaced evidence on two checks before calling it final", async () => {
    // One lagging backend (receipt index behind the nonce) must not settle a
    // paid transaction as replaced for good.
    const storage = createStorage();
    submit(storage);
    let receiptReady = false;
    const provider = createProvider({
      receipt: () => (receiptReady ? { status: 1, blockNumber: 12, blockHash: HASH_B } : null),
      nonce: 8,
    });

    const first = await reconcileOpenPaymentTxs(11155111, ACCOUNT, provider, storage, NOW);
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.PENDING);
    expect(first.stillOpen).toBe(true);

    receiptReady = true;
    await reconcileOpenPaymentTxs(11155111, ACCOUNT, provider, storage, NOW);
    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0]).toMatchObject({
      status: TX_STATUS.CONFIRMED,
      blockNumber: 12,
    });
  });

  test("settles as replaced when the second check still shows another tx took the nonce", async () => {
    const storage = createStorage();
    submit(storage);
    const provider = createProvider({ nonce: 8 });

    await reconcileOpenPaymentTxs(11155111, ACCOUNT, provider, storage, NOW);
    await reconcileOpenPaymentTxs(11155111, ACCOUNT, provider, storage, NOW);

    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.REPLACED);
  });

  test("forgets a replaced suspicion once other evidence arrives", async () => {
    const storage = createStorage();
    submit(storage);
    await reconcileOpenPaymentTxs(11155111, ACCOUNT, createProvider({ nonce: 8 }), storage, NOW);
    // Next check: the node sees our tx again (e.g. the first answer was stale).
    await reconcileOpenPaymentTxs(11155111, ACCOUNT, createProvider({ tx: { hash: HASH_A } }), storage, NOW);
    // Then nonce evidence again: this is a first suspicion, not a second.
    await reconcileOpenPaymentTxs(11155111, ACCOUNT, createProvider({ nonce: 8 }), storage, NOW);

    expect(loadPaymentTxs(11155111, ACCOUNT, storage)[0].status).toBe(TX_STATUS.PENDING);
  });
});
