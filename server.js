try {
  process.loadEnvFile();
} catch {}

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { parseSecret, parseSecretsText } from './src/key-utils.js';
import {
  createConnection,
  getNativeBalance,
  scanWalletAccounts,
  evaluateWalletDecision,
  executeKickstart,
  executeClaim,
  executeSend,
  executeCleanWallet,
  scanWalletsFast,
  fetchBulkNativeBalances,
  verifyCloseableAccounts,
  KICKSTART_LAMPORTS,
  BASE_SIGNATURE_FEE
} from './src/solana-cleaner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const HOST = '127.0.0.1';
const PORT = process.env.PORT || 4000;

// Host verification middleware: strictly localhost
app.use((req, res, next) => {
  const host = req.hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    return res.status(403).json({ error: 'Forbidden: Localhost only tool' });
  }
  next();
});

// JSON body parser with 2mb limit
app.use(express.json({ limit: '2mb' }));

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

/**
 * GET /api/config
 * Returns configured environment defaults (e.g. SOLANA_RPC_URL)
 */
app.get('/api/config', (req, res) => {
  res.json({
    defaultRpcUrl: process.env.SOLANA_RPC_URL || ''
  });
});

/**
 * Validate a Solana public address
 */
function isValidPublicKey(address) {
  if (!address || typeof address !== 'string') return false;
  try {
    const pub = new PublicKey(address.trim());
    return PublicKey.isOnCurve(pub.toBytes());
  } catch {
    return false;
  }
}

/**
 * Calculate aggregated summary totals across processed wallets
 */
function computeTotals(wallets) {
  let walletsFound = wallets.length;
  let emptyAccounts = 0;
  let lockedRentLamports = 0;
  let nativeLamports = 0;
  let walletsNeedingKickstart = 0;
  let estimatedClaimFeesLamports = 0;
  let estimatedSendFeesLamports = 0;
  let expectedSolAtMainLamports = 0;
  let readyCount = 0;

  for (const w of wallets) {
    emptyAccounts += w.emptyAccountsCount || 0;
    lockedRentLamports += w.lockedRentLamports || 0;
    nativeLamports += w.nativeLamports || 0;

    if (w.willKickstart) {
      walletsNeedingKickstart++;
    }
    if (w.willClaim) {
      estimatedClaimFeesLamports += w.estimatedClaimFeeLamports || 0;
    }
    if (w.willSend) {
      estimatedSendFeesLamports += w.estimatedSendFeeLamports || 0;
    }
    if (w.status === 'ready' || w.status === 'claimed' || w.status === 'sent') {
      expectedSolAtMainLamports += w.estimatedNetToMainLamports || 0;
      if (w.status === 'ready' && ((w.emptyAccountsCount || 0) > 0 || (w.nativeLamports || 0) > 0)) {
        readyCount++;
      }
    }
  }

  const totalKickstartOutLamports = walletsNeedingKickstart * KICKSTART_LAMPORTS;
  const estimatedFeeSenderNetworkFeesLamports = readyCount * BASE_SIGNATURE_FEE;

  return {
    walletsFound,
    emptyAccounts,
    lockedRentLamports,
    lockedRentSol: lockedRentLamports / LAMPORTS_PER_SOL,
    nativeLamports,
    nativeSol: nativeLamports / LAMPORTS_PER_SOL,
    walletsNeedingKickstart,
    totalKickstartOutLamports,
    totalKickstartOutSol: totalKickstartOutLamports / LAMPORTS_PER_SOL,
    estimatedClaimFeesLamports,
    estimatedClaimFeesSol: estimatedClaimFeesLamports / LAMPORTS_PER_SOL,
    estimatedSendFeesLamports,
    estimatedSendFeesSol: estimatedSendFeesLamports / LAMPORTS_PER_SOL,
    estimatedFeeSenderNetworkFeesLamports,
    estimatedFeeSenderNetworkFeesSol: estimatedFeeSenderNetworkFeesLamports / LAMPORTS_PER_SOL,
    expectedSolAtMainLamports,
    expectedSolAtMain: expectedSolAtMainLamports / LAMPORTS_PER_SOL
  };
}

/**
 * POST /api/fee-sender
 * Validates fee sender secret and checks current balance
 */
app.post('/api/fee-sender', async (req, res) => {
  try {
    const { secret, derivationIndex, rpcUrl } = req.body;
    if (!secret) {
      return res.status(400).json({ error: 'No secret provided' });
    }

    const keypair = parseSecret(secret, Number(derivationIndex) || 0);
    const pubkeyStr = keypair.publicKey.toBase58();

    const connection = createConnection(rpcUrl);
    const balanceLamports = await getNativeBalance(connection, keypair.publicKey);

    return res.json({
      valid: true,
      address: pubkeyStr,
      balanceLamports,
      balanceSol: balanceLamports / LAMPORTS_PER_SOL
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to parse fee sender secret' });
  }
});

/**
 * POST /api/scan
 * Scans all provided target wallets, checks balances and empty token accounts.
 * Never broadcasts any transaction.
 */
/**
 * POST /api/scan
 * Scans all provided target wallets fast with bulk balance retrieval and controlled concurrency.
 * Streams real-time progress events when requested.
 */
app.post('/api/scan', async (req, res) => {
  const { rpcUrl, secretsText, derivationIndex, feeSenderAddress, mainAddress, stream, checkToken2022 } = req.body;

  if (!secretsText || !secretsText.trim()) {
    return res.status(400).json({ error: 'Please paste at least one private key or seed phrase.' });
  }

  if (mainAddress && !isValidPublicKey(mainAddress)) {
    return res.status(400).json({ error: 'Invalid Main destination address format.' });
  }

  if (feeSenderAddress && !isValidPublicKey(feeSenderAddress)) {
    return res.status(400).json({ error: 'Invalid Fee Sender address format.' });
  }

  const dIndex = Number(derivationIndex) || 0;
  const { validWallets, invalidLines } = parseSecretsText(secretsText, dIndex);

  if (validWallets.length === 0 && invalidLines.length > 0) {
    return res.status(400).json({
      error: 'No valid private keys found in input.',
      invalidLines
    });
  }

  const connection = createConnection(rpcUrl);
  const isPublicRpc = !rpcUrl || rpcUrl.includes('api.mainnet-beta.solana.com');
  const concurrency = isPublicRpc ? 3 : 10;

  // If streaming is requested (or default for interactive UI)
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const emit = (type, payload) => {
      res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    };

    emit('log', { message: `Parsed ${validWallets.length} target wallet${validWallets.length === 1 ? '' : 's'}` });
    if (invalidLines.length > 0) {
      emit('log', { message: `Ignored ${invalidLines.length} invalid line${invalidLines.length === 1 ? '' : 's'}` });
    }

    if (isPublicRpc && validWallets.length > 30) {
      emit('log', { message: `[Notice] Using public Solana RPC (${concurrency} workers). For instant scan of ${validWallets.length} wallets, consider using a free Helius/QuickNode RPC.` });
    }

    emit('log', { message: 'Fetching native balances in bulk...' });

    try {
      const wallets = await scanWalletsFast(
        connection,
        validWallets,
        {
          feeSenderAddress,
          mainAddress,
          checkToken2022: Boolean(checkToken2022),
          concurrency,
          isPublicRpc
        },
        (prog) => {
          const w = prog.wallet;
          const shortAddr = `${w.publicKey.slice(0, 4)}...${w.publicKey.slice(-4)}`;
          emit('scan_progress', {
            current: prog.current,
            total: prog.total,
            wallet: w
          });
          if (w.emptyAccountsCount > 0) {
            emit('log', {
              message: `[${prog.current}/${prog.total}] ${shortAddr}: ${w.emptyAccountsCount} empty accounts (+${w.lockedRentSol.toFixed(5)} SOL rent)`
            });
          }
        }
      );

      const totals = computeTotals(wallets);
      emit('log', { message: `Scan complete: ${wallets.length} wallets processed. Found ${totals.emptyAccounts} empty accounts holding ${totals.lockedRentSol.toFixed(5)} SOL locked rent.` });
      emit('scan_complete', {
        wallets,
        totals,
        invalidLines
      });
      return res.end();
    } catch (err) {
      emit('error', { message: err.message || 'Scan failed' });
      return res.end();
    }
  }

  // Non-streaming fallback
  try {
    const wallets = await scanWalletsFast(
      connection,
      validWallets,
      {
        feeSenderAddress,
        mainAddress,
        checkToken2022: Boolean(checkToken2022),
        concurrency,
        isPublicRpc
      }
    );

    const totals = computeTotals(wallets);
    return res.json({
      success: true,
      wallets,
      totals,
      invalidLines
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Scan failed' });
  }
});

/**
 * POST /api/preview
 * Verifies totals, validates Main wallet address, and confirms fee sender sufficiency.
 * Uses cached scan results when available for instant (<10ms) responses.
 */
app.post('/api/preview', async (req, res) => {
  try {
    const { rpcUrl, secretsText, derivationIndex, feeSenderAddress, mainAddress, cachedWallets } = req.body;

    if (!mainAddress || !isValidPublicKey(mainAddress)) {
      return res.status(400).json({ error: 'A valid Main destination address is required before preview.' });
    }

    const connection = createConnection(rpcUrl);

    // Fast path: use already scanned wallet data from Step 1
    if (cachedWallets && Array.isArray(cachedWallets) && cachedWallets.length > 0) {
      const wallets = cachedWallets.map(w => {
        return evaluateWalletDecision(w, feeSenderAddress, mainAddress);
      });
      const totals = computeTotals(wallets);

      let feeSenderWarning = null;
      if (totals.walletsNeedingKickstart > 0) {
        if (!feeSenderAddress) {
          feeSenderWarning = `${totals.walletsNeedingKickstart} wallets need kickstart but no fee sender is configured.`;
        } else {
          const feeSenderBalance = await getNativeBalance(connection, feeSenderAddress);
          const requiredLamports = totals.totalKickstartOutLamports + totals.estimatedFeeSenderNetworkFeesLamports;
          if (feeSenderBalance < requiredLamports) {
            feeSenderWarning = `Fee sender balance (${(feeSenderBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL) is below the estimated required amount (${(requiredLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL).`;
          }
        }
      }

      return res.json({
        success: true,
        wallets,
        totals,
        invalidLines: [],
        feeSenderWarning
      });
    }

    // Fallback if not cached
    const dIndex = Number(derivationIndex) || 0;
    const { validWallets, invalidLines } = parseSecretsText(secretsText, dIndex);

    if (validWallets.length === 0) {
      return res.status(400).json({ error: 'No valid wallets to preview.' });
    }

    const isPublicRpc = !rpcUrl || rpcUrl.includes('api.mainnet-beta.solana.com');
    const wallets = await scanWalletsFast(
      connection,
      validWallets,
      {
        feeSenderAddress,
        mainAddress,
        concurrency: isPublicRpc ? 3 : 10
      }
    );

    const totals = computeTotals(wallets);

    let feeSenderWarning = null;
    if (totals.walletsNeedingKickstart > 0) {
      if (!feeSenderAddress) {
        feeSenderWarning = `${totals.walletsNeedingKickstart} wallets need kickstart but no fee sender is configured.`;
      } else {
        const feeSenderBalance = await getNativeBalance(connection, feeSenderAddress);
        const requiredLamports = totals.totalKickstartOutLamports + totals.estimatedFeeSenderNetworkFeesLamports;
        if (feeSenderBalance < requiredLamports) {
          feeSenderWarning = `Fee sender balance (${(feeSenderBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL) is below the estimated required amount (${(requiredLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL).`;
        }
      }
    }

    return res.json({
      success: true,
      wallets,
      totals,
      invalidLines,
      feeSenderWarning
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Preview failed' });
  }
});

/**
 * POST /api/run
 * Sequentially executes kickstart -> claim -> send for each wallet.
 * Uses HTTP stream (ndjson format) to deliver real-time progress logs to the frontend terminal.
 */
app.post('/api/run', async (req, res) => {
  const { rpcUrl, secretsText, derivationIndex, feeSenderSecret, mainAddress, cachedWallets } = req.body;

  if (!mainAddress || !isValidPublicKey(mainAddress)) {
    return res.status(400).json({ error: 'A valid Main destination address is required.' });
  }

  // Set up streaming response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Send SSE keep-alive ping every 3 seconds so the connection NEVER drops or times out
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 3000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });

  const emit = (type, payload) => {
    try {
      res.write(`data: ${JSON.stringify({ type, timestamp: new Date().toISOString(), ...payload })}\n\n`);
    } catch {}
  };

  try {
    const dIndex = Number(derivationIndex) || 0;
    const { validWallets, invalidLines } = parseSecretsText(secretsText, dIndex);

    emit('log', { message: `Parsed ${validWallets.length} target wallet${validWallets.length === 1 ? '' : 's'}` });

    if (invalidLines.length > 0) {
      emit('log', { message: `Ignored ${invalidLines.length} invalid secret line${invalidLines.length === 1 ? '' : 's'}` });
    }

    if (validWallets.length === 0) {
      emit('error', { message: 'No valid wallets to process.' });
      emit('done', {});
      return res.end();
    }

    // Parse fee sender if provided
    let feeSenderKeypair = null;
    let feeSenderPubkeyStr = null;
    if (feeSenderSecret && feeSenderSecret.trim()) {
      try {
        feeSenderKeypair = parseSecret(feeSenderSecret.trim(), dIndex);
        feeSenderPubkeyStr = feeSenderKeypair.publicKey.toBase58();
        emit('log', { message: `Fee sender loaded: ${feeSenderPubkeyStr.slice(0, 4)}...${feeSenderPubkeyStr.slice(-4)}` });
      } catch (err) {
        emit('log', { message: `Warning: Failed to parse fee sender key: ${err.message}` });
      }
    }

    const connection = createConnection(rpcUrl);

    // Build cached lookup map if available
    const cachedMap = new Map();
    if (cachedWallets && Array.isArray(cachedWallets)) {
      for (const w of cachedWallets) {
        if (w && w.publicKey) {
          cachedMap.set(w.publicKey, w);
        }
      }
    }

    // Process wallets sequentially
    for (let i = 0; i < validWallets.length; i++) {
      const item = validWallets[i];
      const targetKp = item.keypair;
      const targetPubkey = item.publicKey;
      const shortAddr = `${targetPubkey.slice(0, 4)}...${targetPubkey.slice(-4)}`;

      emit('wallet_start', { publicKey: targetPubkey, index: i + 1, total: validWallets.length });

      try {
        const cached = cachedMap.get(targetPubkey);

        // Fast-path: already processed or skipped
        if (cached && (cached.status === 'skip' || cached.status === 'needs fee sender')) {
          emit('log', { message: `[${i + 1}/${validWallets.length}] ${shortAddr} skipped: ${cached.reason || 'Not eligible'}` });
          emit('wallet_update', {
            publicKey: targetPubkey,
            status: cached.status,
            reason: cached.reason,
            emptyAccountsCount: cached.emptyAccountsCount || 0,
            nativeSol: cached.nativeSol || 0,
            lockedRentSol: cached.lockedRentSol || 0
          });
          continue;
        }

        if (cached && (cached.status === 'claimed' || cached.status === 'sent')) {
          emit('log', { message: `[${i + 1}/${validWallets.length}] ${shortAddr} already processed (${cached.status}), skipping.` });
          emit('wallet_update', {
            publicKey: targetPubkey,
            status: cached.status,
            reason: cached.reason
          });
          continue;
        }

        let walletInfo;
        if (cached && cached.emptyAccounts) {
          walletInfo = {
            ...cached,
            publicKey: targetPubkey
          };
        } else {
          emit('log', { message: `[${i + 1}/${validWallets.length}] Scanning ${shortAddr}...` });
          walletInfo = await scanWalletAccounts(connection, targetPubkey);
        }

        const decision = evaluateWalletDecision(walletInfo, feeSenderPubkeyStr, mainAddress);

        if (decision.status === 'skip' || decision.status === 'needs fee sender') {
          emit('log', { message: `${shortAddr} skipped: ${decision.reason}` });
          emit('wallet_update', {
            publicKey: targetPubkey,
            status: decision.status,
            reason: decision.reason,
            emptyAccountsCount: decision.emptyAccountsCount,
            nativeSol: decision.nativeSol,
            lockedRentSol: decision.lockedRentSol
          });
          continue;
        }

        emit('log', {
          message: `Cleaning ${shortAddr} (closing ${decision.emptyAccountsCount} accounts + sweeping ${(decision.nativeSol || 0).toFixed(6)} SOL)...`
        });

        const cleanResult = await executeCleanWallet(
          connection,
          targetKp,
          decision.emptyAccounts,
          mainAddress,
          feeSenderKeypair,
          (progress) => {
            if (progress.type === 'claim_batch_success') {
              emit('log', {
                message: `[${shortAddr}] Closed ${progress.closedCount} accounts (+${(progress.reclaimedLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`
              });
            } else if (progress.type === 'claim_batch_failed') {
              emit('log', {
                message: `[${shortAddr}] Batch failed: ${progress.error}`
              });
            }
          }
        );

        if (cleanResult.success) {
          const totalEarnedSol = (cleanResult.totalReclaimedLamports + cleanResult.totalSentLamports) / LAMPORTS_PER_SOL;
          emit('log', {
            message: `Successfully cleaned ${shortAddr}! Total sent to main: +${totalEarnedSol.toFixed(6)} SOL (tx: ${cleanResult.signature ? cleanResult.signature.slice(0, 8) + '...' : 'done'})`
          });
          emit('wallet_update', {
            publicKey: targetPubkey,
            status: cleanResult.totalSentLamports > 0 ? 'sent' : 'claimed',
            claimedSol: cleanResult.totalReclaimedSol,
            sentSol: cleanResult.totalSentSol,
            reason: `Done: +${totalEarnedSol.toFixed(6)} SOL to main (reclaimed ${cleanResult.totalReclaimedSol.toFixed(6)} SOL, swept ${cleanResult.totalSentSol.toFixed(6)} SOL)`
          });
        } else {
          emit('log', {
            message: `${shortAddr}: No accounts closed or SOL swept.`
          });
          emit('wallet_update', {
            publicKey: targetPubkey,
            status: 'skip',
            reason: 'Nothing to clean or sweep'
          });
        }
      } catch (walletErr) {
        emit('log', { message: `Error processing ${shortAddr}: ${walletErr.message}` });
        emit('wallet_update', {
          publicKey: targetPubkey,
          status: 'failed',
          reason: walletErr.message
        });
      }
    }

    emit('log', { message: 'All wallets processed successfully.' });
    emit('done', {});
    return res.end();
  } catch (err) {
    emit('error', { message: err.message });
    emit('done', {});
    return res.end();
  } finally {
    clearInterval(keepAlive);
  }
});

/**
 * POST /api/retry-send
 * Retries sending leftover SOL from a specific wallet to main
 */
app.post('/api/retry-send', async (req, res) => {
  try {
    const { rpcUrl, secret, derivationIndex, mainAddress, feeSenderSecret } = req.body;
    if (!secret) {
      return res.status(400).json({ error: 'Secret required for retry' });
    }
    if (!mainAddress || !isValidPublicKey(mainAddress)) {
      return res.status(400).json({ error: 'Valid Main destination address required' });
    }

    const dIndex = Number(derivationIndex) || 0;
    const keypair = parseSecret(secret, dIndex);
    const connection = createConnection(rpcUrl);

    let feeSenderKeypair = null;
    if (feeSenderSecret) {
      try {
        feeSenderKeypair = parseSecret(feeSenderSecret, 0);
      } catch {}
    }

    const result = await executeCleanWallet(connection, keypair, [], mainAddress, feeSenderKeypair);
    return res.json({
      success: true,
      signature: result.signature,
      sentSol: result.totalSentSol
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Retry send failed' });
  }
});

// Start server bound strictly to 127.0.0.1
app.listen(PORT, HOST, () => {
  console.log(`Wallet cleaner running on http://${HOST}:${PORT}`);
  console.log(`Bound strictly to ${HOST} (localhost only).`);
});
