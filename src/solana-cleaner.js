import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createCloseAccountInstruction
} from '@solana/spl-token';

export const KICKSTART_LAMPORTS = 800000; // 0.0008 SOL (Rent exempt 650,240 + 149,760 fee buffer)
export const BASE_SIGNATURE_FEE = 5000; // 0.000005 SOL (standard 1-signature tx)
export const CLAIM_BATCH_SIZE = 8; // Safe instruction batch size per CloseAccount transaction

/**
 * Sleep helper with promise
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let _cachedBlockhash = null;
let _cachedBlockhashTime = 0;

export async function getCachedBlockhash(connection, maxAgeMs = 25000) {
  const now = Date.now();
  if (_cachedBlockhash && (now - _cachedBlockhashTime) < maxAgeMs) {
    return _cachedBlockhash;
  }
  const res = await withRpcRetry(() => connection.getLatestBlockhash('confirmed'), 3, 500);
  _cachedBlockhash = res.blockhash;
  _cachedBlockhashTime = now;
  return _cachedBlockhash;
}

/**
 * Normalize an RPC URL or auto-format if an API key is provided
 */
export function normalizeRpcUrl(rawUrl) {
  const defaultRpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  if (!rawUrl || typeof rawUrl !== 'string') return defaultRpc;
  let trimmed = rawUrl.trim();
  if (!trimmed) return defaultRpc;

  // If user pasted just an Alchemy API key
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    if (trimmed.length > 15 && trimmed.length < 50 && !trimmed.includes('/')) {
      return `https://solana-mainnet.g.alchemy.com/v2/${trimmed}`;
    }
  }
  return trimmed;
}

/**
 * Execute an RPC action with adaptive retry for rate limits or transient network errors.
 */
export async function withRpcRetry(fn, maxRetries = 6, initialDelay = 700) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const isRateLimit = err?.message?.includes('429') || err?.message?.toLowerCase().includes('rate limit');
      if (attempt >= maxRetries) {
        if (isRateLimit) {
          throw new Error('RPC rate limit reached (HTTP 429). The public Solana RPC was throttled. Please enable Solana Mainnet on your Alchemy app (https://dashboard.alchemy.com/apps) or use Helius/QuickNode in Setup.');
        }
        throw err;
      }
      const delay = (isRateLimit ? Math.min(initialDelay * Math.pow(1.6, attempt), 5000) : initialDelay) + Math.floor(Math.random() * 300);
      await sleep(delay);
    }
  }
}

/**
 * Create a Connection object with 'confirmed' commitment.
 */
export function createConnection(rpcUrl) {
  const url = normalizeRpcUrl(rpcUrl);
  return new Connection(url, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000
  });
}

/**
 * Get native balance in lamports and SOL.
 */
export async function getNativeBalance(connection, pubkey) {
  const publicKey = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
  return await withRpcRetry(() => connection.getBalance(publicKey, 'confirmed'));
}

/**
 * Fetch and scan all empty token accounts for a wallet across SPL Token and Token-2022.
 * Returns only accounts where tokenAmount.amount === "0".
 */
export async function scanWalletAccounts(connection, publicKeyStr) {
  const owner = new PublicKey(publicKeyStr);

  // 1. Native balance
  const nativeBalance = await withRpcRetry(() => connection.getBalance(owner, 'confirmed'));

  // 2. SPL Token accounts
  let splAccounts = [];
  try {
    const res = await withRpcRetry(() =>
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })
    );
    splAccounts = res.value || [];
  } catch (err) {
    // If program is not supported or network error, record but don't fail immediately
    if (!err.message?.includes('could not find account')) {
      // Re-throw if it's a connection / rate limit issue
      throw err;
    }
  }

  // 3. Token-2022 accounts
  let token2022Accounts = [];
  try {
    const res = await withRpcRetry(() =>
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })
    );
    token2022Accounts = res.value || [];
  } catch (err) {
    // Some custom test RPCs might not have Token-2022 deployed; handle gracefully
    if (err.message && (err.message.includes('429') || err.message.includes('rate limit'))) {
      throw err;
    }
  }

  const emptyAccounts = [];

  // Filter SPL Token accounts
  for (const item of splAccounts) {
    const parsed = item.account?.data?.parsed;
    const info = parsed?.info;
    const amountStr = info?.tokenAmount?.amount;

    // HARD RULES:
    // 1. token amount === '0'
    // 2. not frozen
    // 3. not native wrapped SOL
    // 4. closeAuthority matches owner or is unset
    // 5. no delegated tokens
    const closeAuth = info?.closeAuthority;
    const isOwnerCloseAuth = !closeAuth || closeAuth === publicKeyStr;
    const isNotDelegated = !info?.delegatedAmount || info.delegatedAmount?.amount === '0';
    const isNotNative = !info?.isNative;

    if (amountStr === '0' && info?.state !== 'frozen' && isOwnerCloseAuth && isNotDelegated && isNotNative) {
      emptyAccounts.push({
        pubkey: item.pubkey.toBase58(),
        programId: TOKEN_PROGRAM_ID.toBase58(),
        mint: info?.mint || 'unknown',
        rentLamports: item.account.lamports || 2039280
      });
    }
  }

  // Filter Token-2022 accounts
  for (const item of token2022Accounts) {
    const parsed = item.account?.data?.parsed;
    const info = parsed?.info;
    const amountStr = info?.tokenAmount?.amount;

    const closeAuth = info?.closeAuthority;
    const isOwnerCloseAuth = !closeAuth || closeAuth === publicKeyStr;
    const isNotDelegated = !info?.delegatedAmount || info.delegatedAmount?.amount === '0';
    const isNotNative = !info?.isNative;

    if (amountStr === '0' && info?.state !== 'frozen' && isOwnerCloseAuth && isNotDelegated && isNotNative) {
      emptyAccounts.push({
        pubkey: item.pubkey.toBase58(),
        programId: TOKEN_2022_PROGRAM_ID.toBase58(),
        mint: info?.mint || 'unknown',
        rentLamports: item.account.lamports || 2039280
      });
    }
  }

  const emptyCount = emptyAccounts.length;
  const lockedRentLamports = emptyAccounts.reduce((acc, a) => acc + a.rentLamports, 0);

  // Claim requires Math.ceil(emptyCount / 8) transactions if emptyCount > 0, else 0
  const claimBatchesCount = emptyCount > 0 ? Math.ceil(emptyCount / CLAIM_BATCH_SIZE) : 0;
  const estimatedClaimFeeLamports = claimBatchesCount * BASE_SIGNATURE_FEE;

  // Send fee is 1 signature (5,000 lamports) if wallet will send remaining SOL to main
  const estimatedSendFeeLamports = BASE_SIGNATURE_FEE;

  return {
    publicKey: publicKeyStr,
    nativeLamports: nativeBalance,
    nativeSol: nativeBalance / LAMPORTS_PER_SOL,
    emptyAccountsCount: emptyCount,
    emptyAccounts,
    lockedRentLamports,
    lockedRentSol: lockedRentLamports / LAMPORTS_PER_SOL,
    claimBatchesCount,
    estimatedClaimFeeLamports,
    estimatedClaimFeeSol: estimatedClaimFeeLamports / LAMPORTS_PER_SOL,
    estimatedSendFeeLamports,
    estimatedSendFeeSol: estimatedSendFeeLamports / LAMPORTS_PER_SOL
  };
}

/**
 * Preflight simulation verification of token accounts to guarantee they can be closed.
 * Filters out accounts with non-zero dust, withheld fees, or custom closeAuthority.
 * Uses zero blockchain fees (simulations are 100% free RPC calls).
 */
export async function verifyCloseableAccounts(connection, targetPubkeyStr, accounts, feePayerPubkeyStr) {
  if (!accounts || accounts.length === 0) return [];
  const targetPubkey = new PublicKey(targetPubkeyStr);
  
  let payer = null;
  if (feePayerPubkeyStr) {
    try {
      payer = new PublicKey(feePayerPubkeyStr);
    } catch {}
  }
  if (!payer) {
    payer = new PublicKey('9jxgosAfHgHzwnxsHw4RAZYaLVokMbnYtmiZBreynGFP');
  }

  let blockhash;
  try {
    blockhash = await getCachedBlockhash(connection);
  } catch {
    // If blockhash cannot be fetched, NEVER assume closeable! Return empty to prevent fee loss.
    return [];
  }

  const buildTx = (accList) => {
    const tx = new Transaction();
    for (const acc of accList) {
      tx.add(
        createCloseAccountInstruction(
          new PublicKey(acc.pubkey),
          targetPubkey,
          targetPubkey,
          [],
          new PublicKey(acc.programId)
        )
      );
    }
    tx.feePayer = payer;
    tx.recentBlockhash = blockhash;
    return tx;
  };

  // Try bulk simulation first for instant validation
  try {
    const bulkTx = buildTx(accounts);
    const bulkSim = await withRpcRetry(() => connection.simulateTransaction(bulkTx, undefined, false), 2, 400);
    if (!bulkSim?.value?.err) {
      return accounts; // All closeable!
    }
  } catch {}

  // If bulk simulation failed, test each individually
  const closeable = [];
  for (const acc of accounts) {
    try {
      const singleTx = buildTx([acc]);
      const sim = await withRpcRetry(() => connection.simulateTransaction(singleTx, undefined, false), 2, 300);
      if (!sim?.value?.err) {
        closeable.push(acc);
      }
    } catch {}
  }

  return closeable;
}

/**
 * Determine the status, kickstart requirement, and net expected to main for a scanned wallet.
 */
export function evaluateWalletDecision(walletInfo, feeSenderAddress, mainAddress) {
  const isMain = mainAddress && walletInfo.publicKey === mainAddress;
  const isFeeSender = feeSenderAddress && walletInfo.publicKey === feeSenderAddress;

  const hasEmptyAccounts = walletInfo.emptyAccountsCount > 0;
  const nativeLamports = walletInfo.nativeLamports || 0;
  const lockedRentLamports = walletInfo.lockedRentLamports || 0;
  const hasFeeSender = Boolean(feeSenderAddress);

  let status = 'ready';
  let reason = '';
  let willKickstart = false;
  let willClaim = hasEmptyAccounts;
  let willSend = false;
  let estimatedNetToMainLamports = 0;

  if (isMain) {
    if (hasEmptyAccounts) {
      status = 'ready';
      willClaim = true;
      willSend = false;
      estimatedNetToMainLamports = lockedRentLamports;
      reason = 'Will claim rent directly into main wallet';
    } else {
      status = 'skip';
      reason = 'Destination is main wallet and has no empty accounts to claim';
    }
  } else if (isFeeSender) {
    if (hasEmptyAccounts) {
      status = 'ready';
      willClaim = true;
      willSend = false;
      estimatedNetToMainLamports = lockedRentLamports;
      reason = 'Will claim rent from fee sender to main';
    } else {
      status = 'skip';
      reason = 'Fee sender wallet has no empty accounts to claim';
    }
  } else if (!hasEmptyAccounts && nativeLamports === 0) {
    status = 'skip';
    reason = 'Empty wallet (0 SOL, 0 empty accounts)';
  } else if (!hasEmptyAccounts && nativeLamports <= BASE_SIGNATURE_FEE && !hasFeeSender) {
    status = 'skip';
    reason = 'No empty accounts and native balance below fee';
  } else if (hasEmptyAccounts && !hasFeeSender && nativeLamports < 655240) {
    status = 'needs fee sender';
    reason = 'Needs Fee Sender to sponsor claim transactions';
  } else {
    // Executable
    status = 'ready';
    willKickstart = false; // Zero kickstart needed! Fee sender sponsors directly
    willClaim = hasEmptyAccounts;
    willSend = nativeLamports > 0;

    if (hasFeeSender) {
      // Fee sender sponsors transaction fees directly: 100% of rent + 100% of native SOL arrives in Main
      estimatedNetToMainLamports = lockedRentLamports + nativeLamports;
      reason = hasEmptyAccounts && nativeLamports > 0
        ? 'Will claim rent and sweep native balance to main'
        : hasEmptyAccounts
          ? 'Will claim rent directly to main'
          : 'Will sweep native balance to main';
    } else {
      // Target self-pays its fee
      estimatedNetToMainLamports = Math.max(0, lockedRentLamports + nativeLamports - BASE_SIGNATURE_FEE);
      reason = 'Will claim and sweep to main';
    }
  }

  return {
    ...walletInfo,
    needsKickstart: false,
    willKickstart: false,
    willClaim,
    willSend,
    status,
    reason,
    estimatedNetToMainLamports,
    estimatedNetToMainSol: estimatedNetToMainLamports / LAMPORTS_PER_SOL
  };
}

/**
 * Ultra-reliable transaction sender and confirmer with continuous rebroadcasting,
 * adaptive status polling, and automatic blockhash refresh retry.
 * Prevents "block height exceeded" errors under Solana network congestion.
 */
export async function sendAndConfirmTransactionRobust(connection, transaction, signers, options = {}) {
  const maxRetries = options.maxRetries ?? 2;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = signers[0].publicKey;

      // Clean signatures and sign fresh
      transaction.signatures = [];
      transaction.sign(...signers);
      const rawTx = transaction.serialize();

      // Broadcast raw transaction with preflight check on first send
      const signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 0
      });

      // Poll confirmation with periodic background rebroadcasts
      const startTime = Date.now();
      const timeoutMs = options.timeoutMs || 45000;

      while (Date.now() - startTime < timeoutMs) {
        const [statusRes, currentHeight] = await Promise.all([
          connection.getSignatureStatus(signature, { searchTransactionHistory: true }),
          connection.getBlockHeight('confirmed').catch(() => 0)
        ]);

        const status = statusRes?.value;
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
          if (status.err) {
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
          }
          return signature;
        }

        // Check if blockhash has expired
        if (currentHeight && currentHeight > lastValidBlockHeight) {
          throw new Error(`Transaction signature ${signature} has expired: block height exceeded`);
        }

        await sleep(1500);

        // Continuous rebroadcast so validator leaders don't drop the packet
        try {
          await connection.sendRawTransaction(rawTx, { skipPreflight: true });
        } catch {}
      }

      throw new Error(`Transaction confirmation timed out after ${timeoutMs / 1000}s`);
    } catch (err) {
      lastErr = err;
      const isFatalError =
        err.message?.includes('InvalidAccountForFee') ||
        err.message?.includes('custom program error');

      if (isFatalError) {
        throw err;
      }

      if (attempt < maxRetries) {
        await sleep(1200);
      }
    }
  }
  throw lastErr || new Error('Transaction confirmation timed out after retries');
}

/**
 * Execute atomic clean and sweep for a wallet.
 * Closes empty token accounts directly into mainAddress.
 * Sweeps any native balance directly into mainAddress.
 * Fee Sender acts as fee payer so target wallet never needs kickstart or gas!
 * Single atomic transaction per batch!
 */
export async function executeCleanWallet(connection, targetKeypair, emptyAccounts, mainAddress, feeSenderKeypair, onProgress) {
  const targetPubkey = targetKeypair.publicKey;
  const mainPubkey = new PublicKey(mainAddress);
  const isMain = targetPubkey.toBase58() === mainPubkey.toBase58();
  const isFeeSender = feeSenderKeypair && targetPubkey.toBase58() === feeSenderKeypair.publicKey.toBase58();

  const isSponsored = Boolean(feeSenderKeypair && feeSenderKeypair.publicKey.toBase58() !== targetPubkey.toBase58());

  // 1. Get fresh native balance of target
  let currentBalance = await withRpcRetry(() => connection.getBalance(targetPubkey, 'confirmed'), 3, 500);

  let totalReclaimedLamports = 0;
  let totalSentLamports = 0;
  let lastSignature = null;

  // Split empty accounts into batches of CLAIM_BATCH_SIZE (8)
  const batches = [];
  if (emptyAccounts && emptyAccounts.length > 0) {
    for (let i = 0; i < emptyAccounts.length; i += CLAIM_BATCH_SIZE) {
      batches.push(emptyAccounts.slice(i, i + CLAIM_BATCH_SIZE));
    }
  }

  // Case A: No empty accounts, only native balance to sweep
  if (batches.length === 0) {
    if (!isMain && !isFeeSender && currentBalance > 0) {
      let lamportsToSend = currentBalance;
      if (!isSponsored) {
        lamportsToSend = currentBalance - BASE_SIGNATURE_FEE;
      }
      if (lamportsToSend > 0) {
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 15000 }));
        tx.add(
          SystemProgram.transfer({
            fromPubkey: targetPubkey,
            toPubkey: mainPubkey,
            lamports: lamportsToSend
          })
        );
        const signers = isSponsored ? [feeSenderKeypair, targetKeypair] : [targetKeypair];
        lastSignature = await sendAndConfirmTransactionRobust(connection, tx, signers);
        totalSentLamports = lamportsToSend;
      }
    }
    return {
      success: totalSentLamports > 0,
      totalReclaimedLamports: 0,
      totalReclaimedSol: 0,
      totalSentLamports,
      totalSentSol: totalSentLamports / LAMPORTS_PER_SOL,
      signature: lastSignature
    };
  }

  // Case B: Has empty token accounts
  for (let bIndex = 0; bIndex < batches.length; bIndex++) {
    const batch = batches[bIndex];
    const isLastBatch = bIndex === batches.length - 1;

    const buildTx = (accList, includeNativeSweep = false) => {
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 15000 }));
      for (const acc of accList) {
        tx.add(
          createCloseAccountInstruction(
            new PublicKey(acc.pubkey),
            mainPubkey, // destination is Main directly!
            targetPubkey, // owner authority is Target
            [],
            new PublicKey(acc.programId)
          )
        );
      }
      if (includeNativeSweep && !isMain && !isFeeSender && currentBalance > 0) {
        let lamportsToSend = currentBalance;
        if (!isSponsored) {
          lamportsToSend = currentBalance - BASE_SIGNATURE_FEE;
        }
        if (lamportsToSend > 0) {
          tx.add(
            SystemProgram.transfer({
              fromPubkey: targetPubkey,
              toPubkey: mainPubkey,
              lamports: lamportsToSend
            })
          );
        }
      }
      return tx;
    };

    const signers = isSponsored ? [feeSenderKeypair, targetKeypair] : [targetKeypair];

    try {
      const tx = buildTx(batch, isLastBatch);
      lastSignature = await sendAndConfirmTransactionRobust(connection, tx, signers);

      const batchRent = batch.reduce((sum, item) => sum + (item.rentLamports || 2039280), 0);
      totalReclaimedLamports += batchRent;
      if (isLastBatch && !isMain && !isFeeSender && currentBalance > 0) {
        totalSentLamports = currentBalance;
      }

      if (onProgress) {
        onProgress({
          type: 'claim_batch_success',
          batchIndex: bIndex + 1,
          totalBatches: batches.length,
          closedCount: batch.length,
          reclaimedLamports: batchRent,
          signature: lastSignature
        });
      }
    } catch (batchErr) {
      // Fallback: Try closing accounts individually
      let indClosed = 0;
      let indRent = 0;
      for (const singleAcc of batch) {
        try {
          const singleTx = buildTx([singleAcc], false);
          const sig = await sendAndConfirmTransactionRobust(connection, singleTx, signers);
          const r = singleAcc.rentLamports || 2039280;
          indClosed++;
          indRent += r;
          totalReclaimedLamports += r;
          lastSignature = sig;
        } catch {}
      }

      // If native sweep was on the last batch, sweep it
      if (isLastBatch && !isMain && !isFeeSender && currentBalance > 0) {
        try {
          const sweepTx = new Transaction();
          sweepTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 15000 }));
          sweepTx.add(
            SystemProgram.transfer({
              fromPubkey: targetPubkey,
              toPubkey: mainPubkey,
              lamports: isSponsored ? currentBalance : currentBalance - BASE_SIGNATURE_FEE
            })
          );
          lastSignature = await sendAndConfirmTransactionRobust(connection, sweepTx, signers);
          totalSentLamports = currentBalance;
        } catch {}
      }

      if (indClosed > 0) {
        if (onProgress) {
          onProgress({
            type: 'claim_batch_success',
            batchIndex: bIndex + 1,
            totalBatches: batches.length,
            closedCount: indClosed,
            reclaimedLamports: indRent,
            signature: lastSignature
          });
        }
      } else {
        if (onProgress) {
          onProgress({
            type: 'claim_batch_failed',
            batchIndex: bIndex + 1,
            totalBatches: batches.length,
            error: batchErr.message
          });
        }
      }
    }
  }

  return {
    success: totalReclaimedLamports > 0 || totalSentLamports > 0,
    totalReclaimedLamports,
    totalReclaimedSol: totalReclaimedLamports / LAMPORTS_PER_SOL,
    totalSentLamports,
    totalSentSol: totalSentLamports / LAMPORTS_PER_SOL,
    signature: lastSignature
  };
}

/**
 * Execute kickstart transfer from fee sender to target.
 * feePayer = fee sender!
 * Amount = KICKSTART_LAMPORTS (800,000 lamports = 0.0008 SOL).
 */
export async function executeKickstart(connection, feeSenderKeypair, targetPublicKey, amountLamports) {
  let kickLamports = amountLamports || KICKSTART_LAMPORTS;

  const transaction = new Transaction();
  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 })
  );
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: feeSenderKeypair.publicKey,
      toPubkey: new PublicKey(targetPublicKey),
      lamports: kickLamports
    })
  );

  const signature = await sendAndConfirmTransactionRobust(
    connection,
    transaction,
    [feeSenderKeypair]
  );

  return {
    signature,
    amountLamports: kickLamports,
    amountSol: kickLamports / LAMPORTS_PER_SOL,
    feeLamports: BASE_SIGNATURE_FEE
  };
}

/**
 * Execute claim transactions for empty accounts in batches of up to 8.
 * feePayer = target wallet!
 * Close destination = target wallet!
 */
export async function executeClaim(connection, targetKeypair, emptyAccounts, onProgress) {
  const targetPubkey = targetKeypair.publicKey;
  const batches = [];

  for (let i = 0; i < emptyAccounts.length; i += CLAIM_BATCH_SIZE) {
    batches.push(emptyAccounts.slice(i, i + CLAIM_BATCH_SIZE));
  }

  const results = [];
  let totalReclaimedLamports = 0;

  for (let bIndex = 0; bIndex < batches.length; bIndex++) {
    const batch = batches[bIndex];

    const buildBatchTx = (accounts) => {
      const tx = new Transaction();
      for (const acc of accounts) {
        tx.add(
          createCloseAccountInstruction(
            new PublicKey(acc.pubkey),
            targetPubkey, // destination
            targetPubkey, // owner authority
            [],
            new PublicKey(acc.programId)
          )
        );
      }
      tx.feePayer = targetPubkey;
      return tx;
    };

    try {
      const tx = buildBatchTx(batch);
      const signature = await sendAndConfirmTransactionRobust(
        connection,
        tx,
        [targetKeypair]
      );

      const batchRent = batch.reduce((sum, item) => sum + (item.rentLamports || 2039280), 0);
      totalReclaimedLamports += batchRent;

      results.push({
        batchIndex: bIndex + 1,
        totalBatches: batches.length,
        closedCount: batch.length,
        reclaimedLamports: batchRent,
        signature,
        success: true
      });

      if (onProgress) {
        onProgress({
          type: 'claim_batch_success',
          batchIndex: bIndex + 1,
          totalBatches: batches.length,
          closedCount: batch.length,
          reclaimedLamports: batchRent,
          signature
        });
      }
    } catch (batchErr) {
      // Fallback: If a multi-account batch fails (e.g. 1 frozen/uninitialized account),
      // try closing each account individually so valid accounts still get reclaimed!
      if (batch.length > 1) {
        let individualClosed = 0;
        let individualRent = 0;

        for (const singleAcc of batch) {
          try {
            const singleTx = buildBatchTx([singleAcc]);
            const singleSig = await sendAndConfirmTransactionRobust(
              connection,
              singleTx,
              [targetKeypair]
            );
            const r = singleAcc.rentLamports || 2039280;
            individualClosed++;
            individualRent += r;
            totalReclaimedLamports += r;
          } catch (singleErr) {
            // Skip invalid/frozen token account
          }
        }

        if (individualClosed > 0) {
          results.push({
            batchIndex: bIndex + 1,
            totalBatches: batches.length,
            closedCount: individualClosed,
            reclaimedLamports: individualRent,
            success: true
          });

          if (onProgress) {
            onProgress({
              type: 'claim_batch_success',
              batchIndex: bIndex + 1,
              totalBatches: batches.length,
              closedCount: individualClosed,
              reclaimedLamports: individualRent
            });
          }
          continue;
        }
      }

      results.push({
        batchIndex: bIndex + 1,
        totalBatches: batches.length,
        closedCount: 0,
        error: batchErr.message,
        success: false
      });

      if (onProgress) {
        onProgress({
          type: 'claim_batch_failed',
          batchIndex: bIndex + 1,
          totalBatches: batches.length,
          error: batchErr.message
        });
      }
    }
  }

  return {
    results,
    totalReclaimedLamports,
    totalReclaimedSol: totalReclaimedLamports / LAMPORTS_PER_SOL
  };
}

/**
 * Execute sweep of all remaining SOL from target wallet to main wallet.
 * feePayer = target wallet!
 * Drains the wallet completely to exactly 0 lamports.
 * Uses atomic simulation calibration to guarantee that neither InsufficientFundsForRent
 * nor insufficient funds errors occur.
 */
export async function executeSend(connection, targetKeypair, mainAddress) {
  const targetPubkey = targetKeypair.publicKey;
  const mainPubkey = new PublicKey(mainAddress);

  if (targetPubkey.toBase58() === mainPubkey.toBase58()) {
    return {
      signature: null,
      sentLamports: 0,
      sentSol: 0,
      feeLamports: 0,
      message: 'Target wallet is main wallet; kept in place'
    };
  }

  const fee = BASE_SIGNATURE_FEE; // 5000 lamports

  // 1. Fetch fresh balance with 'confirmed' commitment
  let currentBalance = await withRpcRetry(() => connection.getBalance(targetPubkey, 'confirmed'), 3, 500);

  if (currentBalance <= fee) {
    return {
      signature: null,
      sentLamports: 0,
      sentSol: 0,
      feeLamports: 0,
      message: `Balance (${currentBalance} lamports) below network fee`
    };
  }

  let transferAmount = currentBalance - fee;

  const { blockhash } = await withRpcRetry(() => connection.getLatestBlockhash('confirmed'), 3, 500);

  const buildTx = (amt) => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: targetPubkey,
        toPubkey: mainPubkey,
        lamports: amt
      })
    );
    tx.feePayer = targetPubkey;
    tx.recentBlockhash = blockhash;
    return tx;
  };

  let tx = buildTx(transferAmount);

  // 2. Pre-simulate WITHOUT signing (sigVerify: false) to calibrate exact atomic balance
  try {
    const sim = await connection.simulateTransaction(tx, undefined, false);
    if (sim?.value?.preBalances && sim.value.preBalances[0] !== undefined) {
      const onChainBal = sim.value.preBalances[0];
      const onChainFee = sim.value.fee || BASE_SIGNATURE_FEE;
      if (onChainBal !== currentBalance || sim.value.err) {
        if (onChainBal <= onChainFee) {
          return {
            signature: null,
            sentLamports: 0,
            sentSol: 0,
            feeLamports: 0,
            message: `On-chain balance (${onChainBal} lamports) below network fee`
          };
        }
        transferAmount = onChainBal - onChainFee;
        tx = buildTx(transferAmount);
      }
    }
  } catch {}

  // 3. Sign transaction once cleanly
  tx.signatures = [];
  tx.sign(targetKeypair);

  // 4. Send raw transaction with skipPreflight: true (exact amount already pre-verified)
  const rawTx = tx.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: true,
    maxRetries: 3
  });

  // 5. Poll for confirmation with periodic rebroadcasts
  const startTime = Date.now();
  const timeoutMs = 30000;
  let confirmed = false;

  while (Date.now() - startTime < timeoutMs) {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    const conf = status?.value?.confirmationStatus;
    if (conf === 'confirmed' || conf === 'finalized') {
      if (status.value.err) {
        throw new Error(`Send failed on-chain: ${JSON.stringify(status.value.err)}`);
      }
      confirmed = true;
      break;
    }
    await sleep(1000);
    try {
      await connection.sendRawTransaction(rawTx, { skipPreflight: true });
    } catch {}
  }

  if (!confirmed) {
    const finalBal = await connection.getBalance(targetPubkey, 'confirmed');
    if (finalBal === 0) {
      confirmed = true;
    } else {
      throw new Error(`Send transaction confirmation timed out after 30s. Signature: ${signature}`);
    }
  }

  return {
    signature,
    sentLamports: transferAmount,
    sentSol: transferAmount / LAMPORTS_PER_SOL,
    feeLamports: fee
  };
}

/**
 * Fetch bulk native balances for an array of public keys using getMultipleAccountsInfo.
 * Up to 100 accounts per single RPC request.
 */
export async function fetchBulkNativeBalances(connection, publicKeys) {
  const map = new Map();
  const chunks = [];
  for (let i = 0; i < publicKeys.length; i += 100) {
    chunks.push(publicKeys.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    const pubkeys = chunk.map(pk => typeof pk === 'string' ? new PublicKey(pk) : pk);
    try {
      const infos = await withRpcRetry(() => connection.getMultipleAccountsInfo(pubkeys));
      for (let i = 0; i < pubkeys.length; i++) {
        const pkStr = pubkeys[i].toBase58();
        const lamports = infos[i]?.lamports || 0;
        map.set(pkStr, lamports);
      }
    } catch {
      for (const pk of pubkeys) {
        if (!map.has(pk.toBase58())) {
          map.set(pk.toBase58(), 0);
        }
      }
    }
  }

  return map;
}

/**
 * Fetch token accounts for a single wallet
 */
export async function fetchWalletTokenAccounts(connection, publicKeyStr, checkToken2022 = false) {
  const owner = new PublicKey(publicKeyStr);
  const emptyAccounts = [];

  const promises = [
    withRpcRetry(() => connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })).catch(() => ({ value: [] }))
  ];

  if (checkToken2022) {
    promises.push(
      withRpcRetry(() => connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })).catch(() => ({ value: [] }))
    );
  }

  const [splRes, t22Res] = await Promise.all(promises);

  for (const item of (splRes?.value || [])) {
    const info = item.account?.data?.parsed?.info;
    const amountStr = info?.tokenAmount?.amount;
    const closeAuth = info?.closeAuthority;
    const isOwnerCloseAuth = !closeAuth || closeAuth === publicKeyStr;
    const isNotDelegated = !info?.delegatedAmount || info.delegatedAmount?.amount === '0';
    const isNotNative = !info?.isNative;

    if (amountStr === '0' && info?.state !== 'frozen' && isOwnerCloseAuth && isNotDelegated && isNotNative) {
      emptyAccounts.push({
        pubkey: item.pubkey.toBase58(),
        programId: TOKEN_PROGRAM_ID.toBase58(),
        mint: info?.mint || 'unknown',
        rentLamports: item.account.lamports || 2039280
      });
    }
  }

  for (const item of (t22Res?.value || [])) {
    const info = item.account?.data?.parsed?.info;
    const amountStr = info?.tokenAmount?.amount;
    const closeAuth = info?.closeAuthority;
    const isOwnerCloseAuth = !closeAuth || closeAuth === publicKeyStr;
    const isNotDelegated = !info?.delegatedAmount || info.delegatedAmount?.amount === '0';
    const isNotNative = !info?.isNative;

    if (amountStr === '0' && info?.state !== 'frozen' && isOwnerCloseAuth && isNotDelegated && isNotNative) {
      emptyAccounts.push({
        pubkey: item.pubkey.toBase58(),
        programId: TOKEN_2022_PROGRAM_ID.toBase58(),
        mint: info?.mint || 'unknown',
        rentLamports: item.account.lamports || 2039280
      });
    }
  }

  const emptyCount = emptyAccounts.length;
  const lockedRentLamports = emptyAccounts.reduce((acc, a) => acc + a.rentLamports, 0);
  const claimBatchesCount = emptyCount > 0 ? Math.ceil(emptyCount / CLAIM_BATCH_SIZE) : 0;
  const estimatedClaimFeeLamports = claimBatchesCount * BASE_SIGNATURE_FEE;
  const estimatedSendFeeLamports = BASE_SIGNATURE_FEE;

  return {
    emptyAccountsCount: emptyCount,
    emptyAccounts,
    lockedRentLamports,
    lockedRentSol: lockedRentLamports / LAMPORTS_PER_SOL,
    claimBatchesCount,
    estimatedClaimFeeLamports,
    estimatedClaimFeeSol: estimatedClaimFeeLamports / LAMPORTS_PER_SOL,
    estimatedSendFeeLamports,
    estimatedSendFeeSol: estimatedSendFeeLamports / LAMPORTS_PER_SOL
  };
}

/**
 * Scan all wallets fast with bulk balance retrieval, controlled concurrency, and real-time progress callbacks.
 */
export async function scanWalletsFast(connection, validWallets, options = {}, onProgress) {
  const { feeSenderAddress, mainAddress, checkToken2022 = false } = options;
  const concurrency = Math.min(options.concurrency || 5, 5);

  // 1. Bulk native balances in chunks of 100 (super fast: 200ms)
  const allPubkeys = validWallets.map(w => w.publicKey);
  const balanceMap = await fetchBulkNativeBalances(connection, allPubkeys);

  const scannedResults = new Array(validWallets.length);
  let currentIndex = 0;
  let completedCount = 0;

  async function worker() {
    while (currentIndex < validWallets.length) {
      const idx = currentIndex++;
      const item = validWallets[idx];
      const pubkeyStr = item.publicKey;
      const nativeBalance = balanceMap.get(pubkeyStr) || 0;

      // Small pacing delay to prevent 429 burst blocking
      await sleep(50);

      try {
        const tokenInfo = await fetchWalletTokenAccounts(connection, pubkeyStr, checkToken2022);

        const walletInfo = {
          publicKey: pubkeyStr,
          nativeLamports: nativeBalance,
          nativeSol: nativeBalance / LAMPORTS_PER_SOL,
          ...tokenInfo
        };
        const decision = evaluateWalletDecision(walletInfo, feeSenderAddress, mainAddress);
        const fullWallet = {
          ...decision,
          lineNumber: item.lineNumber,
          secret: item.secret
        };

        scannedResults[idx] = fullWallet;
        completedCount++;

        if (onProgress) {
          onProgress({
            current: completedCount,
            total: validWallets.length,
            wallet: fullWallet
          });
        }
      } catch (err) {
        const fallbackWallet = {
          publicKey: pubkeyStr,
          lineNumber: item.lineNumber,
          secret: item.secret,
          nativeLamports: nativeBalance,
          nativeSol: nativeBalance / LAMPORTS_PER_SOL,
          emptyAccountsCount: 0,
          emptyAccounts: [],
          lockedRentLamports: 0,
          lockedRentSol: 0,
          needsKickstart: false,
          willKickstart: false,
          willClaim: false,
          willSend: false,
          status: 'failed',
          reason: `Scan error: ${err.message}`,
          estimatedNetToMainLamports: 0,
          estimatedNetToMainSol: 0
        };
        scannedResults[idx] = fallbackWallet;
        completedCount++;

        if (onProgress) {
          onProgress({
            current: completedCount,
            total: validWallets.length,
            wallet: fallbackWallet
          });
        }
      }
    }
  }

  const workers = [];
  const actualConcurrency = Math.min(concurrency, validWallets.length);
  for (let w = 0; w < actualConcurrency; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return scannedResults;
}

