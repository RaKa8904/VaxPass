/* ==========================================================================
   VaxPass Front-End Architecture
   Decentralized Cold-Chain Vaccine Passport
   Icons: Hugeicons (Strictly No Emojis)
   Components: Shadcn Architecture & Framed QR System
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

const DEV_PERSONAS = [
  { name: "Regulator", role: "regulator", index: 0, address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", icon: "hgi-shield-user" },
  { name: "Manufacturer", role: "manufacturer", index: 1, address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", icon: "hgi-factory" },
  { name: "Distributor", role: "distributor", index: 2, address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", icon: "hgi-truck-delivery" },
  { name: "Clinic", role: "clinic", index: 3, address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", icon: "hgi-hospital-01" },
  { name: "Temperature Logger", role: "logger", index: 4, address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", icon: "hgi-thermometer-cold" }
];

let config, read, walletProvider, write, writeContract, account, activeRoles = [], roleIds = {}, rpcProvider;
let sensorFeed = [], selectedSensorBatch = 1, lastTransaction = null, livePoller = null, activity = [], checkpointId = null;
let mode = "live", activeDemoRole = "manufacturer", distributorTab = "incoming";
let authMode = "web3", smartAccountInfo = null, isGaslessSponsored = true;
let viewMode = localStorage.getItem("vaxpassViewMode") || "grid";
let activeStatusFilter = "all";
let searchQuery = "";
let isDataLoading = false;

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
    <i class="hgi-stroke hgi-copy-01" aria-hidden="true"></i>
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

function toast(message, type = "success") { 
  const el = document.createElement("div"); 
  const isErr = type === true || type === "error";
  const isPending = type === "pending";
  const isWarn = type === "warning";
  const modeClass = isErr ? "error" : isPending ? "pending" : isWarn ? "warning" : "success";
  const icon = isErr 
    ? "hgi-cancel-circle" 
    : isPending 
      ? "hgi-loading-03 spin" 
      : isWarn 
        ? "hgi-alert-triangle" 
        : "hgi-checkmark-circle-02";
  el.className = `toast ${modeClass}`; 
  el.innerHTML = `
    <i class="hgi-stroke ${icon}"></i>
    <span>${escapeHtml(message)}</span>
  `; 
  $("#toastArea").append(el); 
  if (!isPending) {
    setTimeout(() => el.remove(), 4500); 
  }
  return el;
}

function dismissPendingToasts() {
  document.querySelectorAll("#toastArea .toast.pending").forEach(el => el.remove());
}

function isUserRejection(error) {
  if (!error) return false;
  if (error.code === 4001 || error.code === "ACTION_REJECTED") return true;
  if (error.info?.error?.code === 4001) return true;
  const msg = String(error.shortMessage || error.reason || error.info?.error?.message || error.message || "");
  return /rejected|denied|user rejected|ACTION_REJECTED/i.test(msg);
}

function friendly(error) {
  if (isUserRejection(error)) return "Transaction rejected in MetaMask. No changes were made on-chain.";
  const m = error?.shortMessage || error?.reason || error?.message || "Transaction failed";
  return m.replace(/^execution reverted: /, "");
}

function errorText(error) { 
  return String(error?.shortMessage || error?.reason || error?.info?.error?.message || error?.message || "Transaction failed"); 
}

function contractEnforcement(error) {
  if (isUserRejection(error)) return null;
  const text = errorText(error);
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
  dismissPendingToasts();
  if (isUserRejection(error)) {
    return toast("Transaction rejected in MetaMask. No changes were made on-chain.", "error"); 
  }
  const card = contractEnforcement(error); 
  if (!card) return toast("Transaction cancelled in MetaMask. No changes were made.", "error"); 
  $("#shieldArea").innerHTML = `
    <div class="shield-card">
      <div class="shield-icon"><i class="hgi-stroke hgi-alert-triangle"></i></div>
      <div>
        <b>${card.title}</b>
        <p>${escapeHtml(card.message)}</p>
        <small>${escapeHtml(card.technical)}</small>
      </div>
      <button class="icon-button" data-action="dismiss-shield" aria-label="Dismiss contract error">
        <i class="hgi-stroke hgi-cancel-01"></i>
      </button>
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
      <button class="icon-button" data-action="dismiss-tx" aria-label="Close transaction drawer">
        <i class="hgi-stroke hgi-cancel-01"></i>
      </button>
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
  const cls = statusClass(batch);
  const iconName = cls === "safe" ? "hgi-checkmark-circle-02" : cls === "warning" ? "hgi-clock-01" : cls === "risk" ? "hgi-alert-triangle" : "hgi-cancel-circle";
  return `<span class="badge ${cls}"><i class="hgi-stroke ${iconName}"></i> ${statusLabel(batch)}</span>`; 
}

function expiryAction(batch) { 
  const active = ![4, 5, 6, 7].includes(Number(batch.status)); 
  return active && Number(batch.effectiveExpiry) <= Math.floor(Date.now() / 1000) 
    ? `<button class="button danger" data-action="mark-expired" data-id="${batch.id}"><i class="hgi-stroke hgi-clock-01"></i> Mark expired</button>` 
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
          <span>${step[1] ? '<i class="hgi-stroke hgi-checkmark-circle-02"></i>' : index + 1}</span>
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
        <i class="hgi-stroke hgi-package"></i>
      </div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(subtitle)}</p>
      ${actionHtml}
    </div>
  `;
}

function requireWallet() { 
  if (!account) { 
    toast("Sign in with Passkey, Email, or Web3 wallet to perform this action.", true); 
    handleConnectClick?.();
    return false; 
  } 
  return true; 
}

let html5QrScanner = null;

function promptAuthModal() {
  return new Promise((resolve) => {
    const isLocalNode = Number(config?.chainId) === 31337;

    const bodyHtml = `
      <div class="auth-tabs">
        <div class="auth-tabs-nav" role="tablist">
          ${isLocalNode ? `<button type="button" class="auth-tab-btn active" data-tab="personas"><i class="hgi-stroke hgi-user-switch"></i> Dev Personas</button>` : ""}
          <button type="button" class="auth-tab-btn ${!isLocalNode ? 'active' : ''}" data-tab="passkey"><i class="hgi-stroke hgi-fingerprint"></i> Passkey</button>
          <button type="button" class="auth-tab-btn" data-tab="email"><i class="hgi-stroke hgi-mail-01"></i> Email</button>
          <button type="button" class="auth-tab-btn" data-tab="web3"><i class="hgi-stroke hgi-wallet-01"></i> Web3</button>
        </div>

        <div class="auth-tab-panels">
          ${isLocalNode ? `
            <div class="auth-tab-panel active" id="tab-panel-personas">
              <div class="auth-panel-intro">
                <b>Seeded Local Roles (One-Click Testing)</b>
                <p>Switch instantly between cold-chain ecosystem actors with pre-funded gas.</p>
              </div>
              <div class="dev-personas-grid">
                ${DEV_PERSONAS.map(p => `
                  <button type="button" class="dev-persona-btn ${account && account.toLowerCase() === p.address.toLowerCase() ? 'current' : ''}" data-persona-index="${p.index}">
                    <div class="persona-icon-badge"><i class="hgi-stroke ${p.icon}"></i></div>
                    <div class="persona-text">
                      <span class="persona-title">${escapeHtml(p.name)}</span>
                      <span class="persona-role">${short(p.address)} · Dev #${p.index}</span>
                    </div>
                    ${account && account.toLowerCase() === p.address.toLowerCase() ? '<span class="persona-badge-current">Active</span>' : '<i class="hgi-stroke hgi-arrow-right-01 persona-arrow"></i>'}
                  </button>
                `).join("")}
              </div>
            </div>
          ` : ""}

          <div class="auth-tab-panel ${!isLocalNode ? 'active' : ''}" id="tab-panel-passkey">
            <div class="auth-panel-intro">
              <b>WebAuthn Passkey (Hardware Biometrics)</b>
              <p>Sign in using Touch ID, Face ID, or Windows Hello. Zero gas fees, instant ERC-4337 smart account.</p>
            </div>
            <div class="auth-inline-form">
              <label for="passkeyIdentifier">
                Courier / Clinic Identifier
                <input id="passkeyIdentifier" type="text" placeholder="courier.driver@vaxlogistics.com" value="courier.driver@vaxlogistics.com" autocomplete="username">
              </label>
              <button type="button" class="button teal" id="submitPasskeyAuthBtn" style="width: 100%; margin-top: 6px;">
                <i class="hgi-stroke hgi-fingerprint"></i> Authenticate with Passkey
              </button>
            </div>
          </div>

          <div class="auth-tab-panel" id="tab-panel-email">
            <div class="auth-panel-intro">
              <b>Corporate Hospital / Logistics Email</b>
              <p>Authenticate with your enterprise healthcare or supply chain email.</p>
            </div>
            <div class="auth-inline-form">
              <label for="emailIdentifier">
                Corporate Email Address
                <input id="emailIdentifier" type="email" placeholder="nurse.joy@saintmarys.org" value="nurse.joy@saintmarys.org" autocomplete="email">
              </label>
              <button type="button" class="button teal" id="submitEmailAuthBtn" style="width: 100%; margin-top: 6px;">
                <i class="hgi-stroke hgi-mail-01"></i> Sign In with Email
              </button>
            </div>
          </div>

          <div class="auth-tab-panel" id="tab-panel-web3">
            <div class="auth-panel-intro">
              <b>Web3 Browser Extension</b>
              <p>Connect MetaMask, Coinbase Wallet, Rabby, or any EIP-1193 compatible wallet.</p>
            </div>
            <div style="text-align: center; padding: 12px 0;">
              <button type="button" class="button blue" id="submitWeb3AuthBtn" style="width: 100%; justify-content: center; padding: 12px 20px; font-size: 0.95rem;">
                <i class="hgi-stroke hgi-wallet-01"></i> Connect Browser Wallet (MetaMask)
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    promptModal({
      title: "Enterprise Sign-in",
      subtitle: "ERC-4337 Smart Account & Gasless Session",
      iconHtml: '<i class="hgi-stroke hgi-fingerprint"></i>',
      bodyHtml,
      confirmText: "Cancel",
      cancelText: "Close",
      onMount: ({ resolve: modalResolve }) => {
        $("#modalConfirmBtn")?.style.setProperty("display", "none");

        // Tab switching logic
        const tabBtns = document.querySelectorAll(".auth-tab-btn");
        const panels = document.querySelectorAll(".auth-tab-panel");
        tabBtns.forEach(btn => {
          btn.addEventListener("click", () => {
            tabBtns.forEach(b => b.classList.remove("active"));
            panels.forEach(p => p.classList.remove("active"));
            btn.classList.add("active");
            const targetPanel = $(`#tab-panel-${btn.dataset.tab}`);
            if (targetPanel) targetPanel.classList.add("active");
          });
        });

        // Dev persona clicks
        document.querySelectorAll("[data-persona-index]").forEach(btn => {
          btn.addEventListener("click", async () => {
            const idx = Number(btn.dataset.personaIndex);
            const p = DEV_PERSONAS[idx];
            const signer = await rpcProvider.getSigner(p.index);
            modalResolve({
              authType: "dev-persona",
              smartAccountAddress: p.address,
              name: p.name,
              label: `${p.name} (Dev #${p.index})`,
              role: p.role,
              icon: p.icon,
              signer
            });
          });
        });

        // Passkey submit
        $("#submitPasskeyAuthBtn")?.addEventListener("click", async () => {
          const user = $("#passkeyIdentifier")?.value?.trim() || "courier.driver@vaxlogistics.com";
          try {
            const btn = $("#submitPasskeyAuthBtn");
            if (btn) {
              btn.disabled = true;
              btn.innerHTML = `<i class="hgi-stroke hgi-loading-03 spin"></i> Authenticating WebAuthn…`;
            }
            const res = await VaxPassAA.authenticateWithPasskey(user);
            modalResolve(res);
          } catch (err) {
            toast("Passkey authentication failed: " + err.message, true);
            const btn = $("#submitPasskeyAuthBtn");
            if (btn) {
              btn.disabled = false;
              btn.innerHTML = `<i class="hgi-stroke hgi-fingerprint"></i> Authenticate with Passkey`;
            }
          }
        });

        // Email submit
        $("#submitEmailAuthBtn")?.addEventListener("click", async () => {
          const email = $("#emailIdentifier")?.value?.trim() || "nurse.joy@saintmarys.org";
          try {
            const btn = $("#submitEmailAuthBtn");
            if (btn) {
              btn.disabled = true;
              btn.innerHTML = `<i class="hgi-stroke hgi-loading-03 spin"></i> Connecting…`;
            }
            const res = await VaxPassAA.authenticateWithEmail(email);
            modalResolve(res);
          } catch (err) {
            toast("Email login failed: " + err.message, true);
            const btn = $("#submitEmailAuthBtn");
            if (btn) {
              btn.disabled = false;
              btn.innerHTML = `<i class="hgi-stroke hgi-mail-01"></i> Sign In with Email`;
            }
          }
        });

        // Web3 submit
        $("#submitWeb3AuthBtn")?.addEventListener("click", () => {
          modalResolve({ authType: "web3" });
        });
      }
    }).then(resolve);
  });
}

function openBarcodeScannerModal(onScannedCallback) {
  return new Promise((resolve) => {
    const bodyHtml = `
      <div class="scanner-container">
        <div id="barcodeReader" style="min-height: 240px; border-radius: 8px; overflow: hidden;"></div>
        <div class="scanner-actions" style="margin-top: 12px; display: flex; flex-direction: column; gap: 8px; width: 100%;">
          <button type="button" id="demoGs1Btn" class="button light" style="width: 100%; font-size: 0.84rem;">
            <i class="hgi-stroke hgi-flash"></i> Test with Sample GS1 2D DataMatrix Barcode
          </button>
          <small style="color: var(--muted); text-align: center;">Supports FDA DSCSA / EU FMD standard (GTIN AI 01, Expiry AI 17, Lot AI 10, Serial AI 21)</small>
        </div>
      </div>
    `;

    promptModal({
      title: "GS1 2D DataMatrix Camera Scanner",
      subtitle: "Scan pharmaceutical packaging barcode or DataMatrix",
      iconHtml: '<i class="hgi-stroke hgi-barcode-scanner"></i>',
      bodyHtml,
      confirmText: "Close",
      cancelText: "Cancel",
      onMount: ({ resolve: modalResolve }) => {
        $("#modalConfirmBtn")?.style.setProperty("display", "none");

        function cleanupScanner() {
          if (html5QrScanner) {
            try {
              html5QrScanner.stop().catch(() => {});
            } catch (_) {}
            html5QrScanner = null;
          }
        }

        $("#demoGs1Btn")?.addEventListener("click", () => {
          const sample = window.GS1Parser 
            ? GS1Parser.generateMockGS1({ lotNumber: "LOT-2026-COV01", expiryYYMMDD: "261231" })
            : "(01)00312345678906(17)261231(10)LOT-2026-COV01(21)SN987654321";
          const parsed = window.GS1Parser ? GS1Parser.parseBarcode(sample) : { success: true, lotNumber: "LOT-2026-COV01", isGS1: true, raw: sample };
          cleanupScanner();
          modalResolve(parsed);
          if (onScannedCallback) onScannedCallback(parsed);
        });

        // Initialize camera scanner
        if (typeof Html5Qrcode !== "undefined") {
          try {
            html5QrScanner = new Html5Qrcode("barcodeReader");
            html5QrScanner.start(
              { facingMode: "environment" },
              { fps: 10, qrbox: { width: 220, height: 220 } },
              (decodedText) => {
                const parsed = window.GS1Parser ? GS1Parser.parseBarcode(decodedText) : { success: true, raw: decodedText };
                cleanupScanner();
                modalResolve(parsed);
                if (onScannedCallback) onScannedCallback(parsed);
              },
              () => {}
            ).catch(err => {
              console.warn("Camera start not available in environment:", err);
              const el = $("#barcodeReader");
              if (el) {
                el.innerHTML = `
                  <div style="padding: 24px; text-align: center; color: var(--muted); background: #f8fafc; border: 1px dashed var(--line-light); border-radius: 8px;">
                    <i class="hgi-stroke hgi-camera-off" style="font-size: 2rem; display: block; margin-bottom: 8px; color: var(--muted);"></i>
                    <p style="margin: 0 0 6px 0; font-size: 0.9rem; font-weight: 600;">Camera device not detected or permission denied</p>
                    <small>Click the sample barcode button below to test GS1 parsing.</small>
                  </div>
                `;
              }
            });
          } catch (e) {
            console.warn("Html5Qrcode scanner failed to initialize:", e);
          }
        }
      }
    }).then(resolve);
  });
}

function promptReceiptModal(receipt) {
  const bodyHtml = `
    <div style="background: #f8fafc; border: 1px solid var(--line-light); border-radius: var(--radius-md); padding: 16px; margin-bottom: 16px; text-align: center;">
      <div id="receiptQrCode" style="display: inline-block; padding: 10px; background: white; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 12px;"></div>
      <p style="margin: 0; font-size: 0.92rem; font-weight: 700; color: var(--ink);">${escapeHtml(receipt.vaccineName || "COVID-19 Vaccine")}</p>
      <small style="color: var(--muted);">Batch ${vx(receipt.batchId)} · Administered: ${new Date().toLocaleDateString()}</small>
    </div>

    <div class="detail-list" style="font-size: 0.8rem;">
      <div><span>On-chain Commitment</span><code style="word-break: break-all;">${short(receipt.commitment)}</code></div>
      <div><span>Blinding Salt</span><code style="word-break: break-all;">${short(receipt.salt)}</code></div>
      <div><span>Gas Sponsorship</span><span class="badge safe"><i class="hgi-stroke hgi-flash"></i> Paymaster Sponsored (0 ETH)</span></div>
      <div><span>Privacy Compliance</span><span class="badge safe"><i class="hgi-stroke hgi-security-check"></i> Zero-PII Salted Hash</span></div>
    </div>

    <p class="privacy-guarantee-note" style="margin-top: 14px;">
      <b>Digital Pass Guarantee:</b> This cryptographic receipt contains a private 256-bit blinding salt. Your identity cannot be reverse-engineered on-chain. Present this pass or QR code for proof of vaccination.
    </p>
  `;

  promptModal({
    title: "Cryptographic Vaccination Receipt",
    subtitle: "Zero-PII Verifiable Digital Pass (HIPAA & GDPR Compliant)",
    iconHtml: '<i class="hgi-stroke hgi-checkmark-circle-02" style="color: #059669;"></i>',
    bodyHtml,
    confirmText: "Copy Receipt JSON",
    cancelText: "Done",
    onMount: ({ form }) => {
      if (typeof QRCode !== "undefined") {
        const qrContainer = $("#receiptQrCode");
        if (qrContainer) {
          new QRCode(qrContainer, {
            text: JSON.stringify({
              protocol: "VaxPass-Enterprise-v2",
              batchId: receipt.batchId,
              commitment: receipt.commitment,
              salt: receipt.salt
            }),
            width: 140,
            height: 140
          });
        }
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
          toast("Vaccination receipt copied to clipboard!");
        } catch {
          toast("Copied to clipboard.");
        }
      });
    }
  });
}

/* ==========================================================================
   Custom Shadcn Modal Popup System
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
          <button type="button" class="modal-close-btn" data-modal-action="cancel" aria-label="Close modal">
            <i class="hgi-stroke hgi-cancel-01"></i>
          </button>
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
    ? `<i class="hgi-stroke hgi-truck-delivery"></i>`
    : `<i class="hgi-stroke hgi-hospital-01"></i>`;

  const isLocal = Number(config?.chainId) === 31337;
  const isDist = roleLabel.toLowerCase().includes("distributor");
  const isClinic = roleLabel.toLowerCase().includes("clinic");
  const seededAddress = isDist
    ? "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
    : isClinic
      ? "0x90F79bf6EB2c4f870365E785982E1f101E93b906"
      : "";
  const quickFillHtml = `
    <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px;">
      ${isLocal && seededAddress ? `
        <button type="button" id="modalFillSeededBtn" class="address-chip" style="font-size: 0.78rem; padding: 4px 10px; cursor: pointer;">
          <i class="hgi-stroke hgi-user-check-01"></i>
          <span>Use default local ${escapeHtml(roleLabel)} (${short(seededAddress)})</span>
        </button>
      ` : ""}
      <button type="button" id="modalScanAddressBtn" class="address-chip" style="font-size: 0.78rem; padding: 4px 10px; cursor: pointer;">
        <i class="hgi-stroke hgi-barcode-scanner"></i>
        <span>Scan Recipient Barcode / QR</span>
      </button>
    </div>
  `;

  const bodyHtml = `
    <label for="modalAddressInput">
      ${escapeHtml(roleLabel)} Wallet Address
      <div class="input-with-button">
        <input id="modalAddressInput" name="address" required placeholder="0x…" autocomplete="off" spellcheck="false">
        <button type="button" id="modalPasteBtn" class="paste-chip-btn">
          <i class="hgi-stroke hgi-copy-01"></i> Paste
        </button>
      </div>
    </label>
    ${quickFillHtml}
    <div id="modalAddressFeedback" class="validation-feedback info">
      <i class="hgi-stroke hgi-information-circle"></i>
      <span>Requires a 42-character Ethereum address (0x…)</span>
    </div>
    <div class="alert info">
      <div class="alert-icon"><i class="hgi-stroke hgi-shield-user"></i></div>
      <div class="alert-body">
        <div class="alert-title">Access Control Requirement</div>
        <div class="alert-description">The recipient wallet must have the <code>${escapeHtml(roleLabel)}</code> role approved by the Regulator on-chain.</div>
      </div>
    </div>
  `;

  return promptModal({
    title,
    subtitle,
    iconHtml: iconSvg,
    bodyHtml,
    confirmText: "Confirm Address",
    onMount: ({ resolve, form }) => {
      const input = $("#modalAddressInput");
      const feedback = $("#modalAddressFeedback");
      const pasteBtn = $("#modalPasteBtn");
      const fillSeededBtn = $("#modalFillSeededBtn");
      const scanAddressBtn = $("#modalScanAddressBtn");

      function validate() {
        const val = input.value.trim();
        if (!val) {
          feedback.className = "validation-feedback info";
          feedback.innerHTML = `<i class="hgi-stroke hgi-information-circle"></i> <span>Requires a 42-character Ethereum address (0x…)</span>`;
          return false;
        }
        if (ethers.isAddress(val)) {
          feedback.className = "validation-feedback valid";
          feedback.innerHTML = `<i class="hgi-stroke hgi-checkmark-circle-02"></i> <span>Valid Ethereum address (${short(val)})</span>`;
          return true;
        } else {
          feedback.className = "validation-feedback invalid";
          feedback.innerHTML = `<i class="hgi-stroke hgi-alert-circle"></i> <span>Invalid Ethereum address checksum or format</span>`;
          return false;
        }
      }

      input.addEventListener("input", validate);
      input.focus();

      fillSeededBtn?.addEventListener("click", () => {
        input.value = seededAddress;
        validate();
        input.focus();
      });

      scanAddressBtn?.addEventListener("click", () => {
        openBarcodeScannerModal((parsed) => {
          let clean = (parsed.raw || "").trim();
          if (clean.startsWith("ethereum:")) clean = clean.replace("ethereum:", "").split("@")[0].split("?")[0];
          input.value = clean;
          validate();
          input.focus();
        });
      });

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

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const val = input.value.trim();
        if (!ethers.isAddress(val)) {
          validate();
          input.focus();
          return;
        }

        const confirmBtn = $("#modalConfirmBtn");
        if (confirmBtn) {
          confirmBtn.disabled = true;
          confirmBtn.innerHTML = `<i class="hgi-stroke hgi-loading-03 spin"></i> Verifying on-chain…`;
        }

        try {
          const roleKey = roleLabel.toLowerCase();
          const targetRoleId = roleIds[roleKey];
          if (targetRoleId && read) {
            const hasApprovedRole = await read.hasRole(targetRoleId, val);
            if (!hasApprovedRole) {
              feedback.className = "validation-feedback invalid";
              feedback.innerHTML = `<i class="hgi-stroke hgi-alert-circle"></i> <span>This wallet does not have the on-chain approved ${escapeHtml(roleLabel)} role.</span>`;
              if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = "Confirm Address";
              }
              input.focus();
              return;
            }
          }
        } catch (error) {
          feedback.className = "validation-feedback invalid";
          feedback.innerHTML = `<i class="hgi-stroke hgi-alert-circle"></i> <span>Unable to verify this wallet's approved role on the configured network.</span>`;
          if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = "Confirm Address";
          }
          showShield(error);
          input.focus();
          return;
        }

        resolve(val);
      });
    }
  });
}

function promptPatientModal({ batchId }) {
  const iconSvg = `<i class="hgi-stroke hgi-lock-key"></i>`;

  const bodyHtml = `
    <label for="modalPatientInput">
      Patient Identifier or Health Record ID
      <input id="modalPatientInput" name="patientId" required placeholder="e.g. PID-2026-9812 or NHS Record ID" autocomplete="off">
    </label>
    <div class="privacy-preview-box">
      <div class="privacy-preview-head">
        <span>Live keccak256 cryptographic preview</span>
        <span><i class="hgi-stroke hgi-lock-key"></i> Zero-Knowledge</span>
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
  const iconSvg = `<i class="hgi-stroke hgi-wifi-01"></i>`;

  const bodyHtml = `
    <label for="modalUrlInput">
      Frontend URL accessible from phone cameras
      <input id="modalUrlInput" name="url" required value="${escapeHtml(currentUrl)}" placeholder="http://192.168.0.106:8080">
    </label>
    <div id="modalUrlFeedback" class="validation-feedback info">
      <i class="hgi-stroke hgi-information-circle"></i>
      <span>Must begin with http:// or https://</span>
    </div>
    <div class="alert info">
      <div class="alert-icon"><i class="hgi-stroke hgi-qr-code"></i></div>
      <div class="alert-body">
        <div class="alert-title">Local Wi-Fi Verification</div>
        <div class="alert-description">If scanning from a phone on your local Wi-Fi, provide your computer's local network IP address (e.g. <code>http://192.168.1.50:8080</code>).</div>
      </div>
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
          feedback.innerHTML = `<i class="hgi-stroke hgi-alert-circle"></i> <span>Enter a valid http:// or https:// URL format</span>`;
          input.focus();
        }
      });
    }
  });
}

function confirmModal({ title, message, confirmText = "Confirm", cancelText = "Cancel", isDanger = false }) {
  const iconSvg = isDanger
    ? `<i class="hgi-stroke hgi-alert-triangle"></i>`
    : `<i class="hgi-stroke hgi-information-circle"></i>`;

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
    app.innerHTML = `
      <div class="alert destructive">
        <div class="alert-icon"><i class="hgi-stroke hgi-alert-circle"></i></div>
        <div class="alert-body">
          <div class="alert-title">No Deployment Found</div>
          <div class="alert-description">Start a local node and run the deploy script first.</div>
        </div>
      </div>
    `; 
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

  $("#connectButton")?.addEventListener("click", handleConnectClick);
  $("#menuButton")?.addEventListener("click", () => $("#nav")?.classList.toggle("open"));
  
  updateModeControls();
  window.addEventListener("hashchange", render);
  
  if (window.ethereum) { 
    window.ethereum.on("accountsChanged", handleAccountChanged); 
    window.ethereum.on("chainChanged", () => window.location.reload()); 
    if ((await window.ethereum.request({ method: "eth_accounts" })).length) {
      await connectMetaMask(false); 
    }
  }

  bindEvents(); 
  bindPolishEvents(); 
  startLiveUpdates(); 

  if (window.VaxPassGraphQL) {
    VaxPassGraphQL.checkHealth().then(updateIndexerStatusBadge);
  }

  render();
}

function updateIndexerStatusBadge() {
  const badgeEl = $("#indexerBadge");
  const textEl = $("#indexerStatusText");
  if (!badgeEl || !textEl) return;
  const isOnline = window.VaxPassGraphQL?.isOnline();
  if (isOnline) {
    badgeEl.className = "indexer-chip online";
    textEl.textContent = "Subgraph Live";
    badgeEl.title = "Connected to GraphQL Subgraph / HyperIndex";
  } else {
    badgeEl.className = "indexer-chip fallback";
    textEl.textContent = "RPC Direct";
    badgeEl.title = "Direct on-chain RPC Fallback Active";
  }
}

function updateModeControls() {
  const connectBtn = $("#connectButton");
  if (connectBtn) {
    const icon = authMode === "passkey" ? "hgi-fingerprint" : authMode === "email" ? "hgi-mail-01" : "hgi-wallet-01";
    const label = account 
      ? (smartAccountInfo?.label ? smartAccountInfo.label.split("@")[0] : short(account))
      : "Sign in";
    const caretIcon = account ? `<i class="hgi-stroke hgi-arrow-down-01" style="font-size: 0.8rem; margin-left: 2px; opacity: 0.8;" aria-hidden="true"></i>` : "";
    connectBtn.innerHTML = `
      <i class="hgi-stroke ${icon}" aria-hidden="true"></i>
      <span>${escapeHtml(label)}</span>
      ${caretIcon}
    `;
    if (account) {
      connectBtn.classList.add("connected");
      connectBtn.title = `Signed in (${authMode}): ${account} (Click to open account menu)`;
    } else {
      connectBtn.classList.remove("connected");
      connectBtn.title = "Click to sign in with Passkey, Email, or Web3";
    }
  }

  const gaslessBadge = $("#gaslessBadge");
  if (gaslessBadge) {
    gaslessBadge.style.display = "inline-flex";
    gaslessBadge.title = "ERC-4337 Gas Sponsorship active across all operations";
  }

  updateIndexerStatusBadge();

  const networkName = $("#networkName");
  const networkChip = $("#networkChip");
  if (networkName && config) {
    const chainId = Number(config.chainId);
    const label = chainId === 31337 
      ? "Hardhat (31337)" 
      : chainId === 84532 
        ? "Base Sepolia L2 (84532)" 
        : chainId === 421614 
          ? "Arbitrum Sepolia L2 (421614)" 
          : chainId === 11155420 
            ? "OP Sepolia L2 (11155420)" 
            : chainId === 11155111 
              ? "Sepolia (11155111)" 
              : `Chain ID ${chainId}`;
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
    const action = e.target.closest("[data-action]")?.dataset?.action; 
    if (action === "verify-chip") { 
      const id = e.target.closest("[data-id]")?.dataset?.id;
      $("#verifyId").value = `VX${String(id).padStart(3, "0")}`; 
      return verify(id); 
    } 
    if (action === "request-role") { 
      if (!requireWallet()) return; 
      const role = e.target.closest("[data-role]")?.dataset?.role;
      return tx(() => sendWithPreflight("requestRole", [roleIds[role]]), "Role request submitted.", "requestRole");
    } 
    if (action === "scan-gs1-register") {
      return openBarcodeScannerModal((parsed) => {
        if (parsed.lotNumber) {
          const lotEl = $("#lotNumber");
          if (lotEl) lotEl.value = parsed.lotNumber;
        }
        if (parsed.expiryDate) {
          const expEl = $("#printedExpiry");
          if (expEl) expEl.value = parsed.expiryDate.iso.slice(0, 16);
        }
        toast(`GS1 Barcode Scanned: Lot ${parsed.lotNumber || "N/A"} · Expiry: ${parsed.expiryDate?.formatted || "N/A"}`);
      });
    }
    if (action === "scan-gs1-distributor") {
      return openBarcodeScannerModal(async (parsed) => {
        const query = (parsed.lotNumber || parsed.raw || "").trim();
        toast(`Scanned: ${query}. Checking batches…`);
        const list = await batches();
        const match = list.find(b => b.lotNumber.toLowerCase() === query.toLowerCase() || String(b.id) === query);
        if (match) {
          location.hash = `#/batch/${match.id}`;
          toast(`Matching Batch ${vx(match.id)} found!`);
        } else {
          toast(`Scanned GS1 Lot: ${query}`, "info");
        }
      });
    }
    if (action === "scan-gs1-verify") {
      return openBarcodeScannerModal((parsed) => {
        const query = parsed.lotNumber || parsed.gtin || parsed.raw;
        const input = $("#verifyId");
        if (input) input.value = query;
        verify(query);
      });
    }
  }); 
  document.addEventListener("change", e => { 
    if (e.target.id === "batchPreset") applyPreset(e.target.value); 
  }); 
}

function renderAccountDropdown() {
  const dd = $("#accountDropdown");
  if (!dd) return;
  if (!account) {
    dd.innerHTML = "";
    dd.classList.remove("active");
    dd.setAttribute("aria-hidden", "true");
    $("#connectButton")?.setAttribute("aria-expanded", "false");
    return;
  }

  // Determine current persona / role
  let roleLabel = "Guest / Signer";
  let roleIcon = "hgi-user";
  if (activeRoles.length) {
    roleLabel = activeRoles.map(r => ROLE_LABELS[r] || r).join(", ");
    const primary = activeRoles[0];
    if (primary === "regulator") roleIcon = "hgi-shield-user";
    else if (primary === "manufacturer") roleIcon = "hgi-factory";
    else if (primary === "distributor") roleIcon = "hgi-truck-delivery";
    else if (primary === "clinic") roleIcon = "hgi-hospital-01";
    else if (primary === "logger") roleIcon = "hgi-thermometer-cold";
  } else if (authMode === "dev-persona" && smartAccountInfo?.role) {
    roleLabel = ROLE_LABELS[smartAccountInfo.role] || smartAccountInfo.role;
    roleIcon = smartAccountInfo.icon || "hgi-user";
  }

  const displayName = smartAccountInfo?.name || smartAccountInfo?.label || (authMode === "dev-persona" ? "Dev Persona" : (authMode === "passkey" ? "Passkey User" : (authMode === "email" ? "Email User" : "Web3 Wallet")));

  const networkLabel = config ? (Number(config.chainId) === 31337 ? "Hardhat (31337)" : Number(config.chainId) === 11155111 ? "Sepolia" : `Chain ${config.chainId}`) : "Local Node";

  const modeBadgeText = authMode === "dev-persona" ? "Local Dev Persona" : authMode === "passkey" ? "Passkey (WebAuthn)" : authMode === "email" ? "Corporate Email" : "Web3 Extension";

  dd.innerHTML = `
    <div class="account-dropdown-header">
      <div class="dropdown-avatar">
        <i class="hgi-stroke ${roleIcon}" aria-hidden="true"></i>
      </div>
      <div class="dropdown-identity">
        <span class="dropdown-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
        <div class="dropdown-addr-row">
          <span class="dropdown-address">${short(account)}</span>
          <button type="button" class="mini-copy-btn" data-action="copy-account-addr" data-address="${escapeHtml(account)}" title="Copy address: ${escapeHtml(account)}" aria-label="Copy address">
            <i class="hgi-stroke hgi-copy-01" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>

    <div class="dropdown-divider"></div>

    <div class="dropdown-info-list">
      <div class="dropdown-info-row">
        <span class="info-label">Active Role</span>
        <span class="info-value"><span class="badge safe" style="padding: 2px 8px; font-size: 0.72rem;"><i class="hgi-stroke ${roleIcon}"></i> ${escapeHtml(roleLabel)}</span></span>
      </div>
      <div class="dropdown-info-row">
        <span class="info-label">Network</span>
        <span class="info-value"><span class="badge" style="padding: 2px 8px; font-size: 0.72rem; background: #e0f2fe; color: #0284c7;"><i class="hgi-stroke hgi-server-03"></i> ${escapeHtml(networkLabel)}</span></span>
      </div>
      <div class="dropdown-info-row">
        <span class="info-label">Auth Method</span>
        <span class="info-value"><span class="badge" style="padding: 2px 8px; font-size: 0.72rem; background: #f1f5f9; color: var(--ink);"><i class="hgi-stroke hgi-fingerprint"></i> ${escapeHtml(modeBadgeText)}</span></span>
      </div>
      <div class="dropdown-info-row">
        <span class="info-label">Gas Status</span>
        <span class="info-value"><span class="badge safe" style="padding: 2px 8px; font-size: 0.72rem;"><i class="hgi-stroke hgi-flash"></i> Paymaster Sponsored</span></span>
      </div>
    </div>

    <div class="dropdown-divider"></div>

    <div class="dropdown-menu-actions">
      <button type="button" class="dropdown-btn" data-action="switch-account-action">
        <i class="hgi-stroke hgi-user-swap-01" aria-hidden="true"></i>
        <span>Switch Account / Persona</span>
      </button>
      <button type="button" class="dropdown-btn danger" data-action="sign-out-action">
        <i class="hgi-stroke hgi-logout-01" aria-hidden="true"></i>
        <span>Sign Out</span>
      </button>
    </div>
  `;
}

function toggleAccountDropdown(force) {
  const dd = $("#accountDropdown");
  const btn = $("#connectButton");
  if (!dd) return;
  const isCurrentlyActive = dd.classList.contains("active");
  const show = typeof force === "boolean" ? force : !isCurrentlyActive;
  
  if (show && account) {
    renderAccountDropdown();
    dd.classList.add("active");
    dd.setAttribute("aria-hidden", "false");
    btn?.setAttribute("aria-expanded", "true");
  } else {
    dd.classList.remove("active");
    dd.setAttribute("aria-hidden", "true");
    btn?.setAttribute("aria-expanded", "false");
  }
}

function signOut() {
  toggleAccountDropdown(false);
  account = null;
  smartAccountInfo = null;
  authMode = "web3";
  writeContract = null;
  write = null;
  activeRoles = [];
  updateModeControls();
  toast("Signed out successfully.");
  location.hash = "#/";
  render();
}

async function handleConnectClick() {
  if (account) {
    toggleAccountDropdown();
    return;
  }
  openSignInFlow();
}

async function openSignInFlow() {
  toggleAccountDropdown(false);
  const authChoice = await promptAuthModal();
  if (!authChoice) return;

  if (authChoice.authType === "web3") {
    return connectMetaMask(true);
  }

  if (authChoice.authType === "dev-persona") {
    account = authChoice.smartAccountAddress;
    authMode = "dev-persona";
    smartAccountInfo = authChoice;
    writeContract = read.connect(authChoice.signer);
    write = writeContract;
    walletProvider = null;

    activeRoles = [];
    for (const [key, id] of Object.entries(roleIds)) {
      if (await read.hasRole(id, account)) activeRoles.push(key);
    }

    updateModeControls();
    toast(`Connected as Dev Persona: ${authChoice.label}`);
    const nextRole = ROLE_LANDING_ORDER.find(role => activeRoles.includes(role));
    if (nextRole) {
      location.hash = `#/${nextRole === "logger" ? "sensor" : nextRole}`;
    }
    return render();
  }

  account = authChoice.smartAccountAddress;
  authMode = authChoice.authType;
  smartAccountInfo = authChoice;
  writeContract = read;
  write = writeContract;

  activeRoles = [];
  for (const [key, id] of Object.entries(roleIds)) {
    if (await read.hasRole(id, account)) activeRoles.push(key);
  }

  updateModeControls();
  toast(`Smart Account provisioned: ${short(account)} · ${authChoice.label} (Gasless Paymaster Active)`);

  const nextRole = ROLE_LANDING_ORDER.find(role => activeRoles.includes(role));
  if (nextRole) {
    location.hash = `#/${nextRole === "logger" ? "sensor" : nextRole}`;
  }
  render();
}

async function connectMetaMask(request = true) {
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
    authMode = "web3";
    smartAccountInfo = null;
    writeContract = read.connect(signer);
    write = writeContract;
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
    toast("MetaMask wallet connected."); 
    render();
  } catch (e) { 
    toast(friendly(e), true); 
  }
}

async function handleAccountChanged(accounts) { 
  if (!accounts.length) { 
    account = null; 
    write = null; 
    writeContract = null;
    activeRoles = []; 
    updateModeControls(); 
    location.hash = "#/"; 
    return render(); 
  } 
  await connectMetaMask(false); 
  const nextRole = ROLE_LANDING_ORDER.find(role => activeRoles.includes(role)); 
  if (nextRole) location.hash = `#/${nextRole === "logger" ? "sensor" : nextRole}`; 
}

let isTxPending = false;

async function sendWithPreflight(method, args = []) {
  if (authMode === "dev-persona" && writeContract) {
    const contractMethod = writeContract.getFunction(method);
    await contractMethod.staticCall(...args);
    const gasEstimate = await contractMethod.estimateGas(...args);
    const gasLimit = (gasEstimate * 120n) / 100n;
    return contractMethod(...args, { gasLimit });
  }

  if (authMode !== "web3" || !walletProvider) {
    console.log(`[Paymaster Flow] Sponsoring transaction for method: ${method}`);
    return VaxPassAA.sendSponsoredTransaction({
      provider: rpcProvider || (window.ethereum ? new ethers.BrowserProvider(window.ethereum) : null),
      targetContract: read,
      functionName: method,
      args,
      smartAccountAddress: account
    });
  }

  if (!walletProvider || !account) {
    throw new Error("Wallet is not connected to the configured contract.");
  }

  const walletNetwork = await walletProvider.getNetwork();
  if (Number(walletNetwork.chainId) !== Number(config.chainId)) {
    throw new Error(`MetaMask is on chain ${walletNetwork.chainId}; switch to chain ${config.chainId}.`);
  }

  const selectedAccounts = await walletProvider.send("eth_accounts", []);
  const selectedAccount = selectedAccounts.find(a => a.toLowerCase() === account.toLowerCase());
  if (!selectedAccount) {
    throw new Error("MetaMask account changed. Reconnect the selected account and try again.");
  }

  const signer = await walletProvider.getSigner(selectedAccount);
  const contractMethod = read.connect(signer).getFunction(method);
  await contractMethod.staticCall(...args);
  const gasEstimate = await contractMethod.estimateGas(...args);
  const gasLimit = (gasEstimate * 120n) / 100n;
  return contractMethod(...args, { gasLimit });
}

async function administerDose(id, commitment) {
  if (authMode === "dev-persona" && writeContract) {
    const contractMethod = writeContract.getFunction("administerDose");
    await contractMethod.staticCall(id, commitment);
    const gasEstimate = await contractMethod.estimateGas(id, commitment);
    const gasLimit = (gasEstimate * 120n) / 100n;
    return contractMethod(id, commitment, { gasLimit });
  }

  if (authMode !== "web3" || !walletProvider) {
    return VaxPassAA.sendSponsoredTransaction({
      provider: rpcProvider || (window.ethereum ? new ethers.BrowserProvider(window.ethereum) : null),
      targetContract: read,
      functionName: "administerDose",
      args: [id, commitment],
      smartAccountAddress: account
    });
  }

  const selectedAccounts = await walletProvider.send("eth_accounts", []);
  const selectedAccount = selectedAccounts.find(a => a.toLowerCase() === account.toLowerCase());
  if (!selectedAccount) {
    throw new Error("MetaMask account changed. Reconnect the selected clinic account and try again.");
  }

  const clinicRole = roleIds.clinic;
  if (!(await read.hasRole(clinicRole, selectedAccount))) {
    throw new Error("The connected wallet is not an approved clinic.");
  }

  const batch = await read.getBatch(id);
  if (batch.custodian.toLowerCase() !== selectedAccount.toLowerCase()) {
    throw new Error("This clinic is not the current on-chain custodian of this batch.");
  }
  if (![2, 3].includes(Number(batch.status))) {
    throw new Error("The batch must be delivered and fully confirmed before use.");
  }
  if (Number(batch.dosesRemaining) < 1) {
    throw new Error("This batch has no doses remaining.");
  }
  if (Number(batch.effectiveExpiry) <= Math.floor(Date.now() / 1000)) {
    throw new Error("This batch has expired.");
  }

  const signer = await walletProvider.getSigner(selectedAccount);
  const clinicContract = read.connect(signer);
  const administer = clinicContract.getFunction("administerDose");
  await administer.staticCall(id, commitment);
  const gasEstimate = await administer.estimateGas(id, commitment);
  const gasLimit = (gasEstimate * 120n) / 100n;
  return administer(id, commitment, { gasLimit });
}

async function tx(promiseOrFn, success = "Transaction confirmed.", functionName = "Transaction", rerender = true) { 
  if (isTxPending) {
    toast("Another transaction is currently processing. Please finish or cancel it first.", "warning");
    return null;
  }
  isTxPending = true;
  document.body.classList.add("tx-busy");
  const pendingToast = toast(
    authMode !== "web3" 
      ? "Sponsoring transaction via ERC-4337 Paymaster…" 
      : "Waiting for wallet signature & blockchain confirmation…", 
    "pending"
  ); 
  try { 
    const submittingAccount = account;
    const t = typeof promiseOrFn === "function" ? await promiseOrFn() : await promiseOrFn; 
    if (!t?.hash) {
      throw new Error("Transaction did not return a valid hash.");
    }
    const receipt = t.receipt ? t.receipt : await t.wait(1);
    pendingToast?.remove();
    lastTransaction = { 
      hash: receipt.hash, 
      block: receipt.blockNumber, 
      gas: receipt.gasUsed?.toString() || "—", 
      functionName, 
      from: t.from || submittingAccount,
      role: ROLE_LABELS[activeRoles[0]] || (authMode !== "web3" ? "Smart Account" : "Wallet")
    }; 
    updateTxDrawer(); 
    const sponsorNote = t.sponsored ? " (Gasless · 0 ETH Paid)" : "";
    toast(`${success}${sponsorNote} ${short(receipt.hash)} · block ${receipt.blockNumber}`, "success"); 
    if (rerender) await render(); 
    return receipt; 
  } catch (e) { 
    pendingToast?.remove();
    showShield(e); 
    if (rerender) await render(); 
    return null; 
  } finally {
    isTxPending = false;
    document.body.classList.remove("tx-busy");
  }
}

async function batches() {
  const fallback = async () => {
    const stats = await read.getStats();
    const count = Number(stats.totalBatches);
    return Promise.all(Array.from({ length: count }, (_, i) => read.getBatch(i + 1)));
  };

  if (window.VaxPassGraphQL) {
    try {
      const res = await VaxPassGraphQL.fetchBatches({ contractFallback: fallback });
      updateIndexerStatusBadge();
      return res.batches;
    } catch (err) {
      console.warn("GraphQL batches fetch error, using direct RPC fallback:", err);
      updateIndexerStatusBadge();
    }
  }

  return fallback();
}

function applyFilters(batchList) {
  let res = [...batchList];
  if (activeStatusFilter !== "all") {
    if (activeStatusFilter === "in_transit") {
      res = res.filter(b => Number(b.status) === 1);
    } else if (activeStatusFilter === "delivered") {
      res = res.filter(b => Number(b.status) === 2);
    } else if (activeStatusFilter === "in_use") {
      res = res.filter(b => Number(b.status) === 3);
    } else if (activeStatusFilter === "spoiled") {
      res = res.filter(b => Number(b.status) === 5);
    } else if (activeStatusFilter === "risk") {
      res = res.filter(b => statusClass(b) === "risk");
    } else if (activeStatusFilter === "safe") {
      res = res.filter(b => statusClass(b) === "safe");
    }
  }

  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase().trim();
    res = res.filter(b => 
      vx(b.id).toLowerCase().includes(q) || 
      (b.vaccineName && b.vaccineName.toLowerCase().includes(q)) || 
      (b.lotNumber && b.lotNumber.toLowerCase().includes(q)) ||
      (b.custodian && b.custodian.toLowerCase().includes(q))
    );
  }
  return res;
}

function renderBatchSkeletons(count = 3, mode = viewMode) {
  if (mode === "table") {
    return `
      <div class="data-table-container">
        <table class="enterprise-data-table">
          <thead>
            <tr>
              <th>Batch ID</th>
              <th>Vaccine & Lot</th>
              <th>Status</th>
              <th>Custodian</th>
              <th>Expiry</th>
              <th>Excursion Budget</th>
              <th style="text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${Array.from({ length: count }, () => `
              <tr>
                <td><div class="skeleton-pulse" style="width: 50px; height: 16px;"></div></td>
                <td><div class="skeleton-pulse" style="width: 140px; height: 16px;"></div></td>
                <td><div class="skeleton-pulse" style="width: 80px; height: 20px; border-radius: 999px;"></div></td>
                <td><div class="skeleton-pulse" style="width: 100px; height: 16px;"></div></td>
                <td><div class="skeleton-pulse" style="width: 110px; height: 16px;"></div></td>
                <td><div class="skeleton-pulse" style="width: 120px; height: 12px;"></div></td>
                <td style="text-align: right;"><div class="skeleton-pulse" style="width: 70px; height: 28px; display: inline-block;"></div></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }
  return `
    <div class="grid three">
      ${Array.from({ length: count }, () => `
        <div class="skeleton-card">
          <div class="skeleton-pulse skeleton-title"></div>
          <div class="skeleton-pulse" style="width: 40%; height: 14px;"></div>
          <div class="skeleton-pulse" style="width: 100%; height: 40px; margin-top: 8px;"></div>
          <div class="skeleton-pulse" style="width: 100%; height: 10px;"></div>
          <div class="skeleton-pulse" style="width: 70%; height: 32px; margin-top: 12px;"></div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderToolbar(allBatches = []) {
  const total = allBatches.length;
  const safeCount = allBatches.filter(b => statusClass(b) === "safe").length;
  const transitCount = allBatches.filter(b => Number(b.status) === 1).length;
  const deliveredCount = allBatches.filter(b => Number(b.status) === 2).length;
  const riskCount = allBatches.filter(b => statusClass(b) === "risk").length;
  const spoiledCount = allBatches.filter(b => Number(b.status) === 5).length;

  return `
    <div class="enterprise-toolbar">
      <div class="filter-group">
        <button type="button" class="filter-chip ${activeStatusFilter === 'all' ? 'active' : ''}" data-action="filter-status" data-status="all">
          <i class="hgi-stroke hgi-layers-01"></i>
          <span>All</span>
          <span class="chip-count">${total}</span>
        </button>
        <button type="button" class="filter-chip ${activeStatusFilter === 'safe' ? 'active' : ''}" data-action="filter-status" data-status="safe">
          <i class="hgi-stroke hgi-checkmark-circle-02"></i>
          <span>Safe</span>
          <span class="chip-count">${safeCount}</span>
        </button>
        <button type="button" class="filter-chip ${activeStatusFilter === 'in_transit' ? 'active' : ''}" data-action="filter-status" data-status="in_transit">
          <i class="hgi-stroke hgi-truck-delivery"></i>
          <span>In Transit</span>
          <span class="chip-count">${transitCount}</span>
        </button>
        <button type="button" class="filter-chip ${activeStatusFilter === 'delivered' ? 'active' : ''}" data-action="filter-status" data-status="delivered">
          <i class="hgi-stroke hgi-hospital-01"></i>
          <span>Delivered</span>
          <span class="chip-count">${deliveredCount}</span>
        </button>
        <button type="button" class="filter-chip ${activeStatusFilter === 'risk' ? 'active' : ''}" data-action="filter-status" data-status="risk">
          <i class="hgi-stroke hgi-alert-triangle"></i>
          <span>At Risk</span>
          <span class="chip-count">${riskCount}</span>
        </button>
        <button type="button" class="filter-chip ${activeStatusFilter === 'spoiled' ? 'active' : ''}" data-action="filter-status" data-status="spoiled">
          <i class="hgi-stroke hgi-cancel-circle"></i>
          <span>Spoiled</span>
          <span class="chip-count">${spoiledCount}</span>
        </button>
      </div>

      <div class="toolbar-controls">
        <div class="search-box">
          <i class="hgi-stroke hgi-search-01"></i>
          <input type="text" id="batchSearchInput" placeholder="Filter batch, vaccine, lot…" value="${escapeHtml(searchQuery)}" aria-label="Search batches">
          ${searchQuery ? `<button type="button" class="icon-button" data-action="clear-search" style="position: absolute; right: 6px; padding: 2px;" title="Clear search"><i class="hgi-stroke hgi-cancel-01" style="font-size: 0.75rem;"></i></button>` : ""}
        </div>
        <div class="view-toggle" role="group" aria-label="View toggle">
          <button type="button" class="${viewMode === 'grid' ? 'active' : ''}" data-action="set-view-mode" data-mode="grid" title="Passport Grid View">
            <i class="hgi-stroke hgi-grid-view"></i>
          </button>
          <button type="button" class="${viewMode === 'table' ? 'active' : ''}" data-action="set-view-mode" data-mode="table" title="Shadcn Enterprise Data Table">
            <i class="hgi-stroke hgi-menu-01"></i>
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderBatchTable(batchList, actionsFn = () => "") {
  return `
    <div class="data-table-container">
      <table class="enterprise-data-table">
        <thead>
          <tr>
            <th>Batch ID</th>
            <th>Vaccine & Lot</th>
            <th>Status</th>
            <th>Current Custodian</th>
            <th>Effective Expiry</th>
            <th>Excursion Usage</th>
            <th style="text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${batchList.map(b => {
            const pct = Number(b.excursionBudgetMins) 
              ? Math.min(100, Math.round(Number(b.excursionMinsUsed) * 100 / Number(b.excursionBudgetMins))) 
              : 0;
            const customActions = actionsFn(b);
            return `
              <tr data-batch-row="${b.id}">
                <td class="tabular-nums"><b>${vx(b.id)}</b></td>
                <td>
                  <div style="font-weight: 600;">${escapeHtml(b.vaccineName)}</div>
                  <small style="color: var(--muted); font-size: 0.74rem;">Lot: ${escapeHtml(b.lotNumber)} · <b>${Number(b.dosesRemaining)}</b>/${Number(b.totalDoses)} doses</small>
                </td>
                <td>${badge(b)}</td>
                <td>${copyableAddress(b.custodian)}</td>
                <td>
                  <div class="tabular-nums" style="font-size: 0.8rem; font-weight: 500;">${date(b.effectiveExpiry)}</div>
                  <small style="color: var(--muted); font-size: 0.72rem;">${countdown(b.effectiveExpiry)}</small>
                </td>
                <td>
                  <div style="display: flex; justify-content: space-between; font-size: 0.74rem; margin-bottom: 4px;">
                    <span class="tabular-nums font-bold">${b.excursionMinsUsed}m / ${b.excursionBudgetMins}m</span>
                    <span style="color: var(--muted); font-size: 0.7rem;">${pct}%</span>
                  </div>
                  <div class="progress ${Number(b.status) === 5 ? 'gauge-danger' : pct >= 50 ? 'gauge-warn' : 'gauge-safe'}" style="height: 6px; width: 120px;">
                    <i style="width:${pct}%"></i>
                  </div>
                </td>
                <td style="text-align: right; white-space: nowrap;">
                  <div style="display: inline-flex; gap: 6px; align-items: center; justify-content: flex-end;">
                    <a class="button light" style="padding: 4px 10px; font-size: 0.78rem;" href="#/batch/${b.id}">
                      <i class="hgi-stroke hgi-passport"></i> Passport
                    </a>
                    ${expiryAction(b)}
                    ${customActions}
                  </div>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderBatchView(batchList, actionsFn = () => "", emptyTitle = "No vaccine batches found", emptySubtitle = "No batches currently registered.", emptyAction = "", isFiltered = false) {
  const filtered = isFiltered ? applyFilters(batchList) : batchList;

  if (!filtered.length) {
    if (isFiltered && (activeStatusFilter !== "all" || searchQuery.trim())) {
      return emptyState(
        "No matching batches",
        `No batches found matching filter "${activeStatusFilter}"${searchQuery ? ` and search query "${escapeHtml(searchQuery)}"` : ""}.`,
        `<button type="button" class="button light" data-action="reset-filters"><i class="hgi-stroke hgi-filter-remove"></i> Clear Filters</button>`
      );
    }
    return emptyState(emptyTitle, emptySubtitle, emptyAction);
  }

  if (viewMode === "table") {
    return renderBatchTable(filtered, actionsFn);
  }

  return `
    <div class="grid three">
      ${filtered.map(b => batchCard(b, actionsFn(b))).join("")}
    </div>
  `;
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
        <a class="button light" href="#/batch/${b.id}"><i class="hgi-stroke hgi-passport"></i> Passport</a>
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
    app.innerHTML = `
      <div class="alert destructive">
        <div class="alert-icon"><i class="hgi-stroke hgi-alert-circle"></i></div>
        <div class="alert-body">
          <div class="alert-title">Blockchain Read Error</div>
          <div class="alert-description">${escapeHtml(friendly(e))}</div>
        </div>
      </div>
    `; 
  }
}

function renderAccessDenied(role) { 
  const label = ROLE_LABELS[role] || "required"; 
  const isLocalNode = Number(config?.chainId) === 31337;
  
  const devButtons = isLocalNode ? `
    <div style="margin-top: 18px; padding: 14px; background: rgba(15, 155, 157, 0.05); border: 1px dashed var(--teal); border-radius: var(--radius-md);">
      <small style="color: var(--teal); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; display: block; margin-bottom: 8px;">
        <i class="hgi-stroke hgi-flash"></i> Local Dev Fast-Access
      </small>
      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        ${account ? `
          <button type="button" class="button teal" data-action="dev-auto-approve-role" data-role="${role}">
            <i class="hgi-stroke hgi-shield-tick"></i> Dev: Auto-Grant ${label} Role to Current Account (${short(account)})
          </button>
        ` : ""}
        <button type="button" class="button light" data-action="quick-switch-persona" data-role="${role}">
          <i class="hgi-stroke hgi-user-switch"></i> Switch to Seeded ${label} Account
        </button>
      </div>
    </div>
  ` : "";

  app.innerHTML = page("Access restricted", `This workspace requires the approved ${label} role.`, `
    <div class="alert destructive">
      <div class="alert-icon"><i class="hgi-stroke hgi-shield-user"></i></div>
      <div class="alert-body">
        <div class="alert-title">RBAC Enforcement Active</div>
        <div class="alert-description">
          Connected account: ${copyableAddress(account)}. This address does not possess the on-chain <b>${label}</b> role.
          ${isLocalNode ? `<p style="margin-top: 6px;"><b>Local Dev Notice:</b> New Passkey or Email Smart Accounts start with zero roles. Click the button below to auto-grant this role via the local regulator.</p>` : ""}
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="button teal" data-action="connect"><i class="hgi-stroke hgi-wallet-01"></i> Switch Account</button>
      <a class="button light" href="#/register"><i class="hgi-stroke hgi-user-add-01"></i> Request a Role</a>
      <a class="button light" href="#/"><i class="hgi-stroke hgi-home-01"></i> Return Home</a>
    </div>
    ${devButtons}
  `); 
}

async function autoApproveRole(roleKey) {
  try {
    const roleId = roleIds[roleKey];
    if (!roleId || !account) return;
    const pendingToast = toast(`Granting ${ROLE_LABELS[roleKey]} role to ${short(account)} on-chain…`, "pending");
    
    // Regulator is Signer #0 on local node
    const regulatorSigner = await rpcProvider.getSigner(0);
    const contractWithRegulator = read.connect(regulatorSigner);

    let tx;
    try {
      tx = await contractWithRegulator.grantRole(roleId, account);
      await tx.wait();
    } catch {
      const accSigner = await rpcProvider.getSigner(account).catch(() => regulatorSigner);
      try {
        const reqTx = await read.connect(accSigner).requestRole(roleId);
        await reqTx.wait();
      } catch (_) {}
      tx = await contractWithRegulator.approveEntity(account, roleId);
      await tx.wait();
    }

    pendingToast?.remove();
    toast(`Successfully granted ${ROLE_LABELS[roleKey]} role to ${short(account)}!`, "success");
    if (!activeRoles.includes(roleKey)) activeRoles.push(roleKey);
    render();
  } catch (err) {
    dismissPendingToasts();
    toast(`Failed to grant role: ${err.message}`, true);
  }
}

async function quickSwitchPersona(roleKey) {
  const persona = DEV_PERSONAS.find(p => p.role === roleKey);
  if (!persona) return;
  const signer = await rpcProvider.getSigner(persona.index);
  account = persona.address;
  authMode = "dev-persona";
  smartAccountInfo = {
    authType: "dev-persona",
    smartAccountAddress: persona.address,
    label: `${persona.name} (Dev #${persona.index})`,
    signer
  };
  writeContract = read.connect(signer);
  write = writeContract;
  walletProvider = null;

  activeRoles = [];
  for (const [key, id] of Object.entries(roleIds)) {
    if (await read.hasRole(id, account)) activeRoles.push(key);
  }

  updateModeControls();
  toast(`Switched to Dev ${persona.name} (#${persona.index})`);
  render();
}

async function renderHome() {
  const list = await batches(); 
  
  app.innerHTML = `
    <section class="hero">
      <div class="eyebrow"><i class="hgi-stroke hgi-shield-tick"></i> Cold-Chain Blockchain Passport</div>
      <h1>A tamper-evident passport for every vaccine batch.</h1>
      <p>VaxPass records custodian handovers, temperature excursions, dynamic expiry reduction, and zero-knowledge dose administration on Ethereum & Layer-2.</p>
      <div class="hero-badges">
        <span><i class="hgi-stroke hgi-shield-tick"></i> On-Chain Role Custody</span>
        <span><i class="hgi-stroke hgi-thermometer-cold"></i> Real-Time Excursion Burn-down</span>
        <span><i class="hgi-stroke hgi-lock-key"></i> Zero-Knowledge Patient Privacy</span>
        <span><i class="hgi-stroke hgi-server-03"></i> Subgraph Indexed Queries</span>
      </div>
      <div class="hero-actions">
        <a class="button teal" href="#/verify"><i class="hgi-stroke hgi-qr-code"></i> Verify a Batch</a>
        <button class="button light" data-action="connect"><i class="hgi-stroke hgi-wallet-01"></i> ${account ? `Connected (${short(account)})` : "Connect Wallet"}</button>
      </div>
    </section>

    <section class="grid three" style="margin:24px 0">
      <a class="quick" href="#/manufacturer">
        <div class="quick-icon-group">
          <div class="quick-icon-badge"><i class="hgi-stroke hgi-factory"></i></div>
          <div><b>Register a Batch</b><br><small class="muted">Manufacturer initialization</small></div>
        </div>
        <span><i class="hgi-stroke hgi-arrow-right-01"></i></span>
      </a>
      <a class="quick" href="#/distributor">
        <div class="quick-icon-group">
          <div class="quick-icon-badge"><i class="hgi-stroke hgi-truck-delivery"></i></div>
          <div><b>Track Custody</b><br><small class="muted">Dual-handover in transit</small></div>
        </div>
        <span><i class="hgi-stroke hgi-arrow-right-01"></i></span>
      </a>
      <a class="quick" href="#/clinic">
        <div class="quick-icon-group">
          <div class="quick-icon-badge"><i class="hgi-stroke hgi-hospital-01"></i></div>
          <div><b>Administer Safely</b><br><small class="muted">Private hashed dose log</small></div>
        </div>
        <span><i class="hgi-stroke hgi-arrow-right-01"></i></span>
      </a>
    </section>

    ${page("Vaccine Batches Register", "Indexed cold-chain records with GraphQL subsecond query performance.", `
      ${renderBatchView(list, () => "", "No vaccine batches yet", "Register a new batch from the Manufacturer workspace to begin tracking.", '<a class="button teal" href="#/manufacturer"><i class="hgi-stroke hgi-factory"></i> Register First Batch</a>')}
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
        <span class="role-chip"><i class="hgi-stroke hgi-activity-01"></i> Auto-updating</span>
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
          <button class="button teal"><i class="hgi-stroke hgi-user-add-01"></i> Request role</button>
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
            <button class="button teal" name="op" value="approve"><i class="hgi-stroke hgi-checkmark-circle-02"></i> Approve requested role</button>
            <button class="button danger" name="op" value="revoke"><i class="hgi-stroke hgi-cancel-circle"></i> Revoke</button>
          </div>
        </form>
      </div>
      <div class="card">
        <h3>Recall a batch</h3>
        <form id="recallForm">
          <label>Batch ID<input id="recallId" min="1" type="number" required placeholder="1"></label>
          <label>Reason<textarea id="recallReason" required placeholder="Safety notice or quality reason"></textarea></label>
          <button class="button danger"><i class="hgi-stroke hgi-alert-triangle"></i> Recall batch</button>
        </form>
      </div>
    </div>
  `);
}

async function renderManufacturer() {
  const list = await batches(); 
  const mine = account ? list.filter(b => b.manufacturer.toLowerCase() === account.toLowerCase()) : [];
  const actions = b => Number(b.status) === 0 && b.custodian.toLowerCase() === account?.toLowerCase() 
    ? `<button class="button teal" data-action="dispatch" data-id="${b.id}"><i class="hgi-stroke hgi-truck-delivery"></i> Dispatch</button>` 
    : `<button class="button light" disabled title="Only the current custodian can dispatch a manufactured batch."><i class="hgi-stroke hgi-lock-key"></i> Dispatch unavailable</button>`;

  app.innerHTML = page("Manufacturer workspace", "Register a vaccine batch and begin its cold-chain passport.", `
    <div class="grid two">
      <div class="card">
        <h3>Register batch</h3>
        <form id="batchForm">
          <div style="margin-bottom: 12px;">
            <button type="button" class="button light" data-action="scan-gs1-register" style="width: 100%;">
              <i class="hgi-stroke hgi-barcode-scanner"></i> Scan GS1 2D DataMatrix (Camera)
            </button>
          </div>
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
          <button class="button teal"><i class="hgi-stroke hgi-checkmark-circle-02"></i> Register on-chain</button>
        </form>
      </div>
      <div class="card">
        <h3>Dispatch instructions</h3>
        <p>Use the dispatch button on a manufactured batch to assign custody to an approved distributor. A popup modal will prompt for their Ethereum address.</p>
        <div class="alert info">
          <div class="alert-icon"><i class="hgi-stroke hgi-user-check-01"></i></div>
          <div class="alert-body">
            <div class="alert-title">Connected Identity</div>
            <div class="alert-description">${account ? copyableAddress(account) : "Connect the manufacturer wallet to see your registered batches."}</div>
          </div>
        </div>
      </div>
    </div>
    <h2 style="margin-top:32px">My batches</h2>
    ${mine.length ? renderToolbar(mine) : ''}
    ${renderBatchView(mine, actions, "No manufacturer batches found", account ? "You haven't registered any batches with this wallet yet." : "Connect the manufacturer wallet to view your batches.", account ? '<a class="button teal" href="#batchForm"><i class="hgi-stroke hgi-factory"></i> Register Batch Above</a>' : '<button class="button teal" data-action="connect"><i class="hgi-stroke hgi-wallet-01"></i> Connect Wallet</button>', true)}
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
        b.clinicConfirmed = await read.clinicConfirmed(b.id);
        outgoing.push(b); 
      } 
    }
  }

  const incomingActions = b => `<button class="button teal" data-action="accept" data-id="${b.id}"><i class="hgi-stroke hgi-checkmark-circle-02"></i> Accept custody</button>`;
  const outgoingActions = b => {
    const isTransit = Number(b.status) === 1;
    const hasClinic = !b.clinic.match(/^0x0+$/);
    if (isTransit && !hasClinic) {
      return `<button class="button teal" data-action="deliver" data-id="${b.id}"><i class="hgi-stroke hgi-hospital-01"></i> Deliver to clinic</button>`;
    }
    if (isTransit && hasClinic) {
      if (!b.distributorConfirmed) {
        return `<button class="button teal" data-action="confirm" data-id="${b.id}"><i class="hgi-stroke hgi-checkmark-circle-02"></i> Confirm handover</button>`;
      }
      if (b.distributorConfirmed && !b.clinicConfirmed) {
        return `<button class="button light" disabled title="You have confirmed handover on-chain. Waiting for destination clinic to confirm receipt."><i class="hgi-stroke hgi-clock-01"></i> Awaiting clinic confirmation</button>`;
      }
      return `<span class="badge safe"><i class="hgi-stroke hgi-checkmark-circle-02"></i> Handover complete</span>`;
    }
    if (Number(b.status) === 2) {
      return `<span class="badge safe"><i class="hgi-stroke hgi-checkmark-circle-02"></i> Delivered to clinic</span>`;
    }
    return `<button class="button light" disabled title="No action pending for this batch."><i class="hgi-stroke hgi-information-circle"></i> In custody</button>`;
  };

  const activeTabList = distributorTab === 'incoming' ? incoming : outgoing;
  const activeTabActions = distributorTab === 'incoming' ? incomingActions : outgoingActions;

  app.innerHTML = page("Distributor workspace", "Accept shipments, identify the destination clinic, and confirm dual handover.", `
    <div style="margin-bottom: 16px; display: flex; justify-content: flex-end;">
      <button class="button light" data-action="scan-gs1-distributor">
        <i class="hgi-stroke hgi-barcode-scanner"></i> Scan Barcode Intake
      </button>
    </div>
    <div class="tabs">
      <div class="tabs-list" role="tablist">
        <button class="tabs-trigger ${distributorTab === 'incoming' ? 'active' : ''}" data-action="switch-dist-tab" data-tab="incoming">
          <i class="hgi-stroke hgi-inbox-in"></i> Incoming Requests (${incoming.length})
        </button>
        <button class="tabs-trigger ${distributorTab === 'outgoing' ? 'active' : ''}" data-action="switch-dist-tab" data-tab="outgoing">
          <i class="hgi-stroke hgi-truck-delivery"></i> In-Transit Custody (${outgoing.length})
        </button>
      </div>

      <div style="margin-top: 16px;">
        ${renderBatchView(
          activeTabList, 
          activeTabActions, 
          distributorTab === 'incoming' ? "No incoming requests" : "No batches in your custody", 
          distributorTab === 'incoming' ? "When a manufacturer dispatches a batch to your distributor address, it will appear here." : "Batches you have accepted custody for will be listed here until delivered."
        )}
      </div>
    </div>
  `);
}

async function renderClinic() {
  const list = await batches(); 
  const relevant = [];
  if (account) {
    for (const b of list) {
      if (b.clinic.toLowerCase() === account.toLowerCase() || b.custodian.toLowerCase() === account.toLowerCase()) {
        b.distributorConfirmed = await read.distributorConfirmed(b.id);
        b.clinicConfirmed = await read.clinicConfirmed(b.id);
        relevant.push(b);
      }
    }
  }
  
  const actions = b => { 
    if (Number(b.status) === 1 && b.clinic.toLowerCase() === account?.toLowerCase()) {
      if (!b.clinicConfirmed) {
        return `<button class="button teal" data-action="confirm" data-id="${b.id}"><i class="hgi-stroke hgi-checkmark-circle-02"></i> Confirm receipt</button>`; 
      }
      return `<button class="button light" disabled title="Clinic receipt confirmed on-chain. Waiting for distributor to confirm handover."><i class="hgi-stroke hgi-clock-01"></i> Receipt confirmed · Awaiting distributor</button>`;
    }
    if ([2, 3].includes(Number(b.status)) && b.custodian.toLowerCase() === account?.toLowerCase()) {
      return `<button class="button teal" data-action="administer" data-id="${b.id}"><i class="hgi-stroke hgi-injection"></i> Administer dose</button>`; 
    }
    return ""; 
  };

  app.innerHTML = page("Clinic workspace", "Confirm receipt, then administer doses with zero-knowledge patient hashing.", `
    <div class="alert info">
      <div class="alert-icon"><i class="hgi-stroke hgi-lock-key"></i></div>
      <div class="alert-body">
        <div class="alert-title">Zero-Knowledge Patient Privacy</div>
        <div class="alert-description">Patient identifiers are salted with clinic-unique keys and hashed in your browser. Raw patient IDs are never transmitted or exposed on-chain.</div>
      </div>
    </div>
    <div style="margin-top:22px">
      ${renderBatchView(relevant, actions, "No clinic deliveries found", "When a distributor designates your clinic for delivery, the batch will appear here.")}
    </div>
  `);
}

async function renderSensorConsole(id = selectedSensorBatch) {
  if (!activeRoles.includes("logger")) {
    return app.innerHTML = page("Sensor console", "Switch to an approved Temperature Logger account to record simulated readings.", `
      <div class="card empty">
        <a class="button teal" href="#/batch/${id || 1}"><i class="hgi-stroke hgi-passport"></i> Open batch passport</a>
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
          <button class="button teal" data-action="sensor-mode" data-mode="normal"><i class="hgi-stroke hgi-checkmark-circle-02"></i> Normal (2–8 °C)</button>
          <button class="button" data-action="sensor-mode" data-mode="spike"><i class="hgi-stroke hgi-alert-triangle"></i> Spike (12–15 °C)</button>
          <button class="button danger" data-action="sensor-mode" data-mode="breach"><i class="hgi-stroke hgi-fire"></i> Breach (22–25 °C)</button>
        </div>
        <div class="sensor-custom">
          <label>Custom temperature (°C)<input id="sensorTemp" type="number" step="0.1" value="5"></label>
          <label>Duration (minutes)<input id="sensorDuration" type="number" min="1" value="5"></label>
          <button class="button light" data-action="sensor-custom"><i class="hgi-stroke hgi-thermometer-cold"></i> Log custom reading</button>
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
        ${Number(batch.status) === 5 ? `
          <div class="alert destructive sensor-alert">
            <div class="alert-icon"><i class="hgi-stroke hgi-alert-triangle"></i></div>
            <div class="alert-body">
              <div class="alert-title">SPOILED BATCH</div>
              <div class="alert-description">Excursion budget exceeded. Smart contract blocks further custody and doses.</div>
            </div>
          </div>
        ` : ""}
        <div class="sensor-feed">
          ${sensorFeed.length ? sensorFeed.map(item => `
            <div class="sensor-reading ${item.state}">
              <span><i class="hgi-stroke ${item.state === "pending" ? "hgi-loading-03" : item.state === "confirmed" ? "hgi-checkmark-circle-02" : "hgi-cancel-circle"}"></i></span>
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
  if (!activeRoles.includes("logger") && authMode === "web3") return toast("Switch to the Temperature Logger account first.", true);
  
  sensorFeed = [];
  for (const [tempX10, durationMins] of readings) {
    sensorFeed.push({ temp: (tempX10 / 10).toFixed(1), duration: durationMins, state: "pending" }); 
    await renderSensorConsole(id);

    let receipt = null;
    try {
      if (read.submitSignedTelemetry && window.HardwareEnclave && walletProvider) {
        const signer = await walletProvider.getSigner();
        const sensorAddress = await signer.getAddress();
        const nonce = await read.sensorNonces(sensorAddress).catch(() => 0n);
        const payload = {
          batchId: BigInt(id),
          tempX10: BigInt(tempX10),
          durationMins: BigInt(durationMins),
          nonce: BigInt(nonce),
          timestamp: BigInt(Math.floor(Date.now() / 1000))
        };
        const { signature } = await HardwareEnclave.signTelemetry(signer, config.address, config.chainId, payload);
        receipt = await tx(() => sendWithPreflight("submitSignedTelemetry", [payload, signature]), "Hardware EIP-712 telemetry recorded.", "submitSignedTelemetry", false);
      } else {
        receipt = await tx(() => sendWithPreflight("logTemperature", [id, tempX10, durationMins]), "Telemetry reading recorded.", "logTemperature", false);
      }
    } catch (err) {
      console.warn("Telemetry submission error:", err);
      receipt = null;
    }

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
  const sensorLink = activeRoles.includes("logger") ? `<a class="button light" href="#/sensor/${id}"><i class="hgi-stroke hgi-thermometer-cold"></i> Open Sensor Console</a>` : "";

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

      <!-- Shadcn Framed QR Code Component -->
      <section class="qr-card">
        <div class="qr-card-header">
          <div class="qr-card-title-group">
            <h3 class="qr-card-title"><i class="hgi-stroke hgi-qr-code"></i> Public Verification QR</h3>
            <p class="qr-card-description">Instant field verification for clinics, regulators, and recipients</p>
          </div>
          <span class="qr-card-badge"><i class="hgi-stroke hgi-shield-tick"></i> Verified on Ethereum</span>
        </div>

        <div class="qr-card-content">
          <div class="qr-viewfinder">
            <div class="qr-brackets-other"></div>
            <div id="qr" class="qr-canvas-holder" aria-label="QR code for batch verification"></div>
          </div>
          <div class="qr-url-pill">
            <i class="hgi-stroke hgi-link-01"></i>
            <span class="qr-url-text">${escapeHtml(qrUrl)}</span>
          </div>
        </div>

        <div class="qr-card-footer">
          <button type="button" class="button light" data-action="copy-qr-url" data-url="${escapeHtml(qrUrl)}">
            <i class="hgi-stroke hgi-copy-01"></i> Copy Link
          </button>
          <button type="button" class="button light" data-action="download-qr" data-id="${b.id}">
            <i class="hgi-stroke hgi-download-01"></i> Download QR
          </button>
          <a class="button light" href="#/verify/${b.id}">
            <i class="hgi-stroke hgi-link-external-01"></i> Verify Now
          </a>
          ${isLocalFrontend() ? `<button type="button" class="button light" data-action="set-qr-url"><i class="hgi-stroke hgi-wifi-01"></i> Set Phone IP</button>` : ""}
        </div>
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
        <h3>Temperature record</h3>
        <canvas id="tempChart" class="chart" width="520" height="220"></canvas>
        <p class="muted" style="margin: 8px 0 16px">${logs.length} telemetry reading(s); values in °C.</p>
        
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
                  <td>${l.excursion ? `<span style="color:var(--danger)"><i class="hgi-stroke hgi-alert-triangle"></i> Excursion</span>` : `<span style="color:var(--safe)"><i class="hgi-stroke hgi-checkmark-circle-02"></i> In range</span>`}</td>
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
        <button class="role-chip" data-action="verify-chip" data-id="1"><i class="hgi-stroke hgi-qr-code"></i> Try Batch VX001</button>
        <button class="role-chip" data-action="verify-chip" data-id="2"><i class="hgi-stroke hgi-qr-code"></i> Try Batch VX002</button>
      </div>
      <form id="verifyForm">
        <label>Batch ID or GS1 Lot Number (e.g. 1, VX001, or LOT-2026-COV01)
          <input id="verifyId" value="${initialId ? `VX${String(initialId).padStart(3, "0")}` : ""}" placeholder="VX001" required>
        </label>
        <div style="display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap;">
          <button class="button teal"><i class="hgi-stroke hgi-search-01"></i> Verify batch</button>
          <button type="button" class="button light" data-action="scan-gs1-verify"><i class="hgi-stroke hgi-barcode-scanner"></i> Scan 2D DataMatrix</button>
        </div>
      </form>
    </div>
    <div id="verifyResult" style="margin-top:20px"></div>
  `);
  
  if (initialId) verify(initialId);
}

async function verify(raw) { 
  const target = $("#verifyResult"); 
  if (!target) return;
  const str = String(raw).trim();
  if (!str) return target.innerHTML = `<div class="alert destructive"><div class="alert-icon"><i class="hgi-stroke hgi-alert-circle"></i></div><div class="alert-body"><div class="alert-title">Invalid Input</div><div class="alert-description">Please enter a valid batch ID or lot number.</div></div></div>`; 

  let id = null;
  if (/^VX\d+$/i.test(str) || /^\d+$/.test(str)) {
    id = Number(str.replace(/\D/g, ""));
  } else {
    const list = await batches();
    const match = list.find(b => b.lotNumber.toLowerCase() === str.toLowerCase());
    if (match) id = Number(match.id);
  }

  if (!id) {
    return target.innerHTML = `<div class="alert destructive"><div class="alert-icon"><i class="hgi-stroke hgi-alert-circle"></i></div><div class="alert-body"><div class="alert-title">Batch Not Found</div><div class="alert-description">No active batch matching "${escapeHtml(str)}" was found on-chain.</div></div></div>`;
  }
  
  const result = await read.verifyBatch(id); 
  const code = Number(result.code);
  const label = ["VALID", "WARNING", "INVALID"][code]; 
  const iconName = code === 0 ? "hgi-checkmark-circle-02" : code === 1 ? "hgi-alert-triangle" : "hgi-cancel-circle";
  
  target.innerHTML = `
    <div class="verify-banner verify-${["valid","warning","invalid"][code]}">
      <h2><i class="hgi-stroke ${iconName}"></i> ${label}</h2>
      <p style="font-size:1.05rem; margin:0 0 16px">${escapeHtml(result.message)}</p>
      ${code !== 2 ? `<a class="button light" href="#/batch/${id}"><i class="hgi-stroke hgi-passport"></i> Open full passport</a>` : ""}
    </div>
  `; 
}

async function renderAnalytics() {
  let statsData = null;
  if (window.VaxPassGraphQL) {
    try {
      const res = await VaxPassGraphQL.fetchProtocolStats(async () => read.getStats());
      if (res?.stats) {
        statsData = res.stats;
      }
    } catch (err) {
      console.warn("GraphQL protocol stats failed, using on-chain RPC fallback:", err);
    }
  }
  if (!statsData) {
    const raw = await read.getStats();
    statsData = {
      totalBatches: Number(raw.totalBatches),
      dosesAdministered: Number(raw.dosesAdministered),
      spoiled: Number(raw.spoiled),
      recalled: Number(raw.recalled),
      expired: Number(raw.expired)
    };
  }

  const total = Number(statsData.totalBatches || 0);
  const spoiled = Number(statsData.spoiled || 0);
  const recalled = Number(statsData.recalled || 0);
  const expired = Number(statsData.expired || 0);
  const doses = Number(statsData.dosesAdministered || 0);
  const wastage = total ? (((spoiled + recalled + expired) / total) * 100).toFixed(1) : "0.0";

  app.innerHTML = page("Network analytics", "A real-time snapshot of batch volumes, patient impact, and cold-chain compliance.", `
    <div class="grid four analytics-stats">
      <div class="stat-card">
        <div class="stat-card-header">
          <span class="stat-card-kicker">Tracked inventory</span>
          <div class="stat-card-icon"><i class="hgi-stroke hgi-package"></i></div>
        </div>
        <div class="stat-card-value">${total}</div>
        <div class="stat-card-caption">Batch${total === 1 ? "" : "es"} registered</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-header">
          <span class="stat-card-kicker">Patient impact</span>
          <div class="stat-card-icon"><i class="hgi-stroke hgi-injection"></i></div>
        </div>
        <div class="stat-card-value">${doses}</div>
        <div class="stat-card-caption">Doses administered</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-header">
          <span class="stat-card-kicker">Safety action</span>
          <div class="stat-card-icon"><i class="hgi-stroke hgi-alert-triangle"></i></div>
        </div>
        <div class="stat-card-value">${spoiled}</div>
        <div class="stat-card-caption">Spoiled batches</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-header">
          <span class="stat-card-kicker">Loss signal</span>
          <div class="stat-card-icon"><i class="hgi-stroke hgi-analytics-01"></i></div>
        </div>
        <div class="stat-card-value">${wastage}%</div>
        <div class="stat-card-caption">Wastage rate</div>
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
    // Outside-click detection for account dropdown
    if (!e.target.closest(".account-menu-container")) {
      toggleAccountDropdown(false);
    }

    const actionTarget = e.target.closest("[data-action]");
    if (!actionTarget) return;
    const action = actionTarget.dataset.action; 
    if (!action) return;

    if (action === "switch-account-action") {
      return openSignInFlow();
    }

    if (action === "sign-out-action") {
      return signOut();
    }

    if (action === "copy-account-addr") {
      const addr = actionTarget.dataset.address;
      if (addr) {
        try {
          await navigator.clipboard.writeText(addr);
          toast(`Account address copied: ${short(addr)}`);
        } catch {
          toast(`Address: ${addr}`);
        }
      }
      return;
    }

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

    if (action === "copy-qr-url") {
      const url = actionTarget.dataset.url;
      if (url) {
        try {
          await navigator.clipboard.writeText(url);
          toast("Verification link copied to clipboard.");
        } catch {
          toast(url);
        }
      }
      return;
    }

    if (action === "download-qr") {
      const qrEl = $("#qr");
      const img = qrEl?.querySelector("img");
      const canvas = qrEl?.querySelector("canvas");
      let dataUrl = img?.src;
      if (!dataUrl && canvas) {
        dataUrl = canvas.toDataURL("image/png");
      }
      if (dataUrl) {
        const link = document.createElement("a");
        link.download = `VaxPass-Batch-${vx(actionTarget.dataset.id)}-QR.png`;
        link.href = dataUrl;
        link.click();
        toast("Batch QR code downloaded.");
      } else {
        toast("QR code image not ready yet.", true);
      }
      return;
    }

    if (action === "switch-dist-tab") {
      distributorTab = actionTarget.dataset.tab;
      document.querySelectorAll(".tabs-trigger").forEach(t => t.classList.toggle("active", t.dataset.tab === distributorTab));
      const contents = document.querySelectorAll(".tabs-content");
      if (contents[0]) contents[0].classList.toggle("active", distributorTab === "incoming");
      if (contents[1]) contents[1].classList.toggle("active", distributorTab === "outgoing");
      return;
    }

    if (action === "set-view-mode") {
      viewMode = actionTarget.dataset.mode || "grid";
      localStorage.setItem("vaxpassViewMode", viewMode);
      render();
      return;
    }

    if (action === "filter-status") {
      activeStatusFilter = actionTarget.dataset.status || "all";
      render();
      return;
    }

    if (action === "reset-filters") {
      activeStatusFilter = "all";
      searchQuery = "";
      render();
      return;
    }

    if (action === "clear-search") {
      searchQuery = "";
      render();
      return;
    }

    if (action === "dev-auto-approve-role") {
      const r = actionTarget.dataset.role;
      return autoApproveRole(r);
    }

    if (action === "quick-switch-persona") {
      const r = actionTarget.dataset.role;
      return quickSwitchPersona(r);
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
      return tx(() => sendWithPreflight("markExpired", [Number(actionTarget.dataset.id)]), "Batch marked expired.", "markExpired");
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
      return tx(() => sendWithPreflight("acceptCustody", [id]), "Custody accepted.", "acceptCustody");
    }

    if (action === "confirm") {
      return tx(() => sendWithPreflight("confirmReceipt", [id]), "Receipt confirmation recorded.", "confirmReceipt");
    }

    if (action === "dispatch") { 
      const address = await promptAddressModal({
        title: `Dispatch Batch ${vx(id)}`,
        subtitle: "Assign cold-chain custody to an authorized distributor",
        roleLabel: "Distributor",
        iconType: "distributor"
      });
      if (address) {
        return tx(
          () => sendWithPreflight("dispatchBatch", [id, address]),
          "Batch dispatched to distributor.",
          "dispatchBatch"
        );
      }
      return;
    } 

    if (action === "deliver") { 
      const address = await promptAddressModal({
        title: `Deliver Batch ${vx(id)} to Clinic`,
        subtitle: "Designate clinic destination; awaiting dual-handover receipt confirmation",
        roleLabel: "Clinic",
        iconType: "clinic"
      });
      if (address) {
        return tx(() => sendWithPreflight("deliverToClinic", [id, address]), "Clinic delivery destination set; await dual confirmation.", "deliverToClinic");
      }
      return;
    } 

    if (action === "administer") { 
      const patientId = await promptPatientModal({ batchId: id });
      if (!patientId) return;
      const b = await read.getBatch(id);
      const doseReceipt = window.VaxPassReceipt
        ? VaxPassReceipt.createDoseReceipt({
            batchId: id,
            rawPatientId: patientId,
            vaccineName: b.vaccineName,
            lotNumber: b.lotNumber || vx(id)
          })
        : { commitment: ethers.keccak256(ethers.toUtf8Bytes(patientId)), salt: "0x", batchId: id, vaccineName: b.vaccineName };

      const receipt = await tx(
        () => administerDose(id, doseReceipt.commitment),
        "Dose administered; salted cryptographic commitment recorded on-chain.",
        "administerDose"
      );
      if (receipt) {
        promptReceiptModal(doseReceipt);
      }
      return;
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
      return tx(() => sendWithPreflight("requestRole", [roleIds[key]]), "Role request submitted for regulator approval.", "requestRole");
    } 

    if (f.id === "entityForm") {
      const a = $("#entityAddress").value.trim();
      const r = roleIds[$("#entityRole").value];
      const op = e.submitter?.value;
      if (!ethers.isAddress(a)) return toast("Enter a valid Ethereum wallet address.", true);
      return tx(
        () => sendWithPreflight(op === "revoke" ? "revokeEntity" : "approveEntity", [a, r]),
        op === "revoke" ? "Role revoked on-chain." : "Entity approved on-chain.",
        op === "revoke" ? "revokeEntity" : "approveEntity"
      );
    } 

    if (f.id === "recallForm") {
      return tx(() => sendWithPreflight("recallBatch", [$("#recallId").value, $("#recallReason").value]), "Batch recalled on-chain.", "recallBatch");
    } 

    if (f.id === "batchForm") {
      const expiry = Math.floor(new Date($("#printedExpiry").value).getTime() / 1000); 
      if (!expiry) return toast("Choose a valid expiry date.", true); 
      return tx(
        () => sendWithPreflight("registerBatch", [
          $("#vaccineName").value,
          $("#lotNumber").value,
          $("#doses").value,
          expiry,
          Math.round(Number($("#minTemp").value) * 10),
          Math.round(Number($("#maxTemp").value) * 10),
          $("#budget").value,
          $("#cid").value
        ]),
        "Batch registered on Ethereum.",
        "registerBatch"
      );
    } 
  }); 

  let searchDebounce = null;
  document.addEventListener("input", e => {
    if (e.target.id === "batchSearchInput") {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchQuery = e.target.value;
        render();
        const inp = $("#batchSearchInput");
        if (inp) {
          inp.focus();
          inp.setSelectionRange(inp.value.length, inp.value.length);
        }
      }, 250);
    }
  });
}

init().catch(e => { 
  app.innerHTML = `
    <div class="alert destructive">
      <div class="alert-icon"><i class="hgi-stroke hgi-alert-circle"></i></div>
      <div class="alert-body">
        <div class="alert-title">Startup Error</div>
        <div class="alert-description">${escapeHtml(friendly(e))}</div>
      </div>
    </div>
  `; 
});
