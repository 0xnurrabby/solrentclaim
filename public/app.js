// Wallet Cleaner Frontend Application

const SOL_PRICE_USD = 119;

// State management
const state = {
  scannedWallets: [],
  totals: null,
  feeSender: null, // { secret, address, balanceSol, balanceLamports }
  isScanning: false,
  isPreviewing: false,
  isRunning: false,
  hasScanned: false,
  hasPreviewed: false,
  currentTableFilter: 'all',
  eligibilityThreshold: 0.0019
};

// DOM Elements
const el = {
  rpcUrl: document.getElementById('rpcUrl'),
  mainAddress: document.getElementById('mainAddress'),
  feeSenderSecret: document.getElementById('feeSenderSecret'),
  btnSaveFeeSender: document.getElementById('btnSaveFeeSender'),
  btnRemoveFeeSender: document.getElementById('btnRemoveFeeSender'),
  btnRefreshFeeSender: document.getElementById('btnRefreshFeeSender'),
  feeSenderInputGroup: document.getElementById('feeSenderInputGroup'),
  feeSenderStatusBox: document.getElementById('feeSenderStatusBox'),
  feeSenderDisplayAddress: document.getElementById('feeSenderDisplayAddress'),
  feeSenderDisplayBalance: document.getElementById('feeSenderDisplayBalance'),
  targetSecrets: document.getElementById('targetSecrets'),
  derivationIndex: document.getElementById('derivationIndex'),
  btnScan: document.getElementById('btnScan'),
  btnPreview: document.getElementById('btnPreview'),
  btnRun: document.getElementById('btnRun'),
  actionStatusText: document.getElementById('actionStatusText'),
  noticeBox: document.getElementById('noticeBox'),
  sectionTotals: document.getElementById('section-totals') || document.getElementById('sectionTotals'),
  sectionKeyCategories: document.getElementById('section-key-categories'),
  eligibilityThreshold: document.getElementById('eligibilityThreshold'),
  badgeEligibleCount: document.getElementById('badgeEligibleCount'),
  eligibleTotalRent: document.getElementById('eligibleTotalRent'),
  eligibleKeysTextarea: document.getElementById('eligibleKeysTextarea'),
  eligibleKeysFooterText: document.getElementById('eligibleKeysFooterText'),
  btnCopyEligibleKeys: document.getElementById('btnCopyEligibleKeys'),
  btnCopyEligibleAddresses: document.getElementById('btnCopyEligibleAddresses'),
  btnDownloadEligibleKeys: document.getElementById('btnDownloadEligibleKeys'),
  btnFilterTableEligible: document.getElementById('btnFilterTableEligible'),
  badgeIneligibleCount: document.getElementById('badgeIneligibleCount'),
  ineligibleTotalRent: document.getElementById('ineligibleTotalRent'),
  ineligibleKeysTextarea: document.getElementById('ineligibleKeysTextarea'),
  ineligibleKeysFooterText: document.getElementById('ineligibleKeysFooterText'),
  btnCopyIneligibleKeys: document.getElementById('btnCopyIneligibleKeys'),
  btnCopyIneligibleAddresses: document.getElementById('btnCopyIneligibleAddresses'),
  btnDownloadIneligibleKeys: document.getElementById('btnDownloadIneligibleKeys'),
  btnFilterTableIneligible: document.getElementById('btnFilterTableIneligible'),
  filterAllCount: document.getElementById('filterAllCount'),
  filterEligibleCount: document.getElementById('filterEligibleCount'),
  filterIneligibleCount: document.getElementById('filterIneligibleCount'),
  tableFilterGroup: document.getElementById('tableFilterGroup'),
  sectionTable: document.getElementById('section-table') || document.getElementById('sectionTable'),
  walletTableBody: document.getElementById('walletTableBody'),
  tableCountLabel: document.getElementById('tableCountLabel'),
  terminalBody: document.getElementById('terminalBody'),
  btnCopyLog: document.getElementById('btnCopyLog'),
  btnClearLog: document.getElementById('btnClearLog'),
  confirmModal: document.getElementById('confirmModal'),
  btnModalCancel: document.getElementById('btnModalCancel'),
  btnModalConfirm: document.getElementById('btnModalConfirm'),
  scanProgressBar: document.getElementById('scanProgressBar'),
  scanProgressFill: document.getElementById('scanProgressFill'),
  checkToken2022: document.getElementById('checkToken2022'),
  // Stats
  statWalletsFound: document.getElementById('statWalletsFound'),
  statEmptyAccounts: document.getElementById('statEmptyAccounts'),
  statLockedRent: document.getElementById('statLockedRent'),
  statLockedRentUsd: document.getElementById('statLockedRentUsd'),
  statNativeSol: document.getElementById('statNativeSol'),
  statNeedingKickstart: document.getElementById('statNeedingKickstart'),
  statTotalKickstart: document.getElementById('statTotalKickstart'),
  statClaimFees: document.getElementById('statClaimFees'),
  statSendFees: document.getElementById('statSendFees'),
  statFeeSenderNetwork: document.getElementById('statFeeSenderNetwork'),
  statExpectedAtMain: document.getElementById('statExpectedAtMain'),
  statExpectedAtMainUsd: document.getElementById('statExpectedAtMainUsd')
};

// Utilities
function showNotice(message, type = 'warning') {
  if (!message) {
    el.noticeBox.classList.add('hidden');
    el.noticeBox.textContent = '';
    return;
  }
  el.noticeBox.className = `notice-box ${type}`;
  el.noticeBox.textContent = message;
  el.noticeBox.classList.remove('hidden');
}

function clearNotice() {
  el.noticeBox.classList.add('hidden');
  el.noticeBox.textContent = '';
}

function appendLog(message, type = '') {
  const line = document.createElement('div');
  line.className = `terminal-line ${type}`.trim();

  const promptSpan = document.createElement('span');
  promptSpan.className = 'terminal-prompt';
  promptSpan.textContent = '$';

  const textSpan = document.createElement('span');
  textSpan.textContent = ` ${message}`;

  line.appendChild(promptSpan);
  line.appendChild(textSpan);
  el.terminalBody.appendChild(line);

  // Auto-scroll terminal to bottom
  el.terminalBody.scrollTop = el.terminalBody.scrollHeight;
}

function formatSol(val, decimals = 6) {
  const num = Number(val) || 0;
  return `${num.toFixed(decimals)} SOL`;
}

function formatUsd(val) {
  const num = (Number(val) || 0) * SOL_PRICE_USD;
  return `~$${num.toFixed(2)}`;
}

function truncateAddress(addr) {
  if (!addr || addr.length <= 10) return addr || '';
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

// Copy to clipboard helper
async function copyToClipboard(text, targetEl, feedbackText = 'Copied!') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (targetEl) {
      const orig = targetEl.innerHTML;
      targetEl.innerHTML = feedbackText;
      setTimeout(() => {
        targetEl.innerHTML = orig;
      }, 1500);
    }
  } catch (err) {
    console.error('Clipboard copy failed:', err);
  }
}

// Download text file helper
function downloadTextFile(filename, text) {
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Get wallet secret helper
function getWalletSecret(w) {
  if (w && w.secret) return w.secret;
  if (!w || !w.lineNumber) return '';
  const lines = (el.targetSecrets?.value || '').split(/\r?\n/);
  if (w.lineNumber <= lines.length) {
    let line = lines[w.lineNumber - 1].trim();
    const commentIdx = line.indexOf('#');
    if (commentIdx !== -1) line = line.substring(0, commentIdx).trim();
    return line;
  }
  return '';
}

// Fee Sender Management
async function loadSavedFeeSender() {
  const saved = sessionStorage.getItem('wallet_cleaner_fee_sender');
  if (saved) {
    try {
      const data = JSON.parse(saved);
      if (data && data.secret) {
        await saveFeeSender(data.secret, false);
      }
    } catch {
      sessionStorage.removeItem('wallet_cleaner_fee_sender');
    }
  }
}

async function saveFeeSender(secretInput, notify = true) {
  const secret = (secretInput || el.feeSenderSecret.value || '').trim();
  if (!secret) {
    showNotice('Please enter a secret key or phrase for the fee sender wallet.', 'warning');
    return;
  }

  const rpcUrl = el.rpcUrl.value.trim();
  const derivationIndex = Number(el.derivationIndex.value) || 0;

  try {
    el.btnSaveFeeSender.disabled = true;
    el.btnSaveFeeSender.textContent = 'Saving...';

    const res = await fetch('/api/fee-sender', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, derivationIndex, rpcUrl })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to save fee sender');
    }

    state.feeSender = {
      secret,
      address: data.address,
      balanceSol: data.balanceSol,
      balanceLamports: data.balanceLamports
    };

    sessionStorage.setItem('wallet_cleaner_fee_sender', JSON.stringify({ secret }));

    // Update UI
    el.feeSenderSecret.value = '';
    el.feeSenderInputGroup.classList.add('hidden');
    el.feeSenderStatusBox.classList.remove('hidden');
    el.btnSaveFeeSender.classList.add('hidden');
    el.btnRemoveFeeSender.classList.remove('hidden');
    el.btnRefreshFeeSender.classList.remove('hidden');

    el.feeSenderDisplayAddress.textContent = truncateAddress(data.address);
    el.feeSenderDisplayAddress.title = data.address;
    el.feeSenderDisplayBalance.textContent = formatSol(data.balanceSol, 4);

    if (notify) {
      appendLog(`Fee sender saved: ${truncateAddress(data.address)} (${formatSol(data.balanceSol, 4)})`);
      clearNotice();
    }
  } catch (err) {
    showNotice(`Fee sender error: ${err.message}`, 'error');
  } finally {
    el.btnSaveFeeSender.disabled = false;
    el.btnSaveFeeSender.textContent = 'Save fee sender';
  }
}

function removeFeeSender() {
  state.feeSender = null;
  sessionStorage.removeItem('wallet_cleaner_fee_sender');

  el.feeSenderSecret.value = '';
  el.feeSenderInputGroup.classList.remove('hidden');
  el.feeSenderStatusBox.classList.add('hidden');
  el.btnSaveFeeSender.classList.remove('hidden');
  el.btnRemoveFeeSender.classList.add('hidden');
  el.btnRefreshFeeSender.classList.add('hidden');

  appendLog('Fee sender removed.');
}

async function refreshFeeSenderBalance() {
  if (!state.feeSender || !state.feeSender.secret) return;
  await saveFeeSender(state.feeSender.secret, false);
}

// Render Summary Totals
function renderTotals(totals) {
  if (!totals) return;
  state.totals = totals;

  el.statWalletsFound.textContent = totals.walletsFound;
  el.statEmptyAccounts.textContent = totals.emptyAccounts;
  el.statLockedRent.textContent = formatSol(totals.lockedRentSol, 6);
  el.statLockedRentUsd.textContent = formatUsd(totals.lockedRentSol);
  el.statNativeSol.textContent = formatSol(totals.nativeSol, 6);
  el.statNeedingKickstart.textContent = totals.walletsNeedingKickstart;
  el.statTotalKickstart.textContent = formatSol(totals.totalKickstartOutSol, 6);
  el.statClaimFees.textContent = formatSol(totals.estimatedClaimFeesSol, 6);
  el.statSendFees.textContent = formatSol(totals.estimatedSendFeesSol, 6);
  el.statFeeSenderNetwork.textContent = formatSol(totals.estimatedFeeSenderNetworkFeesSol, 6);
  el.statExpectedAtMain.textContent = formatSol(totals.expectedSolAtMain, 6);
  el.statExpectedAtMainUsd.textContent = formatUsd(totals.expectedSolAtMain);

  el.sectionTotals?.classList.remove('hidden');
}

// Render Categorized Keys by Eligibility
function renderCategorizedKeys(wallets) {
  if (!wallets || wallets.length === 0) {
    el.sectionKeyCategories?.classList.add('hidden');
    return;
  }

  const threshold = Number(el.eligibilityThreshold?.value) || 0.0019;
  state.eligibilityThreshold = threshold;

  const eligible = [];
  const ineligible = [];

  for (const w of wallets) {
    const rent = w.lockedRentSol || 0;
    const isEligible = rent >= threshold || (threshold <= 0.00001 && (w.emptyAccountsCount || 0) > 0);
    if (isEligible) {
      eligible.push(w);
    } else {
      ineligible.push(w);
    }
  }

  // Eligible Group
  const eligibleKeys = eligible.map(w => getWalletSecret(w)).filter(Boolean);
  const eligibleAddresses = eligible.map(w => w.publicKey);
  const totalEligibleRent = eligible.reduce((acc, w) => acc + (w.lockedRentSol || 0), 0);

  if (el.badgeEligibleCount) el.badgeEligibleCount.textContent = `${eligible.length} Wallets`;
  if (el.eligibleTotalRent) el.eligibleTotalRent.textContent = `${totalEligibleRent.toFixed(6)} SOL locked (~$${(totalEligibleRent * SOL_PRICE_USD).toFixed(2)})`;
  if (el.eligibleKeysTextarea) el.eligibleKeysTextarea.value = eligibleKeys.join('\n');
  if (el.eligibleKeysFooterText) el.eligibleKeysFooterText.textContent = `${eligibleKeys.length} keys (holding ≥ ${threshold} SOL rent)`;

  // Ineligible Group
  const ineligibleKeys = ineligible.map(w => getWalletSecret(w)).filter(Boolean);
  const ineligibleAddresses = ineligible.map(w => w.publicKey);

  if (el.badgeIneligibleCount) el.badgeIneligibleCount.textContent = `${ineligible.length} Wallets`;
  if (el.ineligibleTotalRent) el.ineligibleTotalRent.textContent = `${ineligible.length} wallets (< ${threshold} SOL rent)`;
  if (el.ineligibleKeysTextarea) el.ineligibleKeysTextarea.value = ineligibleKeys.join('\n');
  if (el.ineligibleKeysFooterText) el.ineligibleKeysFooterText.textContent = `${ineligibleKeys.length} keys (< ${threshold} SOL rent)`;

  // Filter Pill Counts
  if (el.filterAllCount) el.filterAllCount.textContent = wallets.length;
  if (el.filterEligibleCount) el.filterEligibleCount.textContent = eligible.length;
  if (el.filterIneligibleCount) el.filterIneligibleCount.textContent = ineligible.length;

  el.sectionKeyCategories?.classList.remove('hidden');
}

// Render Wallet Table with Filter Support
function renderWalletTable(wallets, filter = state.currentTableFilter || 'all') {
  state.scannedWallets = wallets;
  state.currentTableFilter = filter;
  el.walletTableBody.innerHTML = '';

  if (!wallets || wallets.length === 0) {
    el.sectionTable?.classList.add('hidden');
    return;
  }

  const threshold = Number(el.eligibilityThreshold?.value) || 0.0019;

  let filteredWallets = wallets;
  if (filter === 'eligible') {
    filteredWallets = wallets.filter(w => (w.lockedRentSol || 0) >= threshold || (threshold <= 0.00001 && (w.emptyAccountsCount || 0) > 0));
  } else if (filter === 'ineligible') {
    filteredWallets = wallets.filter(w => !((w.lockedRentSol || 0) >= threshold || (threshold <= 0.00001 && (w.emptyAccountsCount || 0) > 0)));
  }

  el.tableCountLabel.textContent = `(Showing ${filteredWallets.length} of ${wallets.length})`;

  for (const w of filteredWallets) {
    const isEligible = (w.lockedRentSol || 0) >= threshold || (threshold <= 0.00001 && (w.emptyAccountsCount || 0) > 0);
    const tr = document.createElement('tr');
    tr.id = `wallet-row-${w.publicKey}`;

    // 1. Wallet address with copy pill
    const tdAddr = document.createElement('td');
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-pill';
    copyBtn.textContent = truncateAddress(w.publicKey);
    copyBtn.title = `Click to copy: ${w.publicKey}`;
    copyBtn.addEventListener('click', () => copyToClipboard(w.publicKey, copyBtn, 'Copied!'));
    tdAddr.appendChild(copyBtn);

    // 2. Eligibility tag
    const tdEligible = document.createElement('td');
    const elTag = document.createElement('span');
    elTag.className = `eligibility-tag ${isEligible ? 'eligible' : 'ineligible'}`;
    elTag.textContent = isEligible ? 'Eligible' : 'Ineligible';
    tdEligible.appendChild(elTag);

    // 3. Empty accounts count
    const tdEmpty = document.createElement('td');
    tdEmpty.textContent = w.emptyAccountsCount || 0;

    // 4. Locked rent SOL
    const tdLocked = document.createElement('td');
    tdLocked.className = 'mono-cell';
    tdLocked.textContent = formatSol(w.lockedRentSol, 5);

    // 5. Native SOL
    const tdNative = document.createElement('td');
    tdNative.className = 'mono-cell';
    tdNative.textContent = formatSol(w.nativeSol, 5);

    // 6. Estimated net to main
    const tdNet = document.createElement('td');
    tdNet.className = 'mono-cell';
    tdNet.textContent = formatSol(w.estimatedNetToMainSol, 5);

    // 7. Status
    const tdStatus = document.createElement('td');
    const badge = document.createElement('span');
    const badgeClass = (w.status || 'ready').toLowerCase().replace(/\s+/g, '-');
    badge.className = `status-badge ${badgeClass}`;
    badge.id = `badge-${w.publicKey}`;
    badge.textContent = w.status || 'ready';
    tdStatus.appendChild(badge);

    // 8. Key Action (Copy individual secret)
    const tdKey = document.createElement('td');
    const keyBtn = document.createElement('button');
    keyBtn.type = 'button';
    keyBtn.className = 'btn-row-key';
    keyBtn.textContent = 'Copy Key';
    keyBtn.title = 'Copy secret for this wallet';
    keyBtn.addEventListener('click', () => {
      const sec = getWalletSecret(w);
      if (sec) {
        copyToClipboard(sec, keyBtn, 'Copied!');
      } else {
        keyBtn.textContent = 'No key';
        setTimeout(() => { keyBtn.textContent = 'Copy Key'; }, 1500);
      }
    });
    tdKey.appendChild(keyBtn);

    tr.appendChild(tdAddr);
    tr.appendChild(tdEligible);
    tr.appendChild(tdEmpty);
    tr.appendChild(tdLocked);
    tr.appendChild(tdNative);
    tr.appendChild(tdNet);
    tr.appendChild(tdStatus);
    tr.appendChild(tdKey);

    el.walletTableBody.appendChild(tr);
  }

  el.sectionTable?.classList.remove('hidden');
}

// Update specific wallet row during Run
function updateWalletRow(update) {
  const badge = document.getElementById(`badge-${update.publicKey}`);
  const reason = document.getElementById(`reason-${update.publicKey}`);

  if (badge && update.status) {
    const badgeClass = update.status.toLowerCase().replace(/\s+/g, '-');
    badge.className = `status-badge ${badgeClass}`;
    badge.textContent = update.status;
  }

  if (reason && update.reason) {
    reason.textContent = update.reason;
  }
}

// Step 1: Scan Handler (Streaming Real-Time)
async function handleScan() {
  const secretsText = el.targetSecrets.value.trim();
  if (!secretsText) {
    showNotice('Please paste your target wallet private keys or seed phrases in the textarea.', 'warning');
    return;
  }

  const rpcUrl = el.rpcUrl.value.trim();
  const mainAddress = el.mainAddress.value.trim();
  const derivationIndex = Number(el.derivationIndex.value) || 0;
  const feeSenderAddress = state.feeSender?.address || null;
  const checkToken2022 = Boolean(el.checkToken2022?.checked);

  clearNotice();
  state.isScanning = true;
  el.btnScan.disabled = true;
  el.btnScan.textContent = 'Scanning...';
  el.actionStatusText.textContent = 'Starting fast scan...';

  el.scanProgressBar?.classList.remove('hidden');
  if (el.scanProgressFill) el.scanProgressFill.style.width = '0%';

  appendLog('Starting scan of target wallets...');

  try {
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rpcUrl,
        secretsText,
        derivationIndex,
        feeSenderAddress,
        mainAddress,
        checkToken2022,
        stream: true
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Scan failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalScanData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          try {
            const eventData = JSON.parse(trimmed.slice(6));
            if (eventData.type === 'log') {
              appendLog(eventData.message);
            } else if (eventData.type === 'scan_progress') {
              const pct = ((eventData.current / eventData.total) * 100).toFixed(0);
              if (el.scanProgressFill) el.scanProgressFill.style.width = `${pct}%`;
              el.actionStatusText.textContent = `Scanning: ${eventData.current} / ${eventData.total} (${pct}%)...`;
            } else if (eventData.type === 'scan_complete') {
              finalScanData = eventData;
            } else if (eventData.type === 'error') {
              appendLog(`Error: ${eventData.message}`, 'error');
              throw new Error(eventData.message);
            }
          } catch (jsonErr) {
            console.error('Failed to parse scan stream event:', jsonErr);
          }
        }
      }
    }

    if (finalScanData) {
      renderTotals(finalScanData.totals);
      renderCategorizedKeys(finalScanData.wallets);
      renderWalletTable(finalScanData.wallets);

      if (finalScanData.invalidLines && finalScanData.invalidLines.length > 0) {
        showNotice(`${finalScanData.invalidLines.length} line(s) were invalid and skipped. Check activity log.`, 'warning');
      }

      state.hasScanned = true;
      state.hasPreviewed = false;

      el.btnScan.classList.replace('btn-primary', 'btn-secondary');
      el.btnPreview.disabled = false;
      el.btnPreview.classList.replace('btn-secondary', 'btn-primary');
      el.btnRun.disabled = true;
      el.btnRun.classList.replace('btn-primary', 'btn-secondary');

      el.actionStatusText.textContent = `Scan complete (${finalScanData.wallets.length} wallets). Proceed to 2. Preview.`;
    }
  } catch (err) {
    showNotice(`Scan failed: ${err.message}`, 'error');
    appendLog(`Scan failed: ${err.message}`, 'error');
    el.actionStatusText.textContent = 'Scan failed.';
  } finally {
    state.isScanning = false;
    el.btnScan.disabled = false;
    el.btnScan.textContent = '1. Scan';
    setTimeout(() => {
      el.scanProgressBar?.classList.add('hidden');
    }, 1500);
  }
}

// Step 2: Preview Handler (Instant with Cached Wallets)
async function handlePreview() {
  const mainAddress = el.mainAddress.value.trim();
  if (!mainAddress) {
    showNotice('Please enter a valid Main destination address before previewing.', 'warning');
    el.mainAddress.focus();
    return;
  }

  const secretsText = el.targetSecrets.value.trim();
  const rpcUrl = el.rpcUrl.value.trim();
  const derivationIndex = Number(el.derivationIndex.value) || 0;
  const feeSenderAddress = state.feeSender?.address || null;

  clearNotice();
  state.isPreviewing = true;
  el.btnPreview.disabled = true;
  el.btnPreview.textContent = 'Previewing...';
  el.actionStatusText.textContent = 'Generating preview and validating fees...';

  appendLog('Generating preview with destination: ' + truncateAddress(mainAddress));

  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rpcUrl,
        secretsText,
        derivationIndex,
        feeSenderAddress,
        mainAddress,
        cachedWallets: state.scannedWallets
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Preview failed');
    }

    renderTotals(data.totals);
    renderCategorizedKeys(data.wallets);
    renderWalletTable(data.wallets);

    if (data.feeSenderWarning) {
      showNotice(data.feeSenderWarning, 'warning');
      appendLog(`Warning: ${data.feeSenderWarning}`, 'muted');
    }

    appendLog(`Preview ready. Total expected at main: ${formatSol(data.totals.expectedSolAtMain)}`);

    state.hasPreviewed = true;

    // Enable Run button
    el.btnPreview.classList.replace('btn-primary', 'btn-secondary');
    el.btnRun.disabled = false;
    el.btnRun.classList.replace('btn-secondary', 'btn-primary');

    el.actionStatusText.textContent = 'Preview verified. Ready to Run.';
  } catch (err) {
    showNotice(`Preview failed: ${err.message}`, 'error');
    appendLog(`Preview failed: ${err.message}`, 'error');
    el.actionStatusText.textContent = 'Preview failed.';
  } finally {
    state.isPreviewing = false;
    el.btnPreview.disabled = false;
    el.btnPreview.textContent = '2. Preview';
  }
}

// Step 3: Run Confirmation
function openConfirmModal() {
  if (!state.hasPreviewed) {
    showNotice('Please complete Preview before running.', 'warning');
    return;
  }
  el.confirmModal.classList.add('active');
}

function closeConfirmModal() {
  el.confirmModal.classList.remove('active');
}

// Execute Run via Streaming SSE
async function handleRunConfirmed() {
  closeConfirmModal();

  const mainAddress = el.mainAddress.value.trim();
  const secretsText = el.targetSecrets.value.trim();
  const rpcUrl = el.rpcUrl.value.trim();
  const derivationIndex = Number(el.derivationIndex.value) || 0;
  const feeSenderSecret = state.feeSender?.secret || null;

  clearNotice();
  state.isRunning = true;
  el.btnScan.disabled = true;
  el.btnPreview.disabled = true;
  el.btnRun.disabled = true;
  el.btnRun.textContent = 'Running...';
  el.actionStatusText.textContent = 'Executing cleanup operations...';

  appendLog('--- Execution started ---');

  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rpcUrl,
        secretsText,
        derivationIndex,
        feeSenderSecret,
        mainAddress
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Run failed (status ${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep uncompleted line

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          try {
            const eventData = JSON.parse(trimmed.slice(6));
            handleRunEvent(eventData);
          } catch (jsonErr) {
            console.error('Failed to parse event:', jsonErr);
          }
        }
      }
    }

    appendLog('--- Execution completed ---', 'success');
    el.actionStatusText.textContent = 'Execution finished.';
    // Refresh fee sender balance if configured
    if (state.feeSender) {
      refreshFeeSenderBalance();
    }
  } catch (err) {
    showNotice(`Run error: ${err.message}`, 'error');
    appendLog(`Run error: ${err.message}`, 'error');
    el.actionStatusText.textContent = 'Run error encountered.';
  } finally {
    state.isRunning = false;
    el.btnScan.disabled = false;
    el.btnPreview.disabled = false;
    el.btnRun.disabled = false;
    el.btnRun.textContent = '3. Run';
  }
}

// Process streaming events
function handleRunEvent(event) {
  switch (event.type) {
    case 'log':
      appendLog(event.message);
      break;
    case 'wallet_update':
      updateWalletRow(event);
      break;
    case 'error':
      appendLog(`Error: ${event.message}`, 'error');
      break;
    case 'done':
      appendLog('All tasks finished.');
      break;
    default:
      break;
  }
}

// Event Listeners
function initEventListeners() {
  el.btnSaveFeeSender.addEventListener('click', () => saveFeeSender());
  el.btnRemoveFeeSender.addEventListener('click', removeFeeSender);
  el.btnRefreshFeeSender.addEventListener('click', refreshFeeSenderBalance);

  el.btnScan.addEventListener('click', handleScan);
  el.btnPreview.addEventListener('click', handlePreview);
  el.btnRun.addEventListener('click', openConfirmModal);

  el.btnModalCancel.addEventListener('click', closeConfirmModal);
  el.btnModalConfirm.addEventListener('click', handleRunConfirmed);

  // Close modal on click outside
  el.confirmModal.addEventListener('click', (e) => {
    if (e.target === el.confirmModal) closeConfirmModal();
  });

  // Terminal buttons
  el.btnClearLog.addEventListener('click', () => {
    el.terminalBody.innerHTML = '';
    appendLog('Terminal cleared.');
  });

  el.btnCopyLog.addEventListener('click', () => {
    const text = el.terminalBody.innerText;
    copyToClipboard(text, el.btnCopyLog);
  });

  // Target secrets input change resets preview state
  el.targetSecrets.addEventListener('input', () => {
    if (state.hasScanned) {
      state.hasScanned = false;
      state.hasPreviewed = false;
      el.btnPreview.disabled = true;
      el.btnRun.disabled = true;
      el.btnScan.classList.replace('btn-secondary', 'btn-primary');
      el.btnPreview.classList.replace('btn-primary', 'btn-secondary');
      el.btnRun.classList.replace('btn-primary', 'btn-secondary');
      el.actionStatusText.textContent = 'Secrets changed. Please scan again.';
    }
  });

  // Categorized Keys Actions - Eligible
  el.btnCopyEligibleKeys?.addEventListener('click', () => {
    const val = el.eligibleKeysTextarea.value;
    if (val) copyToClipboard(val, el.btnCopyEligibleKeys, 'Copied Keys!');
  });

  el.btnCopyEligibleAddresses?.addEventListener('click', () => {
    const threshold = Number(el.eligibilityThreshold?.value) || 0.0019;
    const addrs = (state.scannedWallets || [])
      .filter(w => (w.lockedRentSol || 0) >= threshold || (threshold <= 0.00001 && (w.emptyAccountsCount || 0) > 0))
      .map(w => w.publicKey)
      .join('\n');
    if (addrs) copyToClipboard(addrs, el.btnCopyEligibleAddresses, 'Copied Addresses!');
  });

  el.btnDownloadEligibleKeys?.addEventListener('click', () => {
    const val = el.eligibleKeysTextarea.value;
    const count = val ? val.split('\n').filter(Boolean).length : 0;
    if (val) downloadTextFile(`eligible_keys_${count}_wallets.txt`, val);
  });

  el.btnFilterTableEligible?.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.filter-tab[data-filter="eligible"]')?.classList.add('active');
    renderWalletTable(state.scannedWallets, 'eligible');
    el.sectionTable?.scrollIntoView({ behavior: 'smooth' });
  });

  // Categorized Keys Actions - Ineligible
  el.btnCopyIneligibleKeys?.addEventListener('click', () => {
    const val = el.ineligibleKeysTextarea.value;
    if (val) copyToClipboard(val, el.btnCopyIneligibleKeys, 'Copied Keys!');
  });

  el.btnCopyIneligibleAddresses?.addEventListener('click', () => {
    const threshold = Number(el.eligibilityThreshold?.value) || 0.0019;
    const addrs = (state.scannedWallets || [])
      .filter(w => !((w.lockedRentSol || 0) >= threshold || (threshold <= 0.00001 && (w.emptyAccountsCount || 0) > 0)))
      .map(w => w.publicKey)
      .join('\n');
    if (addrs) copyToClipboard(addrs, el.btnCopyIneligibleAddresses, 'Copied Addresses!');
  });

  el.btnDownloadIneligibleKeys?.addEventListener('click', () => {
    const val = el.ineligibleKeysTextarea.value;
    const count = val ? val.split('\n').filter(Boolean).length : 0;
    if (val) downloadTextFile(`ineligible_keys_${count}_wallets.txt`, val);
  });

  el.btnFilterTableIneligible?.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.filter-tab[data-filter="ineligible"]')?.classList.add('active');
    renderWalletTable(state.scannedWallets, 'ineligible');
    el.sectionTable?.scrollIntoView({ behavior: 'smooth' });
  });

  // Threshold Quick Buttons
  document.querySelectorAll('.btn-threshold-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-threshold-quick').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const val = btn.dataset.val;
      if (el.eligibilityThreshold) el.eligibilityThreshold.value = val;
      renderCategorizedKeys(state.scannedWallets);
      renderWalletTable(state.scannedWallets);
    });
  });

  // Threshold Input Change
  el.eligibilityThreshold?.addEventListener('input', () => {
    document.querySelectorAll('.btn-threshold-quick').forEach(b => b.classList.remove('active'));
    renderCategorizedKeys(state.scannedWallets);
    renderWalletTable(state.scannedWallets);
  });

  // Table Filter Tabs
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const filter = tab.dataset.filter || 'all';
      renderWalletTable(state.scannedWallets, filter);
    });
  });
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  loadSavedFeeSender();
});
