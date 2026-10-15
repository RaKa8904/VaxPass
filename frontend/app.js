/* VaxPass front end: no framework, no patient data stored in the browser or chain. */
const $ = (s) => document.querySelector(s);
const app = $("#app");
const STATUS = ["MANUFACTURED", "IN TRANSIT", "DELIVERED", "IN USE", "DEPLETED", "SPOILED", "RECALLED", "EXPIRED"];
const ROLE_LABELS = { manufacturer: "Manufacturer", distributor: "Distributor", clinic: "Clinic", logger: "Temperature Logger" };
let config, read, walletProvider, write, account, activeRoles = [], roleIds = {};

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
function toast(message, error = false) { const el = document.createElement("div"); el.className = `toast${error ? " error" : ""}`; el.textContent = message; $("#toastArea").append(el); setTimeout(() => el.remove(), 4200); }
function friendly(error) {
  const m = error?.shortMessage || error?.reason || error?.message || "Transaction failed";
  return /user rejected|ACTION_REJECTED/i.test(m) ? "Transaction was cancelled in MetaMask." : m.replace(/^execution reverted: /, "");
}
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
function requireWallet() { if (!write || !account) { toast("Connect MetaMask to perform this action.", true); return false; } return true; }

async function init() {
  config = await fetch("contract.json").then(r => r.json());
  if (!config.address || !config.abi?.length) { app.innerHTML = `<div class="notice danger">No deployment found. Start a local node and run the deploy script first.</div>`; return; }
  const rpcUrl = localStorage.getItem("vaxpassRpc") || (Number(config.chainId) === 11155111 ? "https://ethereum-sepolia-rpc.publicnode.com" : "http://127.0.0.1:8545");
  read = new ethers.Contract(config.address, config.abi, new ethers.JsonRpcProvider(rpcUrl));
  roleIds = {
    manufacturer: await read.MANUFACTURER_ROLE(), distributor: await read.DISTRIBUTOR_ROLE(),
    clinic: await read.CLINIC_ROLE(), logger: await read.LOGGER_ROLE(), regulator: await read.REGULATOR_ROLE()
  };
  $("#connectButton").addEventListener("click", connect);
  $("#menuButton").addEventListener("click", () => $("#nav").classList.toggle("open"));
  window.addEventListener("hashchange", render);
  bindEvents(); render();
}

async function connect() {
  if (!window.ethereum) return toast("MetaMask was not detected. Install its browser extension first.", true);
  try {
    walletProvider = new ethers.BrowserProvider(window.ethereum);
    await walletProvider.send("eth_requestAccounts", []);
    const network = await walletProvider.getNetwork();
    if (Number(network.chainId) !== Number(config.chainId)) {
      toast(`Wrong network: switch MetaMask to chain ID ${config.chainId}.`, true); return;
    }
    const signer = await walletProvider.getSigner(); account = await signer.getAddress(); write = read.connect(signer);
    activeRoles = [];
    for (const [key, id] of Object.entries(roleIds)) if (await read.hasRole(id, account)) activeRoles.push(key);
    $("#connectButton").textContent = `${short(account)}${activeRoles.length ? ` · ${ROLE_LABELS[activeRoles[0]] || "Regulator"}` : ""}`;
    toast("Wallet connected."); render();
  } catch (e) { toast(friendly(e), true); }
}
async function tx(promise, success) { try { const t = await promise; toast("Transaction submitted; waiting for confirmation…"); await t.wait(); toast(success); await render(); } catch (e) { toast(friendly(e), true); } }
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
    <div class="actions"><a class="button light" href="#/batch/${b.id}">Passport</a>${actions}</div></article>`;
}
function page(title, subtitle, content, action = "") { return `<section class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</section>${content}`; }

async function render() {
  try {
    const parts = location.hash.replace(/^#\/?/, "").split("/"); const route = parts[0] || "";
    $("#nav").classList.remove("open");
    if (route === "register") return renderRegister(); if (route === "regulator") return renderRegulator();
    if (route === "manufacturer") return renderManufacturer(); if (route === "distributor") return renderDistributor();
    if (route === "clinic") return renderClinic(); if (route === "batch") return renderBatch(Number(parts[1]));
    if (route === "verify") return renderVerify(Number(parts[1])); if (route === "analytics") return renderAnalytics();
    return renderHome();
  } catch (e) { app.innerHTML = `<div class="notice danger">Unable to read the chain: ${escapeHtml(friendly(e))}</div>`; }
}

async function renderHome() {
  const list = await batches(); const recent = list.slice(-3).reverse();
  app.innerHTML = `<section class="hero"><div class="eyebrow">Cold chain, clearly proven</div><h1>A passport for every vaccine batch.</h1><p>VaxPass records custody, temperature excursions, expiry penalties, recalls and privacy-preserving dose administration on Ethereum.</p><a class="button" href="#/verify">Verify a batch</a><button class="button light" data-action="connect">Connect wallet</button></section>
  <section class="grid three" style="margin:24px 0"><a class="card quick" href="#/manufacturer"><b>Register a batch</b><span>→</span></a><a class="card quick" href="#/distributor"><b>Track custody</b><span>→</span></a><a class="card quick" href="#/clinic"><b>Administer safely</b><span>→</span></a></section>
  ${page("Recent batches", "Live data from the configured Ethereum network.", `<div class="grid three">${recent.length ? recent.map(b => batchCard(b)).join("") : `<div class="card empty">No batches yet.</div>`}</div>`)}`;
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
async function renderBatch(id) {
  if (!id) { location.hash = "#/verify"; return; } const b = await read.getBatch(id); const [history, logs] = await Promise.all([read.getBatchHistory(id), read.getTemperatureLogs(id)]);
  const used = Number(b.excursionMinsUsed), budget = Number(b.excursionBudgetMins), pct = budget ? Math.min(100, used * 100 / budget) : 0;
  const qrUrl = verificationUrl(id);
  const qrSetup = isLocalFrontend() ? `<div class="qr-setup"><p class="muted">This page is using <b>localhost</b>. A phone cannot reach that address.</p><button class="button light" data-action="set-qr-url">Set phone-accessible URL</button></div>` : "";
  app.innerHTML = page(`${vx(b.id)} passport`, "An on-chain, temperature-aware batch record.", `<div class="grid two"><section class="card"><div class="row-head"><h2>${escapeHtml(b.vaccineName)}</h2>${badge(b)}</div><div class="detail-list"><div><span>Lot number</span>${escapeHtml(b.lotNumber)}</div><div><span>Current status</span>${STATUS[Number(b.status)]}</div><div><span>Manufacturer</span><span class="address">${b.manufacturer}</span></div><div><span>Custodian</span><span class="address">${b.custodian}</span></div><div><span>Printed expiry</span>${date(b.printedExpiry)}</div><div><span>Effective expiry</span>${date(b.effectiveExpiry)}</div><div><span>Temperature range</span>${temp(b.minTempX10)} to ${temp(b.maxTempX10)}</div><div><span>Doses remaining</span>${b.dosesRemaining} / ${b.totalDoses}</div></div><p><b>Excursion budget:</b> ${used} / ${budget} minutes</p><div class="progress"><i style="width:${pct}%"></i></div></section><section class="card"><h3>Temperature record</h3><canvas id="tempChart" class="chart" width="520" height="220"></canvas><p class="muted">${logs.length} reading(s); each point is in °C.</p><div class="qr-heading"><h3>Public verification QR</h3><span class="role-chip">Wallet not required</span></div><div id="qr" class="qr" aria-label="QR code for public batch verification"></div><p class="qr-url">${escapeHtml(qrUrl)}</p>${qrSetup}<p class="muted qr-help">This QR opens public verification. It does not need MetaMask.</p></section></div><div class="grid two" style="margin-top:18px"><section class="card"><h3>Custody & status timeline</h3><div class="timeline">${history.map(h => `<div class="timeline-item"><b>${STATUS[Number(h.status)]}</b><p>${escapeHtml(h.note)}</p><small>${date(h.timestamp)} · ${short(h.actor)}</small></div>`).join("") || "No history"}</div></section><section class="card"><h3>Temperature logs</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>Temperature</th><th>Duration</th><th>Result</th></tr></thead><tbody>${logs.map(l => `<tr><td>${date(l.timestamp)}</td><td>${temp(l.tempX10)}</td><td>${l.durationMins} min</td><td>${l.excursion ? "Excursion" : "In range"}</td></tr>`).join("") || `<tr><td colspan="4">No readings logged.</td></tr>`}</tbody></table></div></section></div>`);
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

function bindEvents() { document.addEventListener("click", async e => { const action = e.target.dataset.action; if (!action) return; if (action === "connect") return connect(); if (action === "set-qr-url") { const value = prompt("Enter the frontend URL that your phone can reach, for example http://192.168.0.106:8080", localStorage.getItem("vaxpassFrontendUrl") || "http://192.168.0.106:8080"); if (!value) return; try { const url = new URL(value); if (!/^https?:$/.test(url.protocol)) throw new Error(); localStorage.setItem("vaxpassFrontendUrl", url.origin); toast("QR destination saved. Reloading passport…"); return render(); } catch { return toast("Enter a valid http:// or https:// frontend URL.", true); } } if (!requireWallet()) return; const id = Number(e.target.dataset.id); if (action === "accept") return tx(write.acceptCustody(id), "Custody accepted."); if (action === "confirm") return tx(write.confirmReceipt(id), "Receipt confirmation recorded."); if (action === "dispatch") { const a=prompt("Approved distributor wallet address:"); if(a && ethers.isAddress(a)) return tx(write.dispatchBatch(id,a),"Batch dispatched."); return a ? toast("Enter a valid wallet address.",true) : null; } if (action === "deliver") { const a=prompt("Approved clinic wallet address:"); if(a && ethers.isAddress(a)) return tx(write.deliverToClinic(id,a),"Clinic delivery set; await dual confirmation."); return a ? toast("Enter a valid wallet address.",true) : null; } if (action === "administer") { const p=prompt("Patient ID (hashed locally; never stored on-chain):"); if(!p) return; const hash=ethers.keccak256(ethers.toUtf8Bytes(p)); return tx(write.administerDose(id,hash),"Dose administered; only the hash was recorded."); } });
  document.addEventListener("submit", async e => { e.preventDefault(); const f=e.target; if(f.id === "verifyForm") return verify($("#verifyId").value); if(!requireWallet()) return; if(f.id === "roleForm"){const key=$("#requestedRole").value;localStorage.setItem("vaxpassOrg",$("#orgName").value);return tx(write.requestRole(roleIds[key]),"Role request submitted for regulator approval.");} if(f.id === "entityForm"){const a=$("#entityAddress").value.trim(),r=roleIds[$("#entityRole").value],op=e.submitter?.value;if(!ethers.isAddress(a))return toast("Enter a valid wallet address.",true);return tx(op==="revoke"?write.revokeEntity(a,r):write.approveEntity(a,r),op==="revoke"?"Role revoked.":"Entity approved.");} if(f.id === "recallForm") return tx(write.recallBatch($("#recallId").value,$("#recallReason").value),"Batch recalled."); if(f.id === "batchForm"){const expiry=Math.floor(new Date($("#printedExpiry").value).getTime()/1000); if(!expiry)return toast("Choose a valid expiry date.",true); return tx(write.registerBatch($("#vaccineName").value,$("#lotNumber").value,$("#doses").value,expiry,Math.round(Number($("#minTemp").value)*10),Math.round(Number($("#maxTemp").value)*10),$("#budget").value,$("#cid").value),"Batch registered.");} }); }
init().catch(e => { app.innerHTML = `<div class="notice danger">Startup error: ${escapeHtml(friendly(e))}</div>`; });
