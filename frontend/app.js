/* ==========================================================================
   VaxPass Front-End Architecture
   Decentralized Cold-Chain Vaccine Passport
   ========================================================================== */

const $ = (s) => document.querySelector(s);
const app = $("#app");

const STATUS = ["MANUFACTURED", "IN TRANSIT", "DELIVERED", "IN USE", "DEPLETED", "SPOILED", "RECALLED", "EXPIRED"];
const ROLE_LABELS = { 
  regulator: "Regulator", 
  manufacturer: "Manufacturer", 
  distributor: "Distributor", 
  clinic: "Clinic", 
  logger: "Temperature Logger" 
};
const ROLE_LANDING_ORDER = ["regulator", "manufacturer", "distributor", "clinic", "logger"];
const SENSOR_READINGS = { 
  normal: [[25, 5], [45, 5], [70, 5]], 
  spike: [[120, 3], [150, 3], [65, 5]], 
  breach: [[220, 20], [250, 20]] 
};

let config, read, walletProvider, write, account, activeRoles = [], roleIds = {}, rpcProvider;
let sensorFeed = [], selectedSensorBatch = 1, lastTransaction = null, livePoller = null, activity = [], checkpointId = null;
let mode = "live", activeDemoRole = "manufacturer";

/* ==========================================================================
   Utilities & Formatters
   ========================================================================== */

function short(a = "") { 
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"; 
}

function vx(id) { 
  return `VX${String(id).padStart(3, "0")}`; 
}

function date(seconds) { 
  return seconds ? new Date(Number(seconds) * 1000).toLocaleString() : "—"; 
}

function temp(x10) { 
  return `${(Number(x10) / 10).toFixed(1)} °C`; 
}

function escapeHtml(value = "") { 
  const e = document.createElement("span"); 
  e.textContent = String(value); 
  return e.innerHTML; 
}

function copyableAddress(a = "") {
  if (!a || a.match(/^0x0+$/)) return "—";
  return `<button type="button" class="address-chip" data-action="copy-address" data-address="${escapeHtml(a)}" title="Click to copy full address: ${escapeHtml(a)}">
    <span>${short(a)}</span>
    <svg class="copy-icon" viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
  </button>`;
}

function verificationUrl(id) {
  const configured = localStorage.getItem("vaxpassFrontendUrl");
  const base = (configured || location.href).split("#")[0].replace(/\/$/, "");
  return `${base}/#/verify/${id}`;
}

function isLocalFrontend() { 
  return ["localhost", "127.0.0.1"].includes(location.hostname); 
}

function toast(message, error = false) { 
  const el = document.createElement("div"); 
  el.className = `toast${error ? " error" : ""}`; 
  el.textContent = message; 
  $("#toastArea").append(el); 
  setTimeout(() => el.remove(), 4200); 
}

function friendly(error) {
  const m = error?.shortMessage || error?.reason || error?.message || "Transaction failed";
  return /user rejected|ACTION_REJECTED/i.test(m) ? "Transaction was cancelled in MetaMask." : m.replace(/^execution reverted: /, "");
}

function errorText(error) { 
  return String(error?.shortMessage || error?.reason || error?.info?.error?.message || error?.message || "Transaction failed"); 
}

function contractEnforcement(error) {
  const text = errorText(error);
  if (/user rejected|ACTION_REJECTED/i.test(text)) return null;
  const rules = [
    [/spoiled/i, "This batch is spoiled and cannot be used."],
    [/recalled|recall/i, "This batch was already recalled or cannot be recalled in its current state."],
    [/expired/i, "This batch has expired."],
    [/patient|duplicate|already administered|hash/i, "This patient identifier has already been administered for this batch."],
    [/role|unauthorized|not approved|accesscontrol/i, "This wallet does not have the approved role for this action."],
    [/status|transition|manufactured|custody|receipt/i, "The batch is not in the required status for this action."]
  ];
  const match = rules.find(rule => rule[0].test(text)); 
  return { 
    title: "Blocked by Smart Contract", 
    message: match ? match[1] : "The blockchain rejected this action because its safety rules were not satisfied.", 
    technical: text 
  };
}

function showShield(error) { 
  const card = contractEnforcement(error); 
  if (!card) return toast("Transaction cancelled in MetaMask.", false); 
  $("#shieldArea").innerHTML = `
    <div class="shield-card">
      <div class="shield-icon">!</div>
      <div>
        <b>${card.title}</b>
        <p>${escapeHtml(card.message)}</p>
        <small>${escapeHtml(card.technical)}</small>
      </div>
      <button class="icon-button" data-action="dismiss-shield" aria-label="Dismiss contract error">×</button>
    </div>
  `; 
  setTimeout(() => { if ($("#shieldArea")) $("#shieldArea").innerHTML = ""; }, 9000); 
}

function updateTxDrawer() { 
  const drawer = $("#txDrawer"); 
  if (!drawer || !lastTransaction) return; 
  drawer.innerHTML = `
    <div class="tx-drawer-head">
      <b>Last transaction</b>
      <button class="icon-button" data-action="dismiss-tx" aria-label="Close transaction drawer">×</button>
    </div>
    <p><b>${escapeHtml(lastTransaction.functionName)}</b> · ${escapeHtml(lastTransaction.role)}</p>
    <small>From ${short(lastTransaction.from)}</small>
    <small>Block ${lastTransaction.block} · Gas ${lastTransaction.gas}</small>
    <a href="#" class="tx-hash" title="Transaction hash">${short(lastTransaction.hash)}</a>
  `; 
  drawer.classList.add("visible"); 
}

function statusClass(batch) {
  const s = Number(batch.status), now = Math.floor(Date.now() / 1000);
  if (s === 5) return "spoiled"; 
  if (s === 6) return "recalled"; 
  if (s === 7 || Number(batch.effectiveExpiry) <= now) return "expired";
  if (s === 4) return "depleted";
  if (Number(batch.excursionBudgetMins) && Number(batch.excursionMinsUsed) * 2 > Number(batch.excursionBudgetMins)) return "risk";
  if (Number(batch.effectiveExpiry) - now < 7 * 86400) return "warning";
  return "safe";
}

function statusLabel(batch) {
  const cls = statusClass(batch);
  return cls === "safe" ? "Safe" : cls === "warning" ? "Expiring Soon" : cls === "risk" ? "At Risk" : STATUS[Number(batch.status)];
}

function badge(batch) { 
  return `<span class="badge ${statusClass(batch)}">${statusLabel(batch)}</span>`; 
}

function expiryAction(batch) { 
  const active = ![4, 5, 6, 7].includes(Number(batch.status)); 
  return active && Number(batch.effectiveExpiry) <= Math.floor(Date.now() / 1000) 
    ? `<button class="button danger" data-action="mark-expired" data-id="${batch.id}">Mark expired</button>` 
    : ""; 
}

function countdown(seconds) { 
  const diff = Math.max(0, Number(seconds) - Math.floor(Date.now() / 1000)); 
  const days = Math.floor(diff / 86400), hours = Math.floor(diff % 86400 / 3600), minutes = Math.floor(diff % 3600 / 60); 
  return diff ? `Expires in ${days}d ${hours}h ${minutes}m` : "Expired"; 
}

function expiryDifference(batch) { 
  const minutes = Math.round((Number(batch.printedExpiry) - Number(batch.effectiveExpiry)) / 60); 
  return minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"} removed by temperature excursions` : "No expiry time removed"; 
}

function stepper(batch) { 
  const status = Number(batch.status); 
  const steps = [["Manufacturer", true], ["Distributor", status >= 1], ["Clinic", status >= 2], ["Patient", status >= 3]]; 
  return `
    <div class="supply-stepper">
      ${steps.map((step, index) => `
        <div class="supply-step ${step[1] ? "complete" : ""} ${index === 0 && status === 0 || index === 1 && status === 1 || index === 2 && status === 2 || index === 3 && [3, 4].includes(status) ? "current" : ""}">
          <span>${step[1] ? "✓" : index + 1}</span>
          <b>${step[0]}</b>
        </div>
        ${index < steps.length - 1 ? `<i class="step-line ${step[1] && steps[index + 1][1] ? "complete" : ""}"></i>` : ""}
      `).join("")}
    </div>
  `; 
}

function emptyState(title, subtitle, actionHtml = "") {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">
        <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
          <path d="m3.3 7 8.7 5 8.7-5"/>
          <path d="M12 22V12"/>
        </svg>
      </div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(subtitle)}</p>
      ${actionHtml}
    </div>
  `;
}

function requireWallet() { 
  if (!write || !account) { 
    toast("Connect MetaMask to perform this action.", true); 
    return false; 
  } 
  return true; 
}

/* ==========================================================================
   Custom Popup Modal System (Replaces browser window.prompt / confirm)
   ========================================================================== */

function closeModal() {
  const container = $("#modalContainer");
  if (!container) return;
  container.classList.remove("active");
  container.setAttribute("aria-hidden", "true");
  setTimeout(() => {
    container.innerHTML = "";
  }, 220);
}

function promptModal({ title, subtitle, iconHtml, bodyHtml, confirmText = "Confirm", cancelText = "Cancel", isDanger = false, onMount }) {
  return new Promise((resolve) => {
    const container = $("#modalContainer");
    if (!container) return resolve(null);

    container.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div class="modal-icon-badge ${isDanger ? 'danger' : ''}">${iconHtml}</div>
          <div class="modal-title-group">
            <h2>${escapeHtml(title)}</h2>
            <p>${escapeHtml(subtitle)}</p>
          </div>
          <button type="button" class="modal-close-btn" data-modal-action="cancel" aria-label="Close modal">×</button>
        </div>
        <form id="customModalForm">
          <div class="modal-body">
            ${bodyHtml}
          </div>
          <div class="modal-footer">
            <button type="button" class="button light" data-modal-action="cancel">${escapeHtml(cancelText)}</button>
            <button type="submit" class="button ${isDanger ? 'danger' : 'teal'}" id="modalConfirmBtn">${escapeHtml(confirmText)}</button>
          </div>
        </form>
      </div>
    `;

    container.classList.add("active");
    container.setAttribute("aria-hidden", "false");

    const form = $("#customModalForm");
    const closeBtn = container.querySelector(".modal-close-btn");
    const cancelBtn = container.querySelector('[data-modal-action="cancel"]');

    let resolved = false;
    const cleanupAndResolve = (val) => {
      if (resolved) return;
      resolved = true;
      closeModal();
      document.removeEventListener("keydown", handleKeydown);
      resolve(val);
    };

    function handleKeydown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanupAndResolve(null);
      }
    }
    document.addEventListener("keydown", handleKeydown);

    container.onclick = (e) => {
      if (e.target === container) cleanupAndResolve(null);
    };

    cancelBtn?.addEventListener("click", () => cleanupAndResolve(null));
    closeBtn?.addEventListener("click", () => cleanupAndResolve(null));

    if (onMount) {
      onMount({
        resolve: cleanupAndResolve,
        form,
        confirmBtn: $("#modalConfirmBtn")
      });
    }
  });
}

function promptAddressModal({ title, subtitle, roleLabel, iconType = "distributor" }) {
  const iconSvg = iconType === "distributor"
    ? `<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13" rx="2"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`
    : `<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2z"/><path d="M9 10h6"/><path d="M12 7v6"/></svg>`;

  const bodyHtml = `
    <label for="modalAddressInput">
      ${escapeHtml(roleLabel)} Wallet Address
      <div class="input-with-button">
        <input id="modalAddressInput" name="address" required placeholder="0x…" autocomplete="off" spellcheck="false">
        <button type="button" id="modalPasteBtn" class="paste-chip-btn">📋 Paste</button>
      </div>
    </label>
    <div id="modalAddressFeedback" class="validation-feedback info">
      <span>Requires a 42-character Ethereum address (0x…)</span>
    </div>
    <div class="notice">
      <b>Smart contract access control:</b> The recipient wallet must have the <code>${escapeHtml(roleLabel)}</code> role approved by the Regulator on-chain.
    </div>
  `;

  return promptModal({
    title,
    subtitle,
    iconHtml: iconSvg,
    bodyHtml,
    confirmText: "Confirm Address",
    onMount: ({ resolve, form, confirmBtn }) => {
      const input = $("#modalAddressInput");
      const feedback = $("#modalAddressFeedback");
      const pasteBtn = $("#modalPasteBtn");

      function validate() {
        const val = input.value.trim();
        if (!val) {
          feedback.className = "validation-feedback info";
          feedback.innerHTML = "<span>Requires a 42-character Ethereum address (0x…)</span>";
          return false;
        }
        if (ethers.isAddress(val)) {
          feedback.className = "validation-feedback valid";
          feedback.innerHTML = `<span>✓ Valid Ethereum address (${short(val)})</span>`;
          return true;
        } else {
          feedback.className = "validation-feedback invalid";
          feedback.innerHTML = "<span>⚠ Invalid Ethereum address checksum or format</span>";
          return false;
        }
      }

      input.addEventListener("input", validate);
      input.focus();

      pasteBtn?.addEventListener("click", async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            input.value = text.trim();
            validate();
          }
        } catch {
          toast("Unable to read clipboard. Please paste manually.", true);
        }
      });

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const val = input.value.trim();
        if (ethers.isAddress(val)) {
          resolve(val);
        } else {
          validate();
          input.focus();
        }
      });
    }
  });
}

function promptPatientModal({ batchId }) {
  const iconSvg = `<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="11" r="3"/></svg>`;

  const bodyHtml = `
    <label for="modalPatientInput">
      Patient Identifier or Health Record ID
      <input id="modalPatientInput" name="patientId" required placeholder="e.g. PID-2026-9812 or NHS Record ID" autocomplete="off">
    </label>
    <div class="privacy-preview-box">
      <div class="privacy-preview-head">
        <span>Live keccak256 cryptographic preview</span>
        <span>🔒 Zero-Knowledge</span>
      </div>
      <div class="privacy-hash-display" id="modalHashDisplay">Type patient ID above to preview cryptographic hash</div>
      <p class="privacy-guarantee-note">
        <b>Patient Privacy Guarantee:</b> The patient ID is hashed locally with <code>keccak256</code> inside your browser. Only this 32-byte cryptographic hash is sent to the blockchain. The actual patient identity is never stored on-chain.
      </p>
    </div>
  `;

  return promptModal({
    title: `Administer Vaccine Dose`,
    subtitle: `Batch ${vx(batchId)} · Zero-Knowledge Patient Anonymity`,
    iconHtml: iconSvg,
    bodyHtml,
    confirmText: "Administer & Submit Hash",
    onMount: ({ resolve, form }) => {
      const input = $("#modalPatientInput");
      const hashDisplay = $("#modalHashDisplay");

      function updateHash() {
        const val = input.value.trim();
        if (val) {
          const hash = ethers.keccak256(ethers.toUtf8Bytes(val));
          hashDisplay.textContent = hash;
          hashDisplay.style.color = "var(--blue)";
        } else {
          hashDisplay.textContent = "Type patient ID above to preview cryptographic hash";
          hashDisplay.style.color = "var(--muted)";
        }
      }

      input.addEventListener("input", updateHash);
      input.focus();

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const val = input.value.trim();
        if (val) resolve(val);
      });
    }
  });
}

function promptUrlModal({ currentUrl }) {
  const iconSvg = `<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`;

  const bodyHtml = `
    <label for="modalUrlInput">
      Frontend URL accessible from phone cameras
      <input id="modalUrlInput" name="url" required value="${escapeHtml(currentUrl)}" placeholder="http://192.168.0.106:8080">
    </label>
    <div id="modalUrlFeedback" class="validation-feedback info">
      <span>Must begin with http:// or https://</span>
    </div>
    <div class="notice">
      <b>Tip:</b> If viewing from a phone on the same Wi-Fi, enter your computer's local network IP address (e.g. <code>http://192.168.1.50:8080</code>).
    </div>
  `;

  return promptModal({
    title: "Configure Verification Endpoint",
    subtitle: "Set the base URL encoded into the public batch QR code",
    iconHtml: iconSvg,
    bodyHtml,
    confirmText: "Save Destination URL",
    onMount: ({ resolve, form }) => {
      const input = $("#modalUrlInput");
      const feedback = $("#modalUrlFeedback");
      input.focus();
      input.select();

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const val = input.value.trim();
        try {
          const url = new URL(val);
          if (!/^https?:$/.test(url.protocol)) throw new Error();
          resolve(url.origin);
        } catch {
          feedback.className = "validation-feedback invalid";
          feedback.innerHTML = "<span>⚠ Enter a valid http:// or https:// URL format</span>";
          input.focus();
        }
      });
    }
  });
}

function confirmModal({ title, message, confirmText = "Confirm", cancelText = "Cancel", isDanger = false }) {
  const iconSvg = isDanger
    ? `<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
    : `<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;

  const bodyHtml = `
    <p style="margin: 0; font-size: 0.95rem; line-height: 1.5; color: var(--ink-secondary);">
      ${escapeHtml(message)}
    </p>
  `;

  return promptModal({
    title,
    subtitle: isDanger ? "Destructive Action Confirmation" : "Please confirm your action",
    iconHtml: iconSvg,
    bodyHtml,
    confirmText,
    cancelText,
    isDanger,
    onMount: ({ resolve, form }) => {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        resolve(true);
      });
    }
  });
}

/* ==========================================================================
   Initialization & Web3 Connection
   ========================================================================== */

async function init() {
  config = await fetch("contract.json").then(r => r.json());
  if (!config.address || !config.abi?.length) { 
    app.innerHTML = `<div class="notice danger">No deployment found. Start a local node and run the deploy script first.</div>`; 
    return; 
  }
  
  const localRpcHost = ["localhost", "127.0.0.1"].includes(location.hostname) ? "127.0.0.1" : location.hostname;
  const rpcUrl = localStorage.getItem("vaxpassRpc") || (Number(config.chainId) === 11155111 ? "https://ethereum-sepolia-rpc.publicnode.com" : `http://${localRpcHost}:8545`);
  rpcProvider = new ethers.JsonRpcProvider(rpcUrl);
  read = new ethers.Contract(config.address, config.abi, rpcProvider);
  
  roleIds = {
    manufacturer: await read.MANUFACTURER_ROLE(), 
    distributor: await read.DISTRIBUTOR_ROLE(),
    clinic: await read.CLINIC_ROLE(), 
    logger: await read.LOGGER_ROLE(), 
    regulator: await read.REGULATOR_ROLE()
  };

  $("#connectButton")?.addEventListener("click", connect);
  $("#menuButton")?.addEventListener("click", () => $("#nav")?.classList.toggle("open"));
  
  updateModeControls();
  window.addEventListener("hashchange", render);
  
  if (window.ethereum) { 
    window.ethereum.on("accountsChanged", handleAccountChanged); 
    window.ethereum.on("chainChanged", () => window.location.reload()); 
    if ((await window.ethereum.request({ method: "eth_accounts" })).length) {
      await connect(false); 
    }
  }

  bindEvents(); 
  bindPolishEvents(); 
  startLiveUpdates(); 
  render();
}

function updateModeControls() {
  const connectBtn = $("#connectButton");
  if (connectBtn) {
    connectBtn.innerHTML = `
      <svg class="wallet-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="3"/><path d="M18 12h.01"/><path d="M2 10h20"/></svg>
      <span>${account ? short(account) : "Connect wallet"}</span>
    `;
    if (account) {
      connectBtn.classList.add("connected");
      connectBtn.title = `Connected: ${account}`;
    } else {
      connectBtn.classList.remove("connected");
    }
  }

  const networkName = $("#networkName");
  const networkChip = $("#networkChip");
  if (networkName && config) {
    const chainId = Number(config.chainId);
    const label = chainId === 31337 ? "Hardhat (31337)" : chainId === 11155111 ? "Sepolia (11155111)" : `Chain ID ${chainId}`;
    networkName.textContent = label;
    if (networkChip) {
      networkChip.classList.remove("disconnected");
      networkChip.title = `Connected to Ethereum ${label}`;
    }
  }
}

function applyPreset(name) { 
  const preset = { covid: ["DemoVax", 100, 2, 8, 30], cold: ["ColdStorageVax", 50, 2, 8, 20] }[name]; 
  if (!preset) return; 
  $("#vaccineName").value = preset[0]; 
  $("#doses").value = preset[1]; 
  $("#minTemp").value = preset[2]; 
  $("#maxTemp").value = preset[3]; 
  $("#budget").value = preset[4]; 
  const expiry = new Date(Date.now() + 90 * 86400000); 
  expiry.setMinutes(expiry.getMinutes() - expiry.getTimezoneOffset()); 
  $("#printedExpiry").value = expiry.toISOString().slice(0, 16); 
}

function bindPolishEvents() { 
  document.addEventListener("click", e => { 
    const action = e.target.dataset.action; 
    if (action === "verify-chip") { 
      $("#verifyId").value = `VX${String(e.target.dataset.id).padStart(3, "0")}`; 
      return verify(e.target.dataset.id); 
    } 
    if (action === "request-role") { 
      if (!requireWallet()) return; 
      return tx(write.requestRole(roleIds[e.target.dataset.role]), "Role request submitted.", "requestRole"); 
    } 
  }); 
  document.addEventListener("change", e => { 
    if (e.target.id === "batchPreset") applyPreset(e.target.value); 
  }); 
}

async function connect(request = true) {
  if (!window.ethereum) return toast("MetaMask was not detected. Install its browser extension first.", true);
  try {
    walletProvider = new ethers.BrowserProvider(window.ethereum);
    if (request) await walletProvider.send("eth_requestAccounts", []);
    const network = await walletProvider.getNetwork();
    if (Number(network.chainId) !== Number(config.chainId)) {
      toast(`Wrong network: switch MetaMask to chain ID ${config.chainId}.`, true); 
      return;
    }
    const signer = await walletProvider.getSigner(); 
    account = await signer.getAddress(); 
    write = read.connect(signer);
    activeRoles = [];
    for (const [key, id] of Object.entries(roleIds)) {
      if (await read.hasRole(id, account)) activeRoles.push(key);
    }
    updateModeControls();
    const route = location.hash.replace(/^#\/?/, "").split("/")[0];
    const requiredRole = { regulator: "regulator", manufacturer: "manufacturer", distributor: "distributor", clinic: "clinic", sensor: "logger" }[route];
    const nextRole = ROLE_LANDING_ORDER.find(role => activeRoles.includes(role));
    if (requiredRole && !activeRoles.includes(requiredRole) && nextRole) {
      location.hash = `#/${nextRole === "logger" ? "sensor" : nextRole}`;
    }
    toast("Wallet connected."); 
    render();
  } catch (e) { 
    toast(friendly(e), true); 
  }
}

async function handleAccountChanged(accounts) { 
  if (!accounts.length) { 
    account = null; 
    write = null; 
    activeRoles = []; 
    updateModeControls(); 
    location.hash = "#/"; 
    return render(); 
  } 
  await connect(false); 
  const nextRole = ROLE_LANDING_ORDER.find(role => activeRoles.includes(role)); 
  if (nextRole) location.hash = `#/${nextRole === "logger" ? "sensor" : nextRole}`; 
}

async function tx(promise, success = "Transaction confirmed.", functionName = "Transaction", rerender = true) { 
  try { 
    toast("Pending: waiting for blockchain confirmation…"); 
    const t = await promise; 
    const receipt = await t.wait(); 
    lastTransaction = { 
      hash: receipt.hash, 
      block: receipt.blockNumber, 
      gas: receipt.gasUsed?.toString() || "—", 
      functionName, 
      from: account, 
      role: ROLE_LABELS[activeRoles[0]] || "Wallet" 
    }; 
    updateTxDrawer(); 
    toast(`${success} ${short(receipt.hash)} · block ${receipt.blockNumber}`); 
    if (rerender) await render(); 
    return receipt; 
  } catch (e) { 
    showShield(e); 
    return null; 
  } 
}

async function batches() {
  const stats = await read.getStats();
  const count = Number(stats.totalBatches);
  return Promise.all(Array.from({ length: count }, (_, i) => read.getBatch(i + 1)));
}

function batchCard(b, actions = "") {
  const pct = Number(b.excursionBudgetMins) ? Math.min(100, Math.round(Number(b.excursionMinsUsed) * 100 / Number(b.excursionBudgetMins))) : 0;
  return `
    <article class="card">
      <div class="row-head">
        <div>
          <p class="batch-title">${vx(b.id)} · ${escapeHtml(b.vaccineName)}</p>
          <small>${escapeHtml(b.lotNumber)} · <b>${Number(b.dosesRemaining)}</b>/${Number(b.totalDoses)} doses left</small>
        </div>
        ${badge(b)}
      </div>
      <div class="batch-meta">
        <div><small>Current Custodian</small>${copyableAddress(b.custodian)}</div>
        <div><small>Effective Expiry</small><b>${date(b.effectiveExpiry)}</b></div>
      </div>
      <div>
        <div class="gauge-label">
          <span>Excursion budget</span>
          <span><b>${b.excursionMinsUsed}</b> / ${b.excursionBudgetMins} mins</span>
        </div>
        <div class="progress ${Number(b.status) === 5 ? 'gauge-danger' : pct >= 50 ? 'gauge-warn' : 'gauge-safe'}">
          <i style="width:${pct}%"></i>
        </div>
      </div>
      <div class="actions">
        <a class="button light" href="#/batch/${b.id}">Passport</a>
        ${expiryAction(b)}
        ${actions}
      </div>
    </article>
  `;
}

function page(title, subtitle, content, action = "") { 
  return `<section class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</section>${content}`; 
}

/* ==========================================================================
   Views & Routing
   ========================================================================== */

async function render() {
  try {
    const parts = location.hash.replace(/^#\/?/, "").split("/"); 
    const route = parts[0] || "";
    $("#nav")?.classList.remove("open");
    
    document.querySelectorAll("#nav a").forEach(link => { 
      const target = link.getAttribute("href").replace(/^#\/?/, ""); 
      link.classList.toggle("active", target === route || (!route && !target)); 
    });

    const requiredRole = { regulator: "regulator", manufacturer: "manufacturer", distributor: "distributor", clinic: "clinic", sensor: "logger" }[route];
    if (requiredRole && !activeRoles.includes(requiredRole)) return renderAccessDenied(requiredRole);

    if (route === "register") await renderRegister(); 
    else if (route === "regulator") await renderRegulator();
    else if (route === "manufacturer") await renderManufacturer(); 
    else if (route === "distributor") await renderDistributor();
    else if (route === "clinic") await renderClinic(); 
    else if (route === "sensor") await renderSensorConsole(Number(parts[1])); 
    else if (route === "batch") await renderBatch(Number(parts[1]));
    else if (route === "verify") await renderVerify(Number(parts[1])); 
    else if (route === "analytics") await renderAnalytics(); 
    else await renderHome();
  } catch (e) { 
    app.innerHTML = `<div class="notice danger">Unable to read the blockchain: ${escapeHtml(friendly(e))}</div>`; 
  }
}

function renderAccessDenied(role) { 
  const label = ROLE_LABELS[role] || "required"; 
  const localHint = Number(config.chainId) === 31337 && role === "logger" 
    ? `<p><b>Local seeded Logger:</b> Hardhat account #4 ending in <span class="address">…6A65</span>. A MetaMask account label does not grant an on-chain role.</p>` 
    : ""; 
  const request = role === "logger" ? `<button class="button teal" data-action="request-role" data-role="logger">Request Logger role</button>` : ""; 
  
  app.innerHTML = page("Access restricted", `This workspace requires the approved ${label} role.`, `
    <div class="notice danger">
      <b>RBAC enforcement</b>
      <p>Connected account: ${copyableAddress(account)}. This address does not have the on-chain ${label} role.</p>
      ${localHint}
    </div>
    <div class="actions">
      ${request}
      <button class="button teal" data-action="connect">Recheck MetaMask account</button>
      <a class="button light" href="#/register">Request a role</a>
      <a class="button light" href="#/">Return home</a>
    </div>
  `); 
}

async function renderHome() {
  const list = await batches(); 
  const recent = list.slice(-3).reverse();
  
  app.innerHTML = `
    <section class="hero">
      <div class="eyebrow">Cold-Chain Blockchain Passport</div>
      <h1>A tamper-evident passport for every vaccine batch.</h1>
      <p>VaxPass records custodian handovers, temperature excursions, dynamic expiry reduction, and zero-knowledge dose administration on Ethereum.</p>
      <div class="hero-badges">
        <span>🛡️ On-Chain Role Custody</span>
        <span>❄️ Real-Time Excursion Burn-down</span>
        <span>🔒 Zero-Knowledge Patient Privacy</span>
      </div>
      <div class="hero-actions">
        <a class="button teal" href="#/verify">Verify a Batch</a>
        <button class="button light" data-action="connect">${account ? `Connected (${short(account)})` : "Connect Wallet"}</button>
      </div>
    </section>

    <section class="grid three" style="margin:24px 0">
      <a class="card quick" href="#/manufacturer">
        <div><b>Register a Batch</b><br><small class="muted">Manufacturer initialization</small></div>
        <span>→</span>
      </a>
      <a class="card quick" href="#/distributor">
        <div><b>Track Custody</b><br><small class="muted">Dual-handover in transit</small></div>
        <span>→</span>
      </a>
      <a class="card quick" href="#/clinic">
        <div><b>Administer Safely</b><br><small class="muted">Private hashed dose log</small></div>
        <span>→</span>
      </a>
    </section>

    ${page("Recent Batches", "Live data from the configured Ethereum network.", `
      <div class="grid three">
        ${recent.length ? recent.map(b => batchCard(b)).join("") : emptyState("No vaccine batches yet", "Register a new batch from the Manufacturer workspace to begin tracking.", '<a class="button teal" href="#/manufacturer">Register First Batch</a>')}
      </div>
    `)}
    ${activityTicker()}
  `;
}

function activityTicker() { 
  return `
    <section class="card activity-card">
      <div class="section-heading">
        <div>
          <span class="stat-kicker">Live blockchain activity</span>
          <h2>Recent network events</h2>
        </div>
        <span class="role-chip">Auto-updating</span>
      </div>
      <div class="activity-list">
        ${activity.length ? activity.slice(0, 8).map(item => `
          <div class="activity-item">
            <span class="activity-dot"></span>
            <div>
              <b>${escapeHtml(item.name)}</b>
              <span>${item.id ? ` · ${vx(item.id)}` : ""}</span>
              <p>${short(item.actor)} · ${item.time}</p>
            </div>
          </div>
        `).join("") : `<p class="empty">Waiting for blockchain activity.</p>`}
      </div>
    </section>
  `; 
}

function addActivity(name, id, actor) { 
  activity.unshift({ name, id, actor, time: new Date().toLocaleTimeString() }); 
  activity = activity.slice(0, 20); 
}

function refreshHighlight() { 
  app.classList.remove("live-flash"); 
  void app.offsetWidth; 
  app.classList.add("live-flash"); 
  setTimeout(() => app.classList.remove("live-flash"), 900); 
}

function eventActor(name, args) { 
  if (name === "BatchRegistered") return args[2]; 
  if (name === "CustodyTransferred") return args[1]; 
  if (name === "ReceiptConfirmed") return args[1]; 
  if (name === "DoseAdministered") return args[2]; 
  return account; 
}

function startLiveUpdates() {
  const events = ["BatchRegistered", "CustodyTransferred", "ReceiptConfirmed", "TemperatureLogged", "ExcursionDetected", "BatchSpoiled", "BatchRecalled", "DoseAdministered", "BatchExpired"];
  for (const name of events) {
    read.on(name, (...args) => { 
      const id = Number(args[0]); 
      addActivity(name, id, eventActor(name, args)); 
      refreshHighlight(); 
      render(); 
    });
  }
  livePoller = setInterval(() => { 
    const active = document.activeElement; 
    if (active && app.contains(active) && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return; 
    render(); 
  }, 4000);
}

function renderRegister() {
  app.innerHTML = page("Register an organisation role", "Your requested operational role is sent to the regulator. Organisation details stay only in this browser.", `
    <div class="grid two">
      <div class="card">
        <form id="roleForm">
          <label>Organisation name<input id="orgName" required placeholder="e.g. Metro General Hospital"></label>
          <label>Requested role
            <select id="requestedRole">
              <option value="manufacturer">Manufacturer</option>
              <option value="distributor">Distributor</option>
              <option value="clinic">Clinic</option>
              <option value="logger">Temperature logger</option>
            </select>
          </label>
          <button class="button teal">Request role</button>
        </form>
      </div>
      <aside class="card">
        <h3>How approval works</h3>
        <p>Request a role with MetaMask. A regulator then approves your wallet on-chain. Your organisation name is stored in <code>localStorage</code>, not on-chain.</p>
      </aside>
    </div>
  `);
}

async function renderRegulator() {
  app.innerHTML = page("Regulator panel", "Approve participating organisations and issue safety recalls.", `
    <div class="grid two">
      <div class="card">
        <h3>Approve or revoke entity</h3>
        <form id="entityForm">
          <label>Wallet address<input id="entityAddress" required placeholder="0x…"></label>
          <label>Role
            <select id="entityRole">
              <option value="manufacturer">Manufacturer</option>
              <option value="distributor">Distributor</option>
              <option value="clinic">Clinic</option>
              <option value="logger">Temperature logger</option>
            </select>
          </label>
          <div class="actions">
            <button class="button teal" name="op" value="approve">Approve requested role</button>
            <button class="button danger" name="op" value="revoke">Revoke</button>
          </div>
        </form>
      </div>
      <div class="card">
        <h3>Recall a batch</h3>
        <form id="recallForm">
          <label>Batch ID<input id="recallId" min="1" type="number" required placeholder="1"></label>
          <label>Reason<textarea id="recallReason" required placeholder="Safety notice or quality reason"></textarea></label>
          <button class="button danger">Recall batch</button>
        </form>
      </div>
    </div>
  `);
}

async function renderManufacturer() {
  const list = await batches(); 
  const mine = account ? list.filter(b => b.manufacturer.toLowerCase() === account.toLowerCase()) : [];
  const actions = b => Number(b.status) === 0 && b.custodian.toLowerCase() === account?.toLowerCase() 
    ? `<button class="button teal" data-action="dispatch" data-id="${b.id}">Dispatch</button>` 
    : `<button class="button light" disabled title="Only the current custodian can dispatch a manufactured batch.">Dispatch unavailable</button>`;

  app.innerHTML = page("Manufacturer workspace", "Register a vaccine batch and begin its cold-chain passport.", `
    <div class="grid two">
      <div class="card">
        <h3>Register batch</h3>
        <form id="batchForm">
          <label>Vaccine name<input id="vaccineName" required placeholder="ExampleVax"></label>
          <label>Lot number<input id="lotNumber" required placeholder="LOT-2026-01"></label>
          <div class="grid two">
            <label>Total doses<input id="doses" type="number" min="1" value="100" required></label>
            <label>Printed expiry<input id="printedExpiry" type="datetime-local" required></label>
          </div>
          <div class="grid two">
            <label>Minimum °C<input id="minTemp" type="number" step="0.1" value="2" required></label>
            <label>Maximum °C<input id="maxTemp" type="number" step="0.1" value="8" required></label>
          </div>
          <label>Excursion budget (minutes)<input id="budget" type="number" min="0" value="30" required></label>
          <label>IPFS CID (optional document reference)<input id="cid" placeholder="Qm…"></label>
          <button class="button teal">Register on-chain</button>
        </form>
      </div>
      <div class="card">
        <h3>Dispatch instructions</h3>
        <p>Use the dispatch button on a manufactured batch to assign custody to an approved distributor. You will be prompted with a popup to enter their Ethereum address.</p>
        <p class="notice">${account ? `Connected as ${copyableAddress(account)}.` : "Connect the manufacturer wallet to see your registered batches."}</p>
      </div>
    </div>
    <h2 style="margin-top:32px">My batches</h2>
    <div class="grid three">
      ${mine.length ? mine.map(b => batchCard(b, actions(b))).join("") : emptyState("No manufacturer batches found", account ? "You haven't registered any batches with this wallet yet." : "Connect the manufacturer wallet to view your batches.", account ? '<a class="button teal" href="#batchForm">Register Batch Above</a>' : '<button class="button teal" data-action="connect">Connect Wallet</button>')}
    </div>
  `);

  $("#batchForm")?.insertAdjacentHTML("afterbegin", `
    <label>Registration preset
      <select id="batchPreset" aria-label="Registration preset">
        <option value="">Choose a preset</option>
        <option value="covid">COVID vaccine · 2–8 °C · 100 doses · 30 min budget</option>
        <option value="cold">Cold-storage · 2–8 °C · 50 doses · 20 min budget</option>
      </select>
    </label>
  `);
}

async function renderDistributor() {
  const list = await batches(); 
  const incoming = [], outgoing = [];
  if (account) {
    for (const b of list) { 
      const pending = await read.pendingCustodian(b.id); 
      if (pending.toLowerCase() === account.toLowerCase()) incoming.push(b); 
      if (b.custodian.toLowerCase() === account.toLowerCase()) { 
        b.distributorConfirmed = await read.distributorConfirmed(b.id); 
        outgoing.push(b); 
      } 
    }
  }

  const incomingActions = b => `<button class="button teal" data-action="accept" data-id="${b.id}">Accept custody</button>`;
  const outgoingActions = b => Number(b.status) === 1 && !b.clinic.match(/^0x0+$/) && !b.distributorConfirmed 
    ? `<button class="button teal" data-action="confirm" data-id="${b.id}">Confirm handover</button>` 
    : Number(b.status) === 1 && b.clinic.match(/^0x0+$/) 
      ? `<button class="button teal" data-action="deliver" data-id="${b.id}">Deliver to clinic</button>` 
      : `<button class="button light" disabled title="Distributor handover is already confirmed or this batch is not awaiting action.">Handover confirmed</button>`;

  app.innerHTML = page("Distributor workspace", "Accept shipments, identify the destination clinic, and confirm dual handover.", `
    <h2>Incoming custody requests</h2>
    <div class="grid three">
      ${incoming.length ? incoming.map(b => batchCard(b, incomingActions(b))).join("") : emptyState("No incoming requests", "When a manufacturer dispatches a batch to your distributor address, it will appear here.")}
    </div>
    <h2 style="margin-top:32px">My in-transit batches</h2>
    <div class="grid three">
      ${outgoing.length ? outgoing.map(b => batchCard(b, outgoingActions(b))).join("") : emptyState("No batches in your custody", "Batches you have accepted custody for will be listed here.")}
    </div>
  `);
}

async function renderClinic() {
  const list = await batches(); 
  const relevant = account ? list.filter(b => b.clinic.toLowerCase() === account.toLowerCase() || b.custodian.toLowerCase() === account.toLowerCase()) : [];
  
  const actions = b => { 
    if (Number(b.status) === 1 && b.clinic.toLowerCase() === account?.toLowerCase()) {
      return `<button class="button teal" data-action="confirm" data-id="${b.id}">Confirm receipt</button>`; 
    }
    if ([2, 3].includes(Number(b.status)) && b.custodian.toLowerCase() === account?.toLowerCase()) {
      return `<button class="button teal" data-action="administer" data-id="${b.id}">Administer dose</button>`; 
    }
    return ""; 
  };

  app.innerHTML = page("Clinic workspace", "Confirm receipt, then administer doses with zero-knowledge patient hashing.", `
    <div class="notice">
      <b>Zero-Knowledge Privacy:</b> Patient IDs are hashed in your local browser using <code>keccak256</code>. The plaintext ID is never sent to the blockchain or stored in any server.
    </div>
    <div class="grid three" style="margin-top:22px">
      ${relevant.length ? relevant.map(b => batchCard(b, actions(b))).join("") : emptyState("No clinic deliveries found", "When a distributor designates your clinic for delivery, the batch will appear here.")}
    </div>
  `);
}

async function renderSensorConsole(id = selectedSensorBatch) {
  if (!activeRoles.includes("logger")) {
    return app.innerHTML = page("Sensor console", "Switch to an approved Temperature Logger account to record simulated readings.", `
      <div class="card empty">
        <a class="button teal" href="#/batch/${id || 1}">Open batch passport</a>
      </div>
    `);
  }
  
  const list = await batches(); 
  if (!list.length) {
    return app.innerHTML = page("Sensor console", "No batches are available for temperature logging.", `
      <div class="card empty">Register and seed a batch first.</div>
    `);
  }

  selectedSensorBatch = id || selectedSensorBatch || Number(list[0].id); 
  const batch = list.find(item => Number(item.id) === selectedSensorBatch) || list[0]; 
  selectedSensorBatch = Number(batch.id);

  const used = Number(batch.excursionMinsUsed), budget = Number(batch.excursionBudgetMins);
  const pct = budget ? Math.min(100, Math.round(used * 100 / budget)) : 0;

  app.innerHTML = page("Sensor console", "Simulate hardware logger telemetry and watch the passport react on-chain.", `
    <div class="grid two">
      <section class="card sensor-console">
        <div class="row-head">
          <div>
            <span class="stat-kicker">Logger station</span>
            <h2>Telemetry feed</h2>
          </div>
          ${badge(batch)}
        </div>
        <label>Batch selection
          <select id="sensorBatchSelect" aria-label="Sensor batch">
            ${list.map(item => `
              <option value="${item.id}" ${Number(item.id) === selectedSensorBatch ? "selected" : ""}>
                ${vx(item.id)} · ${escapeHtml(item.vaccineName)} · ${STATUS[Number(item.status)]}
              </option>
            `).join("")}
          </select>
        </label>
        <div class="sensor-actions">
          <button class="button teal" data-action="sensor-mode" data-mode="normal">Normal (2–8 °C)</button>
          <button class="button" data-action="sensor-mode" data-mode="spike">Spike (12–15 °C)</button>
          <button class="button danger" data-action="sensor-mode" data-mode="breach">Breach (22–25 °C)</button>
        </div>
        <div class="sensor-custom">
          <label>Custom temperature (°C)<input id="sensorTemp" type="number" step="0.1" value="5"></label>
          <label>Duration (minutes)<input id="sensorDuration" type="number" min="1" value="5"></label>
          <button class="button light" data-action="sensor-custom">Log custom reading</button>
        </div>
        <p class="sensor-note">Normal: within 2–8 °C · Spike: minor excursion burning budget · Breach: major thermal breach.</p>
      </section>

      <section class="card sensor-status">
        <h3>${vx(batch.id)} live status</h3>
        <div class="sensor-metrics">
          <div><span>Excursion used</span><b>${used} / ${budget} min</b></div>
          <div><span>Effective expiry</span><b>${date(batch.effectiveExpiry)}</b></div>
          <div><span>Readings sent</span><b>${sensorFeed.length}</b></div>
        </div>
        <div class="progress ${Number(batch.status) === 5 ? 'gauge-danger' : pct >= 50 ? 'gauge-warn' : 'gauge-safe'}">
          <i style="width:${pct}%"></i>
        </div>
        ${Number(batch.status) === 5 ? `<div class="notice danger sensor-alert">⚠ SPOILED: Excursion budget exceeded. Smart contract blocks further custody and doses.</div>` : ""}
        <div class="sensor-feed">
          ${sensorFeed.length ? sensorFeed.map(item => `
            <div class="sensor-reading ${item.state}">
              <span>${item.state === "pending" ? "◌" : item.state === "confirmed" ? "✓" : "!"}</span>
              <b>${item.temp} °C</b>
              <small>${item.duration} min · ${item.state}</small>
            </div>
          `).join("") : `<p class="empty">No readings logged in this session.</p>`}
        </div>
      </section>
    </div>
  `);
}

async function sendSensorReadings(id, readings) {
  if (!requireWallet()) return;
  if (!activeRoles.includes("logger")) return toast("Switch to the Temperature Logger account first.", true);
  
  sensorFeed = [];
  for (const [tempX10, durationMins] of readings) {
    sensorFeed.push({ temp: (tempX10 / 10).toFixed(1), duration: durationMins, state: "pending" }); 
    await renderSensorConsole(id);
    const receipt = await tx(write.logTemperature(id, tempX10, durationMins), "Telemetry reading recorded.", "logTemperature", false); 
    sensorFeed[sensorFeed.length - 1].state = receipt ? "confirmed" : "failed";
    await renderSensorConsole(id);
  }
}

async function renderBatch(id) {
  if (!id) { location.hash = "#/verify"; return; } 
  const b = await read.getBatch(id); 
  const [history, logs] = await Promise.all([read.getBatchHistory(id), read.getTemperatureLogs(id)]);
  
  const used = Number(b.excursionMinsUsed), budget = Number(b.excursionBudgetMins);
  const pct = budget ? Math.min(100, Math.round(used * 100 / budget)) : 0;
  const gaugeClass = Number(b.status) === 5 ? "gauge-danger" : pct >= 50 ? "gauge-warn" : "gauge-safe";
  const stepperHtml = stepper(b);
  const qrUrl = verificationUrl(id);
  const qrSetup = isLocalFrontend() ? `
    <div class="qr-setup">
      <p class="muted">This page is on <b>localhost</b>. Phone cameras cannot resolve localhost.</p>
      <button class="button light" data-action="set-qr-url">Set phone-accessible network URL</button>
    </div>
  ` : "";
  const sensorLink = activeRoles.includes("logger") ? `<a class="button light" href="#/sensor/${id}">Open Sensor Console</a>` : "";

  app.innerHTML = page(`${vx(b.id)} passport`, "An on-chain, temperature-aware cold-chain passport.", `
    <div class="grid two">
      <section class="card">
        <div class="row-head">
          <h2>${escapeHtml(b.vaccineName)}</h2>
          ${badge(b)}
        </div>
        <div class="detail-list">
          <div><span>Lot number</span>${escapeHtml(b.lotNumber)}</div>
          <div><span>Current status</span>${STATUS[Number(b.status)]}</div>
          <div><span>Manufacturer</span>${copyableAddress(b.manufacturer)}</div>
          <div><span>Current Custodian</span>${copyableAddress(b.custodian)}</div>
          <div><span>Printed expiry</span>${date(b.printedExpiry)}</div>
          <div><span>Effective expiry</span>${date(b.effectiveExpiry)}</div>
          <div><span>Temperature limits</span>${temp(b.minTempX10)} to ${temp(b.maxTempX10)}</div>
          <div><span>Doses remaining</span>${b.dosesRemaining} / ${b.totalDoses}</div>
        </div>
        <p><b>Excursion budget:</b> ${used} / ${budget} minutes</p>
        <div class="progress">
          <i style="width:${pct}%"></i>
        </div>
        <div class="actions">
          ${expiryAction(b)}
          ${sensorLink}
        </div>
      </section>

      <section class="card">
        <h3>Temperature record</h3>
        <canvas id="tempChart" class="chart" width="520" height="220"></canvas>
        <p class="muted">${logs.length} telemetry reading(s); values in °C.</p>
        <div class="qr-heading">
          <h3>Public verification QR</h3>
          <span class="role-chip">MetaMask not required</span>
        </div>
        <div id="qr" class="qr" aria-label="QR code for public batch verification"></div>
        <p class="qr-url">${escapeHtml(qrUrl)}</p>
        ${qrSetup}
        <p class="qr-help">This QR code opens instant public batch verification without needing a wallet.</p>
      </section>
    </div>

    <div class="grid two" style="margin-top:20px">
      <section class="card">
        <h3>Custody & status timeline</h3>
        <div class="timeline">
          ${history.map(h => `
            <div class="timeline-item">
              <b>${STATUS[Number(h.status)]}</b>
              <p>${escapeHtml(h.note)}</p>
              <small>${date(h.timestamp)} · ${copyableAddress(h.actor)}</small>
            </div>
          `).join("") || "No history logged"}
        </div>
      </section>

      <section class="card">
        <h3>Temperature logs</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Temperature</th>
                <th>Duration</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              ${logs.map(l => `
                <tr>
                  <td>${date(l.timestamp)}</td>
                  <td>${temp(l.tempX10)}</td>
                  <td>${l.durationMins} min</td>
                  <td>${l.excursion ? `<span style="color:var(--danger)">Excursion</span>` : `<span style="color:var(--safe)">In range</span>`}</td>
                </tr>
              `).join("") || `<tr><td colspan="4" style="text-align:center; color:var(--muted)">No readings logged yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `);

  const passportCard = app.querySelector(".grid.two .card");
  const detailList = passportCard?.querySelector(".detail-list");
  const progress = passportCard?.querySelector(".progress");
  
  passportCard?.querySelector(".row-head")?.insertAdjacentHTML("afterend", stepperHtml);
  detailList?.insertAdjacentHTML("beforeend", `
    <div><span>Expiry countdown</span><b>${countdown(b.effectiveExpiry)}</b></div>
    <div><span>Expiry penalty</span>${expiryDifference(b)}</div>
  `);

  if (progress) { 
    progress.classList.add("gauge", gaugeClass); 
    progress.insertAdjacentHTML("afterend", `<div class="gauge-label"><span>${used} min used</span><span>${budget} min budget</span></div>`); 
  }

  drawTemperature(logs, Number(b.minTempX10) / 10, Number(b.maxTempX10) / 10);
  
  const qr = $("#qr"); 
  if (qr) {
    qr.replaceChildren(); 
    new QRCode(qr, { 
      text: qrUrl, 
      width: 148, 
      height: 148, 
      colorDark: "#0c4a6e", 
      colorLight: "#ffffff", 
      correctLevel: QRCode.CorrectLevel.M 
    });
  }
}

function renderVerify(initialId) {
  app.innerHTML = page("Public batch verification", "Check any vaccine passport status directly on the blockchain without connecting a wallet.", `
    <div class="card">
      <div class="try-chips" aria-label="Try a sample batch">
        <button class="role-chip" data-action="verify-chip" data-id="1">Try Batch VX001</button>
        <button class="role-chip" data-action="verify-chip" data-id="2">Try Batch VX002</button>
      </div>
      <form id="verifyForm">
        <label>Batch ID (for example 1 or VX001)
          <input id="verifyId" value="${initialId ? `VX${String(initialId).padStart(3, "0")}` : ""}" placeholder="VX001" required>
        </label>
        <button class="button teal">Verify batch</button>
      </form>
    </div>
    <div id="verifyResult" style="margin-top:20px"></div>
  `);
  
  if (initialId) verify(initialId);
}

async function verify(raw) { 
  const id = Number(String(raw).replace(/\D/g, "")); 
  const target = $("#verifyResult"); 
  if (!target) return;
  if (!id) return target.innerHTML = `<div class="notice danger">Please enter a valid batch ID.</div>`; 
  
  const result = await read.verifyBatch(id); 
  const code = Number(result.code);
  const label = ["VALID", "WARNING", "INVALID"][code]; 
  
  target.innerHTML = `
    <div class="verify-banner verify-${["valid","warning","invalid"][code]}">
      <h2>${label}</h2>
      <p style="font-size:1.05rem; margin:0 0 16px">${escapeHtml(result.message)}</p>
      ${code !== 2 ? `<a class="button light" href="#/batch/${id}">Open full passport</a>` : ""}
    </div>
  `; 
}

async function renderAnalytics() {
  const stats = await read.getStats();
  const total = Number(stats.totalBatches);
  const spoiled = Number(stats.spoiled);
  const recalled = Number(stats.recalled);
  const expired = Number(stats.expired);
  const wastage = total ? (((spoiled + recalled + expired) / total) * 100).toFixed(1) : "0.0";

  app.innerHTML = page("Network analytics", "A real-time snapshot of batch volumes, patient impact, and cold-chain compliance.", `
    <div class="grid four analytics-stats">
      <div class="card stat">
        <span class="stat-kicker">Tracked inventory</span>
        <b>${total}</b>
        <span>Batch${total === 1 ? "" : "es"}</span>
      </div>
      <div class="card stat">
        <span class="stat-kicker">Patient impact</span>
        <b>${stats.dosesAdministered}</b>
        <span>Doses administered</span>
      </div>
      <div class="card stat">
        <span class="stat-kicker">Safety action</span>
        <b>${spoiled}</b>
        <span>Spoiled batches</span>
      </div>
      <div class="card stat">
        <span class="stat-kicker">Loss signal</span>
        <b>${wastage}%</b>
        <span>Wastage rate</span>
      </div>
    </div>

    <section class="card analytics-chart-card">
      <div class="section-heading">
        <div>
          <span class="stat-kicker">At a glance</span>
          <h2>Batch outcomes</h2>
          <p>Comparative metrics across on-chain status categories.</p>
        </div>
        <span class="analytics-total">${total} total batch${total === 1 ? "" : "es"}</span>
      </div>
      <div class="chart-wrap">
        <canvas id="barChart" class="chart" width="900" height="300"></canvas>
      </div>
      <div class="chart-legend">
        <span><i class="legend-swatch batches"></i>Tracked</span>
        <span><i class="legend-swatch doses"></i>Doses</span>
        <span><i class="legend-swatch spoiled"></i>Spoiled</span>
        <span><i class="legend-swatch recalled"></i>Recalled</span>
        <span><i class="legend-swatch expired"></i>Expired</span>
      </div>
      <div class="analytics-foot">
        <span>Recalled batches: <b>${recalled}</b></span>
        <span>Expired batches: <b>${expired}</b></span>
        <span>Total thermal excursion logged: <b>${stats.totalExcursionMinutes} min</b></span>
      </div>
    </section>
  `);

  drawBars([total, Number(stats.dosesAdministered), spoiled, recalled, expired], ["Batches", "Doses", "Spoiled", "Recalled", "Expired"]);
}

/* ==========================================================================
   Chart Rendering (High-DPI Canvas)
   ========================================================================== */

function drawTemperature(logs, safeMin = 2, safeMax = 8) { 
  const c = $("#tempChart");
  if (!c) return;
  const x = c.getContext("2d"), w = c.width, h = c.height; 
  x.clearRect(0, 0, w, h); 
  
  if (!logs.length) { 
    x.fillStyle = "#607789"; 
    x.font = "600 13px 'Plus Jakarta Sans', sans-serif";
    x.textAlign = "center";
    x.fillText("No temperature readings logged yet", w / 2, h / 2); 
    return; 
  } 

  const vals = logs.map(l => Number(l.tempX10) / 10);
  const min = Math.min(...vals, safeMin) - 1;
  const max = Math.max(...vals, safeMax) + 1;
  const span = max - min || 1;
  const top = 22, bottom = h - 30;
  const plotH = bottom - top;
  const yFor = v => bottom - (v - min) / span * plotH; 

  x.strokeStyle = "#e2edf2"; 
  x.fillStyle = "#607789"; 
  x.font = "11px 'JetBrains Mono', monospace"; 
  x.textAlign = "left";

  for (let i = 0; i < 5; i++) { 
    const value = min + (span * i / 4);
    const y = yFor(value); 
    x.beginPath(); 
    x.moveTo(42, y); 
    x.lineTo(w - 12, y); 
    x.stroke(); 
    x.fillText(`${value.toFixed(1)}°`, 6, y + 4); 
  } 

  // Safe Temperature Zone Band
  const bandTop = Math.min(yFor(safeMax), yFor(safeMin));
  const bandBottom = Math.max(yFor(safeMax), yFor(safeMin)); 
  x.fillStyle = "rgba(15, 155, 157, 0.12)"; 
  x.fillRect(42, bandTop, w - 54, bandBottom - bandTop); 

  // Temperature Line
  x.strokeStyle = "#0f9b9d"; 
  x.lineWidth = 3; 
  x.beginPath(); 
  vals.forEach((v, i) => { 
    const px = 42 + i * (w - 60) / Math.max(1, vals.length - 1);
    const py = yFor(v); 
    i ? x.lineTo(px, py) : x.moveTo(px, py); 
  }); 
  x.stroke(); 

  // Data Points
  vals.forEach((v, i) => { 
    const px = 42 + i * (w - 60) / Math.max(1, vals.length - 1);
    const py = yFor(v); 
    x.fillStyle = (v < safeMin || v > safeMax) ? "#c23b52" : "#0c4a6e"; 
    x.beginPath(); 
    x.arc(px, py, 4.5, 0, Math.PI * 2); 
    x.fill(); 
  }); 
}

function drawBars(values, labels) { 
  const c = $("#barChart");
  if (!c) return;
  const x = c.getContext("2d"), w = c.width, h = c.height;
  const left = 64, right = 28, top = 26, bottom = 58;
  const max = Math.max(...values, 1);
  const plotH = h - top - bottom;
  const plotW = w - left - right;
  const bw = plotW / values.length; 

  x.clearRect(0, 0, w, h); 
  x.font = "11px 'JetBrains Mono', monospace"; 
  x.strokeStyle = "#e2edf2"; 
  x.fillStyle = "#607789"; 

  for (let i = 0; i <= 4; i++) { 
    const y = top + plotH - (plotH * i / 4); 
    x.beginPath(); 
    x.moveTo(left, y); 
    x.lineTo(w - right, y); 
    x.stroke(); 
    x.fillText(String(Math.round(max * i / 4)), 10, y + 4); 
  } 

  values.forEach((v, i) => { 
    const bh = v / max * plotH;
    const px = left + i * bw + bw * 0.22; 
    x.fillStyle = ["#0c4a6e", "#0f9b9d", "#c23b52", "#bd7411", "#607789"][i]; 
    x.fillRect(px, top + plotH - bh, bw * 0.56, bh); 
    
    x.fillStyle = "#183146"; 
    x.font = "700 13px 'Plus Jakarta Sans', sans-serif"; 
    x.textAlign = "center";
    x.fillText(String(v), px + (bw * 0.56 / 2), top + plotH - bh - 8); 
    
    x.font = "600 12px 'Plus Jakarta Sans', sans-serif"; 
    x.fillStyle = "#607789";
    x.fillText(labels[i], px + (bw * 0.56 / 2), h - 24); 
  }); 
}

/* ==========================================================================
   Event Listeners & Action Handlers
   ========================================================================== */

function bindEvents() { 
  document.addEventListener("click", async e => { 
    const actionTarget = e.target.closest("[data-action]");
    if (!actionTarget) return;
    const action = actionTarget.dataset.action; 
    if (!action) return;

    if (action === "connect") return connect(); 
    
    if (action === "copy-address") {
      const addr = actionTarget.dataset.address;
      if (addr) {
        try {
          await navigator.clipboard.writeText(addr);
          toast(`Address copied: ${short(addr)}`);
        } catch {
          toast(`Address: ${addr}`);
        }
      }
      return;
    }

    if (action === "dismiss-shield") { 
      $("#shieldArea").innerHTML = ""; 
      return; 
    } 
    
    if (action === "dismiss-tx") { 
      $("#txDrawer")?.classList.remove("visible"); 
      return; 
    } 

    if (action === "mark-expired") {
      return tx(write.markExpired(Number(actionTarget.dataset.id)), "Batch marked expired.", "markExpired"); 
    }

    if (action === "sensor-mode") {
      return sendSensorReadings(selectedSensorBatch, SENSOR_READINGS[actionTarget.dataset.mode]); 
    }

    if (action === "sensor-custom") { 
      const temperature = Number($("#sensorTemp")?.value);
      const duration = Number($("#sensorDuration")?.value); 
      if (!Number.isFinite(temperature) || !Number.isFinite(duration) || duration < 1) {
        return toast("Enter a valid temperature and duration.", true); 
      }
      return sendSensorReadings(selectedSensorBatch, [[Math.round(temperature * 10), duration]]); 
    } 

    // Custom Modal for Phone-Accessible URL (replaces window.prompt)
    if (action === "set-qr-url") { 
      const current = localStorage.getItem("vaxpassFrontendUrl") || `http://${location.hostname || "127.0.0.1"}:8080`;
      const url = await promptUrlModal({ currentUrl: current });
      if (url) {
        localStorage.setItem("vaxpassFrontendUrl", url);
        toast("Public verification QR destination saved. Reloading passport…");
        return render();
      }
      return;
    } 

    if (!requireWallet()) return; 
    const id = Number(actionTarget.dataset.id); 

    if (action === "accept") {
      return tx(write.acceptCustody(id), "Custody accepted.", "acceptCustody"); 
    }

    if (action === "confirm") {
      return tx(write.confirmReceipt(id), "Receipt confirmation recorded.", "confirmReceipt"); 
    }

    // Custom Modal for Dispatching to Distributor (replaces window.prompt)
    if (action === "dispatch") { 
      const address = await promptAddressModal({
        title: `Dispatch Batch ${vx(id)}`,
        subtitle: "Assign cold-chain custody to an authorized distributor",
        roleLabel: "Distributor",
        iconType: "distributor"
      });
      if (address) {
        return tx(write.dispatchBatch(id, address), "Batch dispatched to distributor.", "dispatchBatch"); 
      }
      return;
    } 

    // Custom Modal for Delivering to Clinic (replaces window.prompt)
    if (action === "deliver") { 
      const address = await promptAddressModal({
        title: `Deliver Batch ${vx(id)} to Clinic`,
        subtitle: "Designate clinic destination; awaiting dual-handover receipt confirmation",
        roleLabel: "Clinic",
        iconType: "clinic"
      });
      if (address) {
        return tx(write.deliverToClinic(id, address), "Clinic delivery destination set; await dual confirmation.", "deliverToClinic"); 
      }
      return;
    } 

    // Custom Modal for Administering Dose with Keccak256 Preview (replaces window.prompt)
    if (action === "administer") { 
      const patientId = await promptPatientModal({ batchId: id });
      if (!patientId) return;
      const hash = ethers.keccak256(ethers.toUtf8Bytes(patientId)); 
      return tx(write.administerDose(id, hash), "Dose administered; only the cryptographic hash was recorded.", "administerDose"); 
    } 
  });

  document.addEventListener("change", e => { 
    if (e.target.id === "sensorBatchSelect") { 
      selectedSensorBatch = Number(e.target.value); 
      renderSensorConsole(selectedSensorBatch); 
    } 
  });

  document.addEventListener("submit", async e => { 
    const f = e.target; 
    if (f.id === "customModalForm") return; // Handled by modal Promise
    e.preventDefault(); 
    
    if (f.id === "verifyForm") return verify($("#verifyId").value); 
    if (!requireWallet()) return; 

    if (f.id === "roleForm") {
      const key = $("#requestedRole").value;
      localStorage.setItem("vaxpassOrg", $("#orgName").value);
      return tx(write.requestRole(roleIds[key]), "Role request submitted for regulator approval.", "requestRole");
    } 

    if (f.id === "entityForm") {
      const a = $("#entityAddress").value.trim();
      const r = roleIds[$("#entityRole").value];
      const op = e.submitter?.value;
      if (!ethers.isAddress(a)) return toast("Enter a valid Ethereum wallet address.", true);
      return tx(
        op === "revoke" ? write.revokeEntity(a, r) : write.approveEntity(a, r),
        op === "revoke" ? "Role revoked on-chain." : "Entity approved on-chain.",
        op === "revoke" ? "revokeEntity" : "approveEntity"
      );
    } 

    if (f.id === "recallForm") {
      return tx(write.recallBatch($("#recallId").value, $("#recallReason").value), "Batch recalled on-chain.", "recallBatch");
    } 

    if (f.id === "batchForm") {
      const expiry = Math.floor(new Date($("#printedExpiry").value).getTime() / 1000); 
      if (!expiry) return toast("Choose a valid expiry date.", true); 
      return tx(
        write.registerBatch(
          $("#vaccineName").value,
          $("#lotNumber").value,
          $("#doses").value,
          expiry,
          Math.round(Number($("#minTemp").value) * 10),
          Math.round(Number($("#maxTemp").value) * 10),
          $("#budget").value,
          $("#cid").value
        ),
        "Batch registered on Ethereum.",
        "registerBatch"
      );
    } 
  }); 
}

init().catch(e => { 
  app.innerHTML = `<div class="notice danger">Startup error: ${escapeHtml(friendly(e))}</div>`; 
});
