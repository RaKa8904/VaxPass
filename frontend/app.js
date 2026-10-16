/* VaxPass front end: no framework, no patient data stored in the browser or chain. */
const $ = (s) => document.querySelector(s);
const app = $("#app");
const STATUS = ["MANUFACTURED", "IN TRANSIT", "DELIVERED", "IN USE", "DEPLETED", "SPOILED", "RECALLED", "EXPIRED"];
const ROLE_LABELS = { manufacturer: "Manufacturer", distributor: "Distributor", clinic: "Clinic", logger: "Temperature Logger" };
const DEMO_ROLES = ["regulator", "manufacturer", "distributor", "clinic", "logger"];
const DEMO_ROLE_LABELS = { regulator: "Regulator", manufacturer: "Manufacturer", distributor: "Distributor", clinic: "Clinic", logger: "Temperature Logger" };
const SENSOR_READINGS = { normal: [[25, 5], [45, 5], [70, 5]], spike: [[120, 3], [150, 3], [65, 5]], breach: [[220, 20], [250, 20]] };
const GUIDE_STEPS = [
  ["Open Verify", "Public verification needs no wallet.", "#/verify/1", "regulator"],
  ["View Passport", "Read the custody and temperature record.", "#/batch/1", "regulator"],
  ["Normal readings", "In-range readings preserve the cold chain.", "#/sensor/1", "logger"],
  ["Spike readings", "Short excursions reduce effective expiry.", "#/sensor/1", "logger"],
  ["Breach -> SPOILED -> INVALID", "The contract blocks unsafe batches.", "#/sensor/1", "logger"],
  ["Safe flow on VX002", "Show dispatch, custody, clinic selection, and dual confirmation.", "#/batch/2", "manufacturer"],
  ["Administer dose", "Patient identifiers are hashed and duplicates are blocked.", "#/clinic", "clinic"],
  ["Regulator recall", "A recall permanently blocks later batch use.", "#/regulator", "regulator"],
  ["Analytics", "Summarize batches, doses, and safety outcomes.", "#/analytics", "regulator"]
];
let config, read, walletProvider, write, account, activeRoles = [], roleIds = {}, mode = "live", activeDemoRole = "regulator", rpcProvider, demoSigners = {}, demoAddresses = {};
let sensorFeed = [], selectedSensorBatch = 1, lastTransaction = null, livePoller = null, activity = [], checkpointId = null;

function short(a = "") { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"; }
function vx(id) { return `VX${String(id).padStart(3, "0")}`; }
function date(seconds) { return seconds ? new Date(Number(seconds) * 1000).toLocaleString() : "—"; }
function temp(x10) { return `${(Number(x10) / 10).toFixed(1)} °C`; }
function escapeHtml(value = "") { const e = document.createElement("span"); e.textContent = String(value); return e.innerHTML; }
function verificationUrl(id) {
  const configured = localStorage.getItem("vaxpassFrontendUrl");
  const base = (configured || location.href).split("#")[0].replace(/\/$/, "");
  return `${base}/#/verify/${id}`;
}
function isLocalFrontend() { return ["localhost", "127.0.0.1"].includes(location.hostname); }
function isDemoChain() { return Number(config?.chainId) === 31337; }
function toast(message, error = false) { const el = document.createElement("div"); el.className = `toast${error ? " error" : ""}`; el.textContent = message; $("#toastArea").append(el); setTimeout(() => el.remove(), 4200); }
function friendly(error) {
  const m = error?.shortMessage || error?.reason || error?.message || "Transaction failed";
  return /user rejected|ACTION_REJECTED/i.test(m) ? "Transaction was cancelled in MetaMask." : m.replace(/^execution reverted: /, "");
}
function errorText(error) { return String(error?.shortMessage || error?.reason || error?.info?.error?.message || error?.message || "Transaction failed"); }
function contractEnforcement(error) {
  const text = errorText(error);
  if (/user rejected|ACTION_REJECTED/i.test(text)) return null;
  const rules = [[/spoiled/i, "This batch is spoiled and cannot be used."], [/recalled/i, "This batch was recalled by the regulator."], [/expired/i, "This batch has expired."], [/patient|duplicate|already administered|hash/i, "This patient identifier has already been administered for this batch."], [/role|unauthorized|not approved|accesscontrol/i, "This wallet does not have the approved role for this action."], [/status|transition|manufactured|custody|receipt/i, "The batch is not in the required status for this action."]];
  const match = rules.find(rule => rule[0].test(text)); return { title: "Blocked by Smart Contract", message: match ? match[1] : "The blockchain rejected this action because its safety rules were not satisfied.", technical: text };
}
function showShield(error) { const card = contractEnforcement(error); if (!card) return toast("Transaction cancelled in MetaMask.", false); $("#shieldArea").innerHTML = `<div class="shield-card"><div class="shield-icon">!</div><div><b>${card.title}</b><p>${escapeHtml(card.message)}</p><small>${escapeHtml(card.technical)}</small></div><button class="icon-button" data-action="dismiss-shield" aria-label="Dismiss contract error">×</button></div>`; setTimeout(() => { if ($("#shieldArea")) $("#shieldArea").innerHTML = ""; }, 9000); }
function updateTxDrawer() { const drawer = $("#txDrawer"); if (!drawer || !lastTransaction) return; drawer.innerHTML = `<div class="tx-drawer-head"><b>Last transaction</b><button class="icon-button" data-action="dismiss-tx" aria-label="Close transaction drawer">×</button></div><p><b>${escapeHtml(lastTransaction.functionName)}</b> · ${escapeHtml(lastTransaction.role)}</p><small>From ${short(lastTransaction.from)}</small><small>Block ${lastTransaction.block} · Gas ${lastTransaction.gas}</small><a href="#" class="tx-hash" title="Transaction hash">${short(lastTransaction.hash)}</a>`; drawer.classList.add("visible"); }
function statusClass(batch) {
  const s = Number(batch.status), now = Math.floor(Date.now() / 1000);
  if (s === 5) return "spoiled"; if (s === 6) return "recalled"; if (s === 7 || Number(batch.effectiveExpiry) <= now) return "expired";
  if (s === 4) return "depleted";
  if (Number(batch.excursionBudgetMins) && Number(batch.excursionMinsUsed) * 2 > Number(batch.excursionBudgetMins)) return "risk";
  if (Number(batch.effectiveExpiry) - now < 7 * 86400) return "warning";
  return "safe";
}
function statusLabel(batch) {
  const cls = statusClass(batch);
  return cls === "safe" ? "Safe" : cls === "warning" ? "Expiring Soon" : cls === "risk" ? "At Risk" : STATUS[Number(batch.status)].replaceAll(" ", " ");
}
function badge(batch) { return `<span class="badge ${statusClass(batch)}">${statusLabel(batch)}</span>`; }
function expiryAction(batch) { const active = ![4, 5, 6, 7].includes(Number(batch.status)); return active && Number(batch.effectiveExpiry) <= Math.floor(Date.now() / 1000) ? `<button class="button danger" data-action="mark-expired" data-id="${batch.id}">Mark expired</button>` : ""; }
function requireWallet() { if (!write || !account) { toast("Connect MetaMask to perform this action.", true); return false; } return true; }

async function init() {
  config = await fetch("contract.json").then(r => r.json());
  if (!config.address || !config.abi?.length) { app.innerHTML = `<div class="notice danger">No deployment found. Start a local node and run the deploy script first.</div>`; return; }
  const localRpcHost = ["localhost", "127.0.0.1"].includes(location.hostname) ? "127.0.0.1" : location.hostname;
  const rpcUrl = localStorage.getItem("vaxpassRpc") || (Number(config.chainId) === 11155111 ? "https://ethereum-sepolia-rpc.publicnode.com" : `http://${localRpcHost}:8545`);
  rpcProvider = new ethers.JsonRpcProvider(rpcUrl);
  read = new ethers.Contract(config.address, config.abi, rpcProvider);
  roleIds = {
    manufacturer: await read.MANUFACTURER_ROLE(), distributor: await read.DISTRIBUTOR_ROLE(),
    clinic: await read.CLINIC_ROLE(), logger: await read.LOGGER_ROLE(), regulator: await read.REGULATOR_ROLE()
  };
  $("#connectButton").addEventListener("click", connect);
  $("#menuButton").addEventListener("click", () => $("#nav").classList.toggle("open"));
  mode = isDemoChain() ? (localStorage.getItem("vaxpassMode") || "demo") : "live";
  if (mode === "demo") await activateDemoRole(localStorage.getItem("vaxpassDemoRole") || "regulator", false);
  else updateModeControls();
  window.addEventListener("hashchange", render);
  bindEvents(); startLiveUpdates(); render();
}

function updateModeControls() {
  const controls = $("#modeControls");
  if (!controls) return;
  if (!isDemoChain()) {
    controls.innerHTML = `<span class="mode-pill live">LIVE WALLET</span>`;
    return;
  }
  const roleOptions = DEMO_ROLES.map(key => `<option value="${key}" ${key === activeDemoRole ? "selected" : ""}>${DEMO_ROLE_LABELS[key]} · ${short(demoAddresses[key] || "")}</option>`).join("");
  controls.innerHTML = `<div class="mode-toggle" role="group" aria-label="Application mode"><button class="mode-option ${mode === "demo" ? "active" : ""}" data-action="demo-mode">Demo Mode</button><button class="mode-option ${mode === "live" ? "active" : ""}" data-action="live-mode">Live Wallet</button></div>${mode === "demo" ? `<span class="mode-pill demo">DEMO MODE · LOCAL CHAIN</span><label class="role-switcher"><span class="sr-only">Active demo role</span><select id="demoRoleSelect" aria-label="Active demo role">${roleOptions}</select></label>` : ""}`;
  $("#connectButton").textContent = mode === "demo" ? `${short(account)} · ${DEMO_ROLE_LABELS[activeDemoRole]}` : (account ? short(account) : "Connect wallet");
}

async function activateDemoRole(role, rerender = true) {
  if (!isDemoChain() || !DEMO_ROLES.includes(role)) return;
  mode = "demo"; activeDemoRole = role; localStorage.setItem("vaxpassMode", "demo"); localStorage.setItem("vaxpassDemoRole", role);
  if (!Object.keys(demoSigners).length) for (const key of DEMO_ROLES) { demoSigners[key] = await rpcProvider.getSigner(DEMO_ROLES.indexOf(key)); demoAddresses[key] = await demoSigners[key].getAddress(); }
  const signer = demoSigners[role]; account = await signer.getAddress(); write = read.connect(signer); activeRoles = [role]; updateModeControls();
  if (rerender) await render();
}

async function activateLiveMode() {
  mode = "live"; localStorage.setItem("vaxpassMode", "live"); write = null; account = null; activeRoles = []; updateModeControls();
  if (window.ethereum) await connect(); else toast("Live Wallet mode needs MetaMask.", true);
}

async function connect() {
  if (!window.ethereum) return toast("MetaMask was not detected. Install its browser extension first.", true);
  try {
    mode = "live"; localStorage.setItem("vaxpassMode", "live"); walletProvider = new ethers.BrowserProvider(window.ethereum);
    await walletProvider.send("eth_requestAccounts", []);
    const network = await walletProvider.getNetwork();
    if (Number(network.chainId) !== Number(config.chainId)) {
      toast(`Wrong network: switch MetaMask to chain ID ${config.chainId}.`, true); return;
    }
    const signer = await walletProvider.getSigner(); account = await signer.getAddress(); write = read.connect(signer);
    activeRoles = [];
    for (const [key, id] of Object.entries(roleIds)) if (await read.hasRole(id, account)) activeRoles.push(key);
    updateModeControls();
    toast("Wallet connected."); render();
  } catch (e) { toast(friendly(e), true); }
}
async function tx(promise, success = "Transaction confirmed.", functionName = "Transaction", rerender = true) { try { toast("Pending: waiting for confirmation…"); const t = await promise; const receipt = await t.wait(); lastTransaction = { hash: receipt.hash, block: receipt.blockNumber, gas: receipt.gasUsed?.toString() || "—", functionName, from: account, role: DEMO_ROLE_LABELS[activeDemoRole] || ROLE_LABELS[activeRoles[0]] || "Wallet" }; updateTxDrawer(); toast(`${success} ${short(receipt.hash)} · block ${receipt.blockNumber}`); if (rerender) await render(); return receipt; } catch (e) { showShield(e); return null; } }
async function batches() {
  const stats = await read.getStats();
  const count = Number(stats.totalBatches);
  return Promise.all(Array.from({ length: count }, (_, i) => read.getBatch(i + 1)));
}
function batchCard(b, actions = "") {
  const pct = Number(b.excursionBudgetMins) ? Math.min(100, Math.round(Number(b.excursionMinsUsed) * 100 / Number(b.excursionBudgetMins))) : 0;
  return `<article class="card"><div class="row-head"><div><p class="batch-title">${vx(b.id)} · ${escapeHtml(b.vaccineName)}</p><small>${escapeHtml(b.lotNumber)} · ${Number(b.dosesRemaining)}/${Number(b.totalDoses)} doses left</small></div>${badge(b)}</div>
    <div class="batch-meta"><div><small>Custodian</small><br>${short(b.custodian)}</div><div><small>Effective expiry</small><br>${date(b.effectiveExpiry)}</div></div>
    <div><small>Excursion budget: ${b.excursionMinsUsed}/${b.excursionBudgetMins} minutes</small><div class="progress"><i style="width:${pct}%"></i></div></div>
    <div class="actions"><a class="button light" href="#/batch/${b.id}">Passport</a>${expiryAction(b)}${actions}</div></article>`;
}
function page(title, subtitle, content, action = "") { return `<section class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</section>${content}`; }

async function render() {
  try {
    const parts = location.hash.replace(/^#\/?/, "").split("/"); const route = parts[0] || "";
    $("#nav").classList.remove("open");
    if (route === "register") await renderRegister(); else if (route === "regulator") await renderRegulator();
    else if (route === "manufacturer") await renderManufacturer(); else if (route === "distributor") await renderDistributor();
    else if (route === "clinic") await renderClinic(); else if (route === "sensor") await renderSensorConsole(Number(parts[1])); else if (route === "batch") await renderBatch(Number(parts[1]));
    else if (route === "verify") await renderVerify(Number(parts[1])); else if (route === "analytics") await renderAnalytics(); else await renderHome();
    await renderGuide();
  } catch (e) { app.innerHTML = `<div class="notice danger">Unable to read the chain: ${escapeHtml(friendly(e))}</div>`; }
}

async function guideChecks() {
  const list = await batches(), stats = await read.getStats(); const first = list.find(b => Number(b.id) === 1), second = list.find(b => Number(b.id) === 2); let firstLogs = [];
  if (first) firstLogs = await read.getTemperatureLogs(1);
  return [false, Boolean(first), firstLogs.length > 0, Boolean(first && Number(first.excursionMinsUsed) > 0), Boolean(first && Number(first.status) === 5), Boolean(second && [2, 3, 4].includes(Number(second.status))), Number(stats.dosesAdministered) > 0, Number(stats.recalled) > 0, true];
}
async function renderGuide() {
  const guide = $("#demoGuide"); if (!guide) return;
  if (mode !== "demo") { guide.innerHTML = ""; guide.classList.remove("open"); return; }
  const checks = await guideChecks(); const open = localStorage.getItem("vaxpassGuideOpen") !== "false"; const saved = JSON.parse(localStorage.getItem("vaxpassGuideProgress") || "[]"); const progress = checks.map((checked, index) => checked || Boolean(saved[index])); localStorage.setItem("vaxpassGuideProgress", JSON.stringify(progress));
  guide.classList.toggle("open", open); const next = progress.findIndex(done => !done);
  guide.innerHTML = `<div class="guide-head"><div><span class="eyebrow dark">Demo Mode</span><h2>Demo Guide</h2><p>${progress.filter(Boolean).length} of ${GUIDE_STEPS.length} checkpoints</p></div><button class="icon-button guide-close" data-action="toggle-guide" aria-label="Close Demo Guide">×</button></div><div class="guide-progress"><i style="width:${progress.filter(Boolean).length * 100 / GUIDE_STEPS.length}%"></i></div><div class="guide-steps">${GUIDE_STEPS.map((step, index) => `<div class="guide-step ${progress[index] ? "done" : ""}"><span class="guide-check">${progress[index] ? "✓" : index + 1}</span><div><b>${step[0]}</b><p>${step[1]}</p></div><button class="button light guide-go" data-action="guide-go" data-guide-index="${index}">Go</button></div>`).join("")}</div><div class="guide-actions"><button class="button teal" data-action="guide-next" ${next < 0 ? "disabled" : ""}>Next step</button><button class="button light" data-action="guide-reset">Reset guide</button></div>`;
  if (open) guide.querySelector(".guide-close")?.focus();
}
async function guideGo(index) { const step = GUIDE_STEPS[index]; if (!step) return; if (mode === "demo") await activateDemoRole(step[3], false); localStorage.setItem("vaxpassGuideOpen", "true"); location.hash = step[2]; }

async function renderHome() {
  const list = await batches(); const recent = list.slice(-3).reverse();
  app.innerHTML = `<section class="hero"><div class="eyebrow">Cold chain, clearly proven</div><h1>A passport for every vaccine batch.</h1><p>VaxPass records custody, temperature excursions, expiry penalties, recalls and privacy-preserving dose administration on Ethereum.</p><a class="button" href="#/verify">Verify a batch</a><button class="button light" data-action="connect">Connect wallet</button></section>
  <section class="grid three" style="margin:24px 0"><a class="card quick" href="#/manufacturer"><b>Register a batch</b><span>→</span></a><a class="card quick" href="#/distributor"><b>Track custody</b><span>→</span></a><a class="card quick" href="#/clinic"><b>Administer safely</b><span>→</span></a></section>
  ${page("Recent batches", "Live data from the configured Ethereum network.", `<div class="grid three">${recent.length ? recent.map(b => batchCard(b)).join("") : `<div class="card empty">No batches yet.</div>`}</div>`)}${activityTicker()}${await renderDemoTools()}`;
}
async function renderDemoTools() {
  if (mode !== "demo" || !isDemoChain()) return "";
  const block = await rpcProvider.getBlock("latest"), now = block?.timestamp ? new Date(Number(block.timestamp) * 1000).toLocaleString() : "—";
  return `<section class="grid two demo-tools"><div class="card"><span class="eyebrow dark">Local chain only</span><h2>Time Machine</h2><p class="muted">Chain time: <b>${now}</b></p><div class="actions"><button class="button light" data-action="time-action" data-secs="3600">+1 hour</button><button class="button light" data-action="time-action" data-secs="86400">+1 day</button><button class="button light" data-action="time-action" data-secs="604800">+7 days</button></div></div><div class="card"><span class="eyebrow dark">Demo state</span><h2>Checkpoint / reset</h2><p class="muted">Save a seeded state before the presentation flow, then restore it instantly.</p><div class="actions"><button class="button teal" data-action="save-checkpoint">Save checkpoint</button><button class="button danger" data-action="reset-demo" ${checkpointId ? "" : "disabled"}>Reset demo</button></div><small>${checkpointId ? "Checkpoint available." : "No checkpoint saved yet."}</small></div></section>`;
}
async function advanceDemoTime(seconds) { await rpcProvider.send("evm_increaseTime", [seconds]); await rpcProvider.send("evm_mine", []); toast("Demo chain time advanced."); await render(); }
async function saveDemoCheckpoint() { checkpointId = await rpcProvider.send("evm_snapshot", []); toast("Demo checkpoint saved."); await render(); }
async function resetDemo() { if (!checkpointId || !confirm("Reset the local demo to the saved checkpoint?")) return; await rpcProvider.send("evm_revert", [checkpointId]); checkpointId = await rpcProvider.send("evm_snapshot", []); sensorFeed = []; toast("Demo reset to checkpoint."); await render(); }
function activityTicker() { return `<section class="card activity-card"><div class="section-heading"><div><span class="eyebrow dark">Live blockchain activity</span><h2>Recent network events</h2></div><span class="role-chip">Auto-updating</span></div><div class="activity-list">${activity.length ? activity.slice(0, 8).map(item => `<div class="activity-item"><span class="activity-dot"></span><div><b>${escapeHtml(item.name)}</b><span>${item.id ? ` · ${vx(item.id)}` : ""}</span><p>${short(item.actor)} · ${item.time}</p></div></div>`).join("") : `<p class="empty">Waiting for blockchain activity.</p>`}</div></section>`; }
function addActivity(name, id, actor) { activity.unshift({ name, id, actor, time: new Date().toLocaleTimeString() }); activity = activity.slice(0, 20); }
function refreshHighlight() { app.classList.remove("live-flash"); void app.offsetWidth; app.classList.add("live-flash"); setTimeout(() => app.classList.remove("live-flash"), 900); }
function eventActor(name, args) { if (name === "BatchRegistered") return args[2]; if (name === "CustodyTransferred") return args[1]; if (name === "ReceiptConfirmed") return args[1]; if (name === "DoseAdministered") return args[2]; return account; }
function startLiveUpdates() {
  const events = ["BatchRegistered", "CustodyTransferred", "ReceiptConfirmed", "TemperatureLogged", "ExcursionDetected", "BatchSpoiled", "BatchRecalled", "DoseAdministered", "BatchExpired"];
  for (const name of events) read.on(name, (...args) => { const id = Number(args[0]); addActivity(name, id, eventActor(name, args)); refreshHighlight(); render(); });
  livePoller = setInterval(() => { render(); }, 3000);
}
function renderRegister() {
  app.innerHTML = page("Register an organisation role", "Your requested operational role is sent to the regulator. Organisation details stay only in this browser.", `<div class="grid two"><div class="card"><form id="roleForm"><label>Organisation name<input id="orgName" required placeholder="Example Clinic"></label><label>Requested role<select id="requestedRole"><option value="manufacturer">Manufacturer</option><option value="distributor">Distributor</option><option value="clinic">Clinic</option><option value="logger">Temperature logger</option></select></label><button class="button teal">Request role</button></form></div><aside class="card"><h3>How approval works</h3><p>Request a role with MetaMask. A regulator then approves your wallet on-chain. Your organisation name is stored in <code>localStorage</code>, not on-chain.</p></aside></div>`);
}
function renderRegulator() {
  app.innerHTML = page("Regulator panel", "Approve participating organisations and issue safety recalls.", `<div class="grid two"><div class="card"><h3>Approve or revoke entity</h3><form id="entityForm"><label>Wallet address<input id="entityAddress" required placeholder="0x…"></label><label>Role<select id="entityRole"><option value="manufacturer">Manufacturer</option><option value="distributor">Distributor</option><option value="clinic">Clinic</option><option value="logger">Temperature logger</option></select></label><div class="actions"><button class="button teal" name="op" value="approve">Approve requested role</button><button class="button danger" name="op" value="revoke">Revoke</button></div></form></div><div class="card"><h3>Recall a batch</h3><form id="recallForm"><label>Batch ID<input id="recallId" min="1" type="number" required></label><label>Reason<textarea id="recallReason" required placeholder="Safety notice or quality reason"></textarea></label><button class="button danger">Recall batch</button></form></div></div>`);
}
async function renderManufacturer() {
  const list = await batches(); const mine = account ? list.filter(b => b.manufacturer.toLowerCase() === account.toLowerCase()) : [];
  const actions = b => Number(b.status) === 0 && b.custodian.toLowerCase() === account?.toLowerCase() ? `<button class="button teal" data-action="dispatch" data-id="${b.id}">Dispatch</button>` : "";
  app.innerHTML = page("Manufacturer workspace", "Register a vaccine batch and begin its cold-chain passport.", `<div class="grid two"><div class="card"><h3>Register batch</h3><form id="batchForm"><label>Vaccine name<input id="vaccineName" required placeholder="ExampleVax"></label><label>Lot number<input id="lotNumber" required placeholder="LOT-2026-01"></label><div class="grid two"><label>Total doses<input id="doses" type="number" min="1" value="100" required></label><label>Printed expiry<input id="printedExpiry" type="datetime-local" required></label></div><div class="grid two"><label>Minimum °C<input id="minTemp" type="number" step="0.1" value="2" required></label><label>Maximum °C<input id="maxTemp" type="number" step="0.1" value="8" required></label></div><label>Excursion budget (minutes)<input id="budget" type="number" min="0" value="30" required></label><label>IPFS CID (optional document reference)<input id="cid" placeholder="Qm…"></label><button class="button teal">Register on-chain</button></form></div><div class="card"><h3>Dispatch note</h3><p>Use the dispatch button on a manufactured batch. You will be asked for the approved distributor wallet address.</p><p class="notice">${account ? `Connected as ${short(account)}.` : "Connect the manufacturer wallet to see your batches."}</p></div></div><h2 style="margin-top:28px">My batches</h2><div class="grid three">${mine.length ? mine.map(b => batchCard(b, actions(b))).join("") : `<div class="card empty">No manufacturer batches found.</div>`}</div>`);
}
async function renderDistributor() {
  const list = await batches(); const incoming = [], outgoing = [];
  if (account) for (const b of list) { const pending = await read.pendingCustodian(b.id); if (pending.toLowerCase() === account.toLowerCase()) incoming.push(b); if (b.custodian.toLowerCase() === account.toLowerCase()) outgoing.push(b); }
  const incomingActions = b => `<button class="button teal" data-action="accept" data-id="${b.id}">Accept custody</button>`;
  const outgoingActions = b => Number(b.status) === 1 && !b.clinic.match(/^0x0+$/) ? `<button class="button teal" data-action="confirm" data-id="${b.id}">Confirm handover</button>` : Number(b.status) === 1 ? `<button class="button teal" data-action="deliver" data-id="${b.id}">Deliver to clinic</button>` : "";
  app.innerHTML = page("Distributor workspace", "Accept shipments, identify the clinic, and confirm handover.", `<h2>Incoming custody requests</h2><div class="grid three">${incoming.length ? incoming.map(b => batchCard(b, incomingActions(b))).join("") : `<div class="card empty">No incoming requests.</div>`}</div><h2 style="margin-top:28px">My in-transit batches</h2><div class="grid three">${outgoing.length ? outgoing.map(b => batchCard(b, outgoingActions(b))).join("") : `<div class="card empty">No batches in your custody.</div>`}</div>`);
}
async function renderClinic() {
  const list = await batches(); const relevant = account ? list.filter(b => b.clinic.toLowerCase() === account.toLowerCase() || b.custodian.toLowerCase() === account.toLowerCase()) : [];
  const actions = b => { if (Number(b.status) === 1 && b.clinic.toLowerCase() === account?.toLowerCase()) return `<button class="button teal" data-action="confirm" data-id="${b.id}">Confirm receipt</button>`; if ([2,3].includes(Number(b.status)) && b.custodian.toLowerCase() === account?.toLowerCase()) return `<button class="button teal" data-action="administer" data-id="${b.id}">Administer dose</button>`; return ""; };
  app.innerHTML = page("Clinic workspace", "Confirm receipt, then administer using a locally hashed patient identifier.", `<div class="notice">Patient IDs are hashed in your browser with <code>keccak256</code>. The original ID is never sent to the blockchain.</div><div class="grid three" style="margin-top:18px">${relevant.length ? relevant.map(b => batchCard(b, actions(b))).join("") : `<div class="card empty">No clinic deliveries found.</div>`}</div>`);
}
async function renderSensorConsole(id = selectedSensorBatch) {
  if ((mode === "demo" && activeDemoRole !== "logger") || (mode === "live" && !activeRoles.includes("logger"))) return app.innerHTML = page("Sensor console", "Switch to an approved Temperature Logger account to record simulated readings.", `<div class="card empty"><a class="button teal" href="#/batch/${id || 1}">Open passport</a></div>`);
  const list = await batches(); if (!list.length) return app.innerHTML = page("Sensor console", "No batches are available for temperature logging.", `<div class="card empty">Register and seed a batch first.</div>`);
  selectedSensorBatch = id || selectedSensorBatch || Number(list[0].id); const batch = list.find(item => Number(item.id) === selectedSensorBatch) || list[0]; selectedSensorBatch = Number(batch.id);
  const used = Number(batch.excursionMinsUsed), budget = Number(batch.excursionBudgetMins), pct = budget ? Math.min(100, Math.round(used * 100 / budget)) : 0;
  app.innerHTML = page("Sensor console", "Simulate logger readings and watch the passport react on-chain.", `<div class="grid two"><section class="card sensor-console"><div class="row-head"><div><span class="eyebrow dark">Logger station</span><h2>Temperature feed</h2></div>${badge(batch)}</div><label>Batch<select id="sensorBatchSelect" aria-label="Sensor batch">${list.map(item => `<option value="${item.id}" ${Number(item.id) === selectedSensorBatch ? "selected" : ""}>${vx(item.id)} · ${escapeHtml(item.vaccineName)} · ${STATUS[Number(item.status)]}</option>`).join("")}</select></label><div class="sensor-actions"><button class="button teal" data-action="sensor-mode" data-mode="normal">Normal</button><button class="button" data-action="sensor-mode" data-mode="spike">Spike</button><button class="button danger" data-action="sensor-mode" data-mode="breach">Breach</button></div><div class="sensor-custom"><label>Custom temperature (°C)<input id="sensorTemp" type="number" step="0.1" value="5"></label><label>Duration (minutes)<input id="sensorDuration" type="number" min="1" value="5"></label><button class="button light" data-action="sensor-custom">Log custom reading</button></div><p class="muted sensor-note">Normal: 2–8 °C · Spike: 12–15 °C · Breach: 22–25 °C for long excursions.</p></section><section class="card sensor-status"><h3>${vx(batch.id)} live status</h3><div class="sensor-metrics"><div><span>Excursion used</span><b>${used} / ${budget} min</b></div><div><span>Effective expiry</span><b>${date(batch.effectiveExpiry)}</b></div><div><span>Readings</span><b>${sensorFeed.length}</b></div></div><div class="progress"><i style="width:${pct}%"></i></div>${Number(batch.status) === 5 ? `<div class="notice danger sensor-alert">⚠ SPOILED: excursion budget exceeded. Further custody and doses are blocked.</div>` : ""}<div class="sensor-feed">${sensorFeed.length ? sensorFeed.map(item => `<div class="sensor-reading ${item.state}"><span>${item.state === "pending" ? "◌" : item.state === "confirmed" ? "✓" : "!"}</span><b>${item.temp} °C</b><small>${item.duration} min · ${item.state}</small></div>`).join("") : `<p class="empty">No readings sent in this session.</p>`}</div></section></div>`);
}
async function sendSensorReadings(id, readings) {
  if (!requireWallet()) return;
  if (mode === "demo" && activeDemoRole !== "logger") return toast("Switch to the Temperature Logger role first.", true);
  sensorFeed = [];
  for (const [tempX10, durationMins] of readings) {
    sensorFeed.push({ temp: (tempX10 / 10).toFixed(1), duration: durationMins, state: "pending" }); await renderSensorConsole(id);
    const receipt = await tx(write.logTemperature(id, tempX10, durationMins), "Reading confirmed.", "logTemperature", false); sensorFeed[sensorFeed.length - 1].state = receipt ? "confirmed" : "failed";
    await renderSensorConsole(id);
  }
}
async function renderBatch(id) {
  if (!id) { location.hash = "#/verify"; return; } const b = await read.getBatch(id); const [history, logs] = await Promise.all([read.getBatchHistory(id), read.getTemperatureLogs(id)]);
  const used = Number(b.excursionMinsUsed), budget = Number(b.excursionBudgetMins), pct = budget ? Math.min(100, used * 100 / budget) : 0;
  const qrUrl = verificationUrl(id);
  const qrSetup = isLocalFrontend() ? `<div class="qr-setup"><p class="muted">This page is using <b>localhost</b>. A phone cannot reach that address.</p><button class="button light" data-action="set-qr-url">Set phone-accessible URL</button></div>` : "";
  const sensorLink = mode === "demo" || activeRoles.includes("logger") ? `<a class="button light" href="#/sensor/${id}">Open Sensor Console</a>` : "";
  app.innerHTML = page(`${vx(b.id)} passport`, "An on-chain, temperature-aware batch record.", `<div class="grid two"><section class="card"><div class="row-head"><h2>${escapeHtml(b.vaccineName)}</h2>${badge(b)}</div><div class="detail-list"><div><span>Lot number</span>${escapeHtml(b.lotNumber)}</div><div><span>Current status</span>${STATUS[Number(b.status)]}</div><div><span>Manufacturer</span><span class="address">${b.manufacturer}</span></div><div><span>Custodian</span><span class="address">${b.custodian}</span></div><div><span>Printed expiry</span>${date(b.printedExpiry)}</div><div><span>Effective expiry</span>${date(b.effectiveExpiry)}</div><div><span>Temperature range</span>${temp(b.minTempX10)} to ${temp(b.maxTempX10)}</div><div><span>Doses remaining</span>${b.dosesRemaining} / ${b.totalDoses}</div></div><p><b>Excursion budget:</b> ${used} / ${budget} minutes</p><div class="progress"><i style="width:${pct}%"></i></div><div class="actions">${expiryAction(b)}${sensorLink}</div></section><section class="card"><h3>Temperature record</h3><canvas id="tempChart" class="chart" width="520" height="220"></canvas><p class="muted">${logs.length} reading(s); each point is in °C.</p><div class="qr-heading"><h3>Public verification QR</h3><span class="role-chip">Wallet not required</span></div><div id="qr" class="qr" aria-label="QR code for public batch verification"></div><p class="qr-url">${escapeHtml(qrUrl)}</p>${qrSetup}<p class="muted qr-help">This QR opens public verification. It does not need MetaMask.</p></section></div><div class="grid two" style="margin-top:18px"><section class="card"><h3>Custody & status timeline</h3><div class="timeline">${history.map(h => `<div class="timeline-item"><b>${STATUS[Number(h.status)]}</b><p>${escapeHtml(h.note)}</p><small>${date(h.timestamp)} · ${short(h.actor)}</small></div>`).join("") || "No history"}</div></section><section class="card"><h3>Temperature logs</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>Temperature</th><th>Duration</th><th>Result</th></tr></thead><tbody>${logs.map(l => `<tr><td>${date(l.timestamp)}</td><td>${temp(l.tempX10)}</td><td>${l.durationMins} min</td><td>${l.excursion ? "Excursion" : "In range"}</td></tr>`).join("") || `<tr><td colspan="4">No readings logged.</td></tr>`}</tbody></table></div></section></div>`);
  const qr = $("#qr"); qr.replaceChildren(); new QRCode(qr, { text: qrUrl, width: 148, height: 148, colorDark: "#0c4a6e", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
}
function renderVerify(initialId) {
  app.innerHTML = page("Public batch verification", "Check a vaccine passport without connecting a wallet.", `<div class="card"><form id="verifyForm"><label>Batch ID (for example 1 or VX001)<input id="verifyId" value="${initialId || ""}" placeholder="VX001" required></label><button class="button teal">Verify batch</button></form></div><div id="verifyResult" style="margin-top:18px"></div>`);
  if (initialId) verify(initialId);
}
async function verify(raw) { const id = Number(String(raw).replace(/\D/g, "")); const target = $("#verifyResult"); if (!id) return target.innerHTML = `<div class="notice danger">Enter a valid batch ID.</div>`; const result = await read.verifyBatch(id); const code = Number(result.code), label = ["VALID", "WARNING", "INVALID"][code]; target.innerHTML = `<div class="verify-banner verify-${["valid","warning","invalid"][code]}"><h2>${label}</h2><p>${escapeHtml(result.message)}</p>${code !== 2 ? `<a class="button light" href="#/batch/${id}">Open full passport</a>` : ""}</div>`; }
async function renderAnalytics() {
  const stats = await read.getStats(), total = Number(stats.totalBatches), spoiled = Number(stats.spoiled), recalled = Number(stats.recalled), expired = Number(stats.expired);
  const wastage = total ? (((spoiled + recalled + expired) / total) * 100).toFixed(1) : "0.0";
  app.innerHTML = page("Network analytics", "A clear snapshot of batch volume, patient impact, and safety outcomes.", `<div class="grid four analytics-stats"><div class="card stat"><span class="stat-kicker">Tracked inventory</span><b>${total}</b><span>Batch${total === 1 ? "" : "es"}</span></div><div class="card stat"><span class="stat-kicker">Patient impact</span><b>${stats.dosesAdministered}</b><span>Doses administered</span></div><div class="card stat"><span class="stat-kicker">Safety action</span><b>${spoiled}</b><span>Spoiled batches</span></div><div class="card stat"><span class="stat-kicker">Loss signal</span><b>${wastage}%</b><span>Wastage rate</span></div></div><section class="card analytics-chart-card"><div class="section-heading"><div><span class="eyebrow dark">At a glance</span><h2>Batch outcomes</h2><p>Compare the network totals across the same scale.</p></div><span class="analytics-total">${total} total batch${total === 1 ? "" : "es"}</span></div><div class="chart-wrap"><canvas id="barChart" class="chart" width="900" height="300"></canvas></div><div class="chart-legend"><span><i class="legend-swatch batches"></i>Tracked</span><span><i class="legend-swatch doses"></i>Doses</span><span><i class="legend-swatch spoiled"></i>Spoiled</span><span><i class="legend-swatch recalled"></i>Recalled</span><span><i class="legend-swatch expired"></i>Expired</span></div><div class="analytics-foot"><span>Recalled: <b>${recalled}</b></span><span>Expired: <b>${expired}</b></span><span>Temperature excursion: <b>${stats.totalExcursionMinutes} min</b></span></div></section>`);
  drawBars([total, Number(stats.dosesAdministered), spoiled, recalled, expired], ["Batches","Doses","Spoiled","Recalled","Expired"]);
}
function drawTemperature(logs) { const c = $("#tempChart"), x = c.getContext("2d"), w = c.width, h = c.height; x.clearRect(0,0,w,h); x.strokeStyle="#dce8ed"; for(let i=0;i<5;i++){x.beginPath();x.moveTo(34,20+i*40);x.lineTo(w-12,20+i*40);x.stroke()} if(!logs.length){x.fillStyle="#607789";x.fillText("No temperature readings yet",w/2-65,h/2);return} const vals=logs.map(l=>Number(l.tempX10)/10), min=Math.min(...vals,0), max=Math.max(...vals,10), span=max-min||1; x.strokeStyle="#0f9b9d";x.lineWidth=3;x.beginPath();vals.forEach((v,i)=>{const px=38+i*(w-56)/Math.max(1,vals.length-1),py=h-28-(v-min)/(span)*170;i?x.lineTo(px,py):x.moveTo(px,py)});x.stroke();x.fillStyle="#0c4a6e";x.fillText(`${max.toFixed(1)} °C`,4,23);x.fillText(`${min.toFixed(1)} °C`,4,h-22); }
function drawBars(values, labels) { const c=$("#barChart"),x=c.getContext("2d"),w=c.width,h=c.height,left=62,right=26,top=24,bottom=58,max=Math.max(...values,1),plotH=h-top-bottom,plotW=w-left-right,bw=plotW/values.length; x.clearRect(0,0,w,h); x.font="12px sans-serif"; x.strokeStyle="#dce8ed"; x.fillStyle="#607789"; for(let i=0;i<=4;i++){const y=top+plotH-(plotH*i/4); x.beginPath();x.moveTo(left,y);x.lineTo(w-right,y);x.stroke();x.fillText(String(Math.round(max*i/4)),8,y+4)} values.forEach((v,i)=>{const bh=v/max*plotH,px=left+i*bw+bw*.22; x.fillStyle=["#0c4a6e","#0f9b9d","#c23b52","#bd7411","#607789"][i];x.fillRect(px,top+plotH-bh,bw*.56,bh);x.fillStyle="#183146";x.font="700 13px sans-serif";x.fillText(String(v),px+(bw*.56/2)-4,top+plotH-bh-8);x.font="12px sans-serif";x.fillText(labels[i],px,h-24)}); }

function bindEvents() { document.addEventListener("click", async e => { const action = e.target.dataset.action; if (!action) return; if (action === "connect") return connect(); if (action === "demo-mode") return activateDemoRole(activeDemoRole); if (action === "live-mode") return activateLiveMode(); if (action === "dismiss-shield") { $("#shieldArea").innerHTML = ""; return; } if (action === "dismiss-tx") { $("#txDrawer").classList.remove("visible"); return; } if (action === "time-action") { if (mode !== "demo" || !isDemoChain()) return; return advanceDemoTime(Number(e.target.dataset.secs)); } if (action === "save-checkpoint") { if (mode !== "demo" || !isDemoChain()) return; return saveDemoCheckpoint(); } if (action === "reset-demo") { if (mode !== "demo" || !isDemoChain()) return; return resetDemo(); } if (action === "mark-expired") return tx(write.markExpired(Number(e.target.dataset.id)), "Batch marked expired.", "markExpired"); if (action === "toggle-guide") { const open = !$("#demoGuide").classList.contains("open"); localStorage.setItem("vaxpassGuideOpen", String(open)); return renderGuide(); } if (action === "guide-go") return guideGo(Number(e.target.dataset.guideIndex)); if (action === "guide-next") { const checks = await guideChecks(), index = checks.findIndex((checked, position) => !checked && !JSON.parse(localStorage.getItem("vaxpassGuideProgress") || "[]")[position]); return guideGo(index < 0 ? 0 : index); } if (action === "guide-reset") { if (!confirm("Reset Demo Guide progress?")) return; localStorage.removeItem("vaxpassGuideProgress"); return renderGuide(); } if (action === "sensor-mode") return sendSensorReadings(selectedSensorBatch, SENSOR_READINGS[e.target.dataset.mode]); if (action === "sensor-custom") { const temperature = Number($("#sensorTemp")?.value), duration = Number($("#sensorDuration")?.value); if (!Number.isFinite(temperature) || !Number.isFinite(duration) || duration < 1) return toast("Enter a valid temperature and duration.", true); return sendSensorReadings(selectedSensorBatch, [[Math.round(temperature * 10), duration]]); } if (action === "set-qr-url") { const value = prompt("Enter the frontend URL that your phone can reach, for example http://192.168.0.106:8080", localStorage.getItem("vaxpassFrontendUrl") || "http://192.168.0.106:8080"); if (!value) return; try { const url = new URL(value); if (!/^https?:$/.test(url.protocol)) throw new Error(); localStorage.setItem("vaxpassFrontendUrl", url.origin); toast("QR destination saved. Reloading passport…"); return render(); } catch { return toast("Enter a valid http:// or https:// frontend URL.", true); } } if (!requireWallet()) return; const id = Number(e.target.dataset.id); if (action === "accept") return tx(write.acceptCustody(id), "Custody accepted.", "acceptCustody"); if (action === "confirm") return tx(write.confirmReceipt(id), "Receipt confirmation recorded.", "confirmReceipt"); if (action === "dispatch") { const a=prompt("Approved distributor wallet address:"); if(a && ethers.isAddress(a)) return tx(write.dispatchBatch(id,a),"Batch dispatched.","dispatchBatch"); return a ? toast("Enter a valid wallet address.",true) : null; } if (action === "deliver") { const a=prompt("Approved clinic wallet address:"); if(a && ethers.isAddress(a)) return tx(write.deliverToClinic(id,a),"Clinic delivery set; await dual confirmation.","deliverToClinic"); return a ? toast("Enter a valid wallet address.",true) : null; } if (action === "administer") { const p=prompt("Patient ID (hashed locally; never stored on-chain):"); if(!p) return; const hash=ethers.keccak256(ethers.toUtf8Bytes(p)); return tx(write.administerDose(id,hash),"Dose administered; only the hash was recorded.","administerDose"); } });
  document.addEventListener("change", e => { if (e.target.id === "demoRoleSelect") activateDemoRole(e.target.value); if (e.target.id === "sensorBatchSelect") { selectedSensorBatch = Number(e.target.value); renderSensorConsole(selectedSensorBatch); } });
  document.addEventListener("change", e => { if (e.target.id === "demoRoleSelect") activateDemoRole(e.target.value); });
  document.addEventListener("submit", async e => { e.preventDefault(); const f=e.target; if(f.id === "verifyForm") return verify($("#verifyId").value); if(!requireWallet()) return; if(f.id === "roleForm"){const key=$("#requestedRole").value;localStorage.setItem("vaxpassOrg",$("#orgName").value);return tx(write.requestRole(roleIds[key]),"Role request submitted for regulator approval.","requestRole");} if(f.id === "entityForm"){const a=$("#entityAddress").value.trim(),r=roleIds[$("#entityRole").value],op=e.submitter?.value;if(!ethers.isAddress(a))return toast("Enter a valid wallet address.",true);return tx(op==="revoke"?write.revokeEntity(a,r):write.approveEntity(a,r),op==="revoke"?"Role revoked.":"Entity approved.",op==="revoke"?"revokeEntity":"approveEntity");} if(f.id === "recallForm") return tx(write.recallBatch($("#recallId").value,$("#recallReason").value),"Batch recalled.","recallBatch"); if(f.id === "batchForm"){const expiry=Math.floor(new Date($("#printedExpiry").value).getTime()/1000); if(!expiry)return toast("Choose a valid expiry date.",true); return tx(write.registerBatch($("#vaccineName").value,$("#lotNumber").value,$("#doses").value,expiry,Math.round(Number($("#minTemp").value)*10),Math.round(Number($("#maxTemp").value)*10),$("#budget").value,$("#cid").value),"Batch registered.","registerBatch");} }); }
init().catch(e => { app.innerHTML = `<div class="notice danger">Startup error: ${escapeHtml(friendly(e))}</div>`; });
