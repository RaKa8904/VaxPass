# VaxPass: Blockchain-Based Cold-Chain Vaccine Passport & Expiry Management

[![Solidity](https://img.shields.io/badge/Solidity-^0.8.20-363636?logo=solidity)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/Built%20with-Hardhat-yellow)](https://hardhat.org/)
[![OpenZeppelin](https://img.shields.io/badge/OpenZeppelin-AccessControl%20v5-4E5EE4?logo=openzeppelin)](https://openzeppelin.com/)
[![Ethers](https://img.shields.io/badge/Ethers.js-v6-2535a0)](https://docs.ethers.org/v6/)
[![Tests](https://img.shields.io/badge/Tests-13%2F13%20Passing-brightgreen)](test/VaxPass.test.js)

**VaxPass** is a decentralized cold-chain vaccine management and passport system built on Ethereum. It tracks vaccine batches end-to-end from manufacturing through distribution to clinic administration, logging IoT temperature telemetry, dynamically adjusting effective expiry dates based on thermal excursions, autonomously spoiling degraded batches, and enforcing zero-PII cryptographic proof for administered doses.

> **Note on Telemetry:** Sensor data in this demonstration is simulated via an on-chain logger account and CLI script. In a commercial production deployment, readings would be authenticated through tamper-resistant hardware enclaves, cryptographically signed hardware roots-of-trust, or a decentralized oracle network (e.g., Chainlink).

---

## Table of Contents

1. [Key Features & Innovations](#key-features--innovations)
2. [System Architecture & Lifecycle](#system-architecture--lifecycle)
3. [Technology Stack](#technology-stack)
4. [Prerequisites](#prerequisites)
5. [Quickstart (Local Run)](#quickstart-local-run)
   - [Option A: One-Click Windows Launch](#option-a-one-click-windows-launch-recommended)
   - [Option B: Manual Multi-Terminal Launch](#option-b-manual-multi-terminal-launch)
6. [Mobile Verification over Wi-Fi](#mobile-verification-over-wi-fi)
7. [Role-Based Access Control (RBAC) & Demo Wallets](#role-based-access-control-rbac--demo-wallets)
8. [Sensor Telemetry Simulator](#sensor-telemetry-simulator)
9. [Preflight Web3 Transaction Architecture](#preflight-web3-transaction-architecture)
10. [Test Suite & Verification](#test-suite--verification)
11. [Presentation Runbook (5-Minute Viva / Demo)](#presentation-runbook-5-minute-viva--demo)
12. [Screenshot Checklist for Project Report](#screenshot-checklist-for-project-report)
13. [Sepolia Testnet Deployment](#sepolia-testnet-deployment)
14. [Repository Structure](#repository-structure)
15. [Smart Contract Logic Reference](#smart-contract-logic-reference)

---

## Key Features & Innovations

- **Granular On-Chain RBAC:** Strict access control powered by OpenZeppelin's `AccessControl` defining 5 roles: `REGULATOR_ROLE`, `MANUFACTURER_ROLE`, `DISTRIBUTOR_ROLE`, `CLINIC_ROLE`, and `LOGGER_ROLE`. Entities request authorization on-chain and require regulator approval before transacting.
- **Dual-Confirmation Custody Handover:** Eliminates single-party false claims during transit. When a distributor delivers a batch to a clinic, both the distributor and the clinic must independently execute `confirmReceipt()` on-chain before the batch status unlocks for patient dosing.
- **Dynamic Expiry & Autonomous Spoilage:** Every logged temperature excursion (reading outside the allowed `[minTempX10, maxTempX10]` window) reduces the batch's `effectiveExpiry` timestamp by `10 minutes per excursion minute` (`EXPIRY_PENALTY_FACTOR = 10`), while consuming the allocated `excursionBudgetMins`. Exceeding the excursion budget autonomously transitions the batch to `SPOILED`, blocking all downstream custody transfers and administrations.
- **Zero-PII Patient Privacy Protection:** Patient names, IDs, and medical records **never touch the blockchain**. The clinic web client calculates a local one-way cryptographic hash (`keccak256(patientId)`), recording only the 32-byte digest on-chain. This immutably prevents double-dosing per batch without exposing patient identity.
- **Public 3-Tier Verification & QR Passports:** Anyone (inspectors, patients, or border officials) can scan a batch QR code or query batch IDs via the public portal without installing MetaMask or owning ETH. Verification returns an instant status code:
  - `0 = VALID` (Batch active, within budget, unexpired)
  - `1 = WARNING` (Minor thermal excursions logged or approaching expiry within 7 days)
  - `2 = INVALID` (Spoiled, recalled, or expired)
- **Hardened Preflight Web3 Pipeline:** The frontend validates role permissions, custodian ownership, and batch state via `staticCall` preflight simulation before prompting MetaMask signatures, calculates custom gas buffers, and verifies mined receipts against the RPC node to eliminate revert confusion.

---

## System Architecture & Lifecycle

### Batch State Machine

```
              ┌───────────────────────────┐
              │       MANUFACTURED        │ (Registered by Manufacturer)
              └─────────────┬─────────────┘
                            │ dispatchBatch()
                            ▼
              ┌───────────────────────────┐
              │        IN_TRANSIT         │ (Accepted by Distributor)
              └─────────────┬─────────────┘
                            │ deliverToClinic() + Dual confirmReceipt()
                            ▼
              ┌───────────────────────────┐
              │         DELIVERED         │ (Clinic custodian confirmed)
              └─────────────┬─────────────┘
                            │ administerDose() (First dose)
                            ▼
              ┌───────────────────────────┐
              │          IN_USE           │ (Doses decrementing)
              └─────────────┬─────────────┘
                            │ Last dose administered
                            ▼
              ┌───────────────────────────┐
              │         DEPLETED          │ (All doses administered)
              └───────────────────────────┘

  [Terminal Exception States Triggerable from Any Active Status]
  ├── Excursion budget exhausted ──────► SPOILED
  ├── Regulatory intervention ────────► RECALLED
  └── Current time > effectiveExpiry ──► EXPIRED (via public markExpired())
```

### Role Permission Matrix

| Role | On-Chain Actions |
| :--- | :--- |
| **Regulator** | Approve role requests, revoke roles, recall any batch with reason string, transfer regulator role. |
| **Manufacturer** | Register batches with temperature limits, shelf-life, and IPFS CIDs; dispatch custody to approved distributors. |
| **Distributor** | Accept incoming custody from manufacturers; deliver batches to approved clinics; sign delivery receipts. |
| **Clinic** | Confirm receipt of incoming batches; administer doses using salted/hashed patient identifiers. |
| **Temperature Logger** | Submit temperature telemetry logs (`tempX10`, `durationMins`) during transit and storage. |
| **Public / Unauthenticated**| Verify batch status, inspect Cold-Chain Passports, read global analytics, scan QR codes, call `markExpired()`. |

---

## Technology Stack

- **Smart Contract:** Solidity `^0.8.20`, OpenZeppelin Contracts `v5.0.2` (`AccessControl.sol`), Hardhat `2.17.4`.
- **Client Frontend:** Vanilla JavaScript (ES2022+), Semantic HTML5, Vanilla CSS3 design system with dark mode, Apple translucency effects, and fluid micro-interactions.
- **Web3 Integration:** Ethers.js `v6.13.0` (CDN), QRCode.js (CDN), MetaMask browser extension.
- **Development Tooling:** Node.js, Hardhat Network Helpers, Python 3 HTTP server, Python `python-docx` for automated documentation generation.

---

## Prerequisites

- **Node.js:** Node.js 20 or 22 LTS is recommended. (Validated on Windows ARM64 / Node 24; Hardhat prints an engine advisory which can be safely acknowledged).
- **MetaMask:** Browser extension installed on Chrome, Edge, Brave, or Firefox.
- **Python 3:** Required for serving static frontend files locally.

---

## Quickstart (Local Run)

### Option A: One-Click Windows Launch (Recommended)

Double-click **`start.bat`** (or `start-vaxpass.bat`, or run `npm start`) in the project root directory.

The batch script will:
1. Launch the local Hardhat blockchain node in a separate window.
2. Poll port `8545` until the JSON-RPC interface is ready.
3. Deploy `VaxPass.sol` and save the address/ABI to `frontend/contract.json`.
4. Run `scripts/seed.js` to approve demo roles and register batches `VX001` through `VX005`.
5. Start the frontend web server on `http://localhost:8080` bound to all network interfaces (`0.0.0.0`).
6. Print your computer's local Wi-Fi IP address for smartphone testing.

*Keep the spawned command windows open while testing the application.*

---

### Option B: Manual Multi-Terminal Launch

If you prefer running commands manually or are on macOS/Linux:

#### 1. Install Dependencies & Compile
```bash
npm install
npx hardhat compile
npx hardhat test
```
*(On Windows ARM64 with Node 24, use `npm install --ignore-scripts` if native leveldown builds fail).*

#### 2. Terminal 1: Start Blockchain Node
```bash
npm run node
```
This starts Hardhat JSON-RPC on `http://127.0.0.1:8545` (Chain ID `31337`) and outputs 20 funded development accounts.

#### 3. Terminal 2: Deploy & Seed Demo Data
```bash
npm run deploy:local
npm run seed:local
```
This updates `frontend/contract.json` with the local deployment address and seeds sample batches `VX001` to `VX005`.

#### 4. Terminal 3: Serve Frontend
```bash
python -m http.server 8080 --directory frontend
```
Open **`http://localhost:8080`** in your browser.

---

## Mobile Verification over Wi-Fi

VaxPass batch QR codes can be scanned directly from a smartphone on the same local network:

1. Serve the frontend bound to all network interfaces:
   ```bash
   python -m http.server 8080 --bind 0.0.0.0 --directory frontend
   ```
2. Find your computer's local IPv4 address (e.g. `192.168.0.106` via `ipconfig` on Windows or `ifconfig` / `ip a` on Linux/macOS).
3. Open `http://<YOUR_IP>:8080` in your computer's browser.
4. Navigate to any batch passport (e.g., `VX001`).
5. In the QR Code section, click **Set phone-accessible URL** and enter `http://<YOUR_IP>:8080`.
6. Scan the QR code with your smartphone camera. The phone will immediately load the public verification certificate without needing MetaMask or ETH.

> **Firewall Note:** Ensure Windows Defender Firewall or your local firewall permits Python to receive incoming connections on private networks.

---

## Role-Based Access Control (RBAC) & Demo Wallets

When testing with MetaMask on the local network (`http://127.0.0.1:8545`, Chain ID `31337`), import the private keys generated by `npm run node`. The first 5 development accounts map directly to the seeded demo roles:

| Hardhat Account | Default Seeded Role | Workspace Privileges |
| :---: | :--- | :--- |
| **Account #0** | **Regulator** (Deployer) | Approve/revoke entity roles, issue recalls, transfer regulator role. |
| **Account #1** | **Manufacturer** | Register new vaccine batches, dispatch to distributors. |
| **Account #2** | **Distributor** | Accept custody, dispatch deliveries to clinics, sign receipt. |
| **Account #3** | **Clinic** | Confirm clinic receipt, administer hashed doses to patients. |
| **Account #4** | **Temperature Logger** | Record temperature readings via Sensor Console or CLI. |

### MetaMask Local Account Reset Tip
If you restart the local Hardhat node, local block numbers reset back to 0. MetaMask may reject transactions due to nonce desynchronization. To resolve:
1. In MetaMask, open **Settings → Advanced**.
2. Click **Clear activity tab data** (or **Reset account**).
3. Ensure **Hardhat Local** (RPC `http://127.0.0.1:8545`, Chain ID `31337`) is selected, reload `http://localhost:8080`, and reconnect.

---

## Sensor Telemetry Simulator

Batches in `IN_TRANSIT` or `DELIVERED` status accept temperature telemetry logs. Readings can be sent through the frontend **Sensor Console** (with Account #4 connected) or directly via the Hardhat simulation script:

**PowerShell (Windows):**
```powershell
# 1. Normal readings (2.5°C, 4.5°C, 7.0°C - within the 2.0°C-8.0°C budget)
$env:BATCH_ID="1"; $env:SENSOR_MODE="normal"; npx hardhat run scripts/simulate-sensor.js --network localhost

# 2. Thermal Spike (12.0°C-15.0°C excursions; applies expiry penalties)
$env:BATCH_ID="1"; $env:SENSOR_MODE="spike";  npx hardhat run scripts/simulate-sensor.js --network localhost

# 3. Critical Breach (>20.0°C sustained; consumes entire budget and marks SPOILED)
$env:BATCH_ID="1"; $env:SENSOR_MODE="breach"; npx hardhat run scripts/simulate-sensor.js --network localhost
```

**Bash (Linux / macOS):**
```bash
BATCH_ID=1 SENSOR_MODE=normal npx hardhat run scripts/simulate-sensor.js --network localhost
BATCH_ID=1 SENSOR_MODE=spike  npx hardhat run scripts/simulate-sensor.js --network localhost
BATCH_ID=1 SENSOR_MODE=breach npx hardhat run scripts/simulate-sensor.js --network localhost
```

---

## Preflight Web3 Transaction Architecture

To prevent silent transaction failures, user fund loss, or cryptic MetaMask revert dialogs, the frontend implements a robust multi-stage transaction pipeline:

1. **Signer & Account Alignment:** Queries `eth_accounts` to verify that the active MetaMask account matches the UI state.
2. **Chain ID Verification:** Guards against wrong-network submissions by verifying `walletNetwork.chainId === config.chainId`.
3. **On-Chain Preflight Simulation:** Calls `.staticCall(...args)` prior to opening the MetaMask pop-up. If the caller lacks permissions or the batch state is invalid, a descriptive error toast is rendered before the user interacts with MetaMask.
4. **Gas Buffer Protection:** Calculates gas consumption via `.estimateGas(...)` and applies a 20% safety margin (`gasLimit = (estimate * 120n) / 100n`).
5. **Strict Receipt Verification:** Waits for 1 blockchain confirmation (`receipt.wait(1)`) and re-queries the RPC (`waitForTransaction`) to verify `status === 1`.

---

## Test Suite & Verification

The project includes 13 comprehensive integration tests in `test/VaxPass.test.js` covering every contract feature:

```bash
npx hardhat test
```

### Verified Test Cases:
- [x] Role request, approval, and revocation mechanics under regulator authority.
- [x] Transfer of regulator role and enforcement of new permissions.
- [x] Unauthorized registration rejection and manufacturer batch instantiation.
- [x] Full dual-confirmation custody flow between distributor and clinic.
- [x] In-range temperature telemetry logging without expiry or budget penalties.
- [x] Calculation and deduction of dynamic expiry penalties (`10x`) on excursions.
- [x] Autonomous transition to `SPOILED` upon excursion budget exhaustion.
- [x] Halting of receipt confirmation and dose administration on spoiled batches.
- [x] Zero-PII dose administration, duplicate patient hash blocking, and batch depletion.
- [x] Immediate regulator recall enforcement across active batches.
- [x] Public expiry finalization (`markExpired()`) and rejection of expired batch usage.
- [x] Rejection of illegal state transitions and unauthorized custodians.
- [x] Public verification status codes (`VALID`, `WARNING`, `INVALID`) and analytics aggregates.

---

## Presentation Runbook (5-Minute Viva / Demo)

| Time | Stage | Action & Key Talking Points |
| :---: | :--- | :--- |
| **0:00 - 0:45** | **Introduction & Public Verification** | Open `http://localhost:8080`. Emphasize that **Verify**, **Passport**, and **Analytics** work without a wallet. Search `VX001` to display the green `VALID` badge. |
| **0:45 - 1:30** | **Batch Passport & QR Code** | Open Passport for `VX001`. Explain custody timeline and temperature parameters. Highlight the mobile-friendly QR code for consumer verification. |
| **1:30 - 2:30** | **IoT Telemetry & Expiry Penalty** | Connect MetaMask Account #4 (Logger). Navigate to **Sensor Console**. Fire a `Normal` reading (in-range), then a `Spike` reading. Point out the dynamic drop in `Effective Expiry` and the increment in `Excursions Logged`. Fire `Breach` to show autonomous transition to `SPOILED`. |
| **2:30 - 3:30** | **Custody Transfer & Dual Confirmation** | Switch to Account #1 (Manufacturer). Register or dispatch `VX002` to Account #2 (Distributor). Switch to Account #2, accept custody, and deliver to Clinic (Account #3). Demonstrate dual receipt confirmation from both sides. |
| **3:30 - 4:15** | **Privacy-Preserving Administration** | Switch to Account #3 (Clinic). Open the administration modal, enter a patient identifier, and explain that only the `keccak256` hash is sent on-chain. Attempt a duplicate injection with the same patient ID to show the cryptographic duplicate-prevention guard. |
| **4:15 - 5:00** | **Regulatory Recall & Global Analytics** | Switch to Account #0 (Regulator). Recall a batch with a stated safety notice. Finish on the **Analytics Dashboard** to show live on-chain metrics across all batches. |

---

## Screenshot Checklist for Project Report

A companion Word document generator is provided in the repository (`build_vaxpass_document.py`), creating `VaxPass_Project_Explanation_and_Screenshot_Guide.docx`. Capture these 14 key screenshots for your final submission:

1. **Navbar & RBAC Header:** MetaMask connected showing active account address and role badge.
2. **Public Verify View:** Unauthenticated state with verification input and quick-select buttons.
3. **VALID Verification Certificate:** `VX001` passport showing green `VALID` banner and batch specs.
4. **Supply Chain Stepper:** Visual tracking stepper depicting progression through manufacturer, distributor, and clinic.
5. **Scannable QR Passport:** Live batch passport with generated QR code and public URL.
6. **Sensor Console Interface:** Temperature logger workspace showing threshold dials and telemetry feeds.
7. **Normal Telemetry Confirmation:** Confirmed reading entries within safe thermal range (2°C–8°C).
8. **Thermal Spike & Expiry Impact:** Excursion budget consumption card showing adjusted effective expiry.
9. **Critical Breach Alert:** Red `SPOILED` banner with locked custody actions following budget overflow.
10. **Manufacturer Dispatch Queue:** Batch registration form and pending distributor dispatch modal.
11. **Distributor Custody Handover:** Dual-confirmation panel with clinic destination assignment.
12. **Clinic Dose Administration:** Modal showing client-side patient ID hashing and dose counter decrement.
13. **Regulator Recall Shield:** On-chain recall execution panel with reason log and immediate freeze.
14. **Global Analytics Dashboard:** Aggregate metrics cards (Total Batches, Doses Given, Spoiled, Recalled, Excursions).

---

## Sepolia Testnet Deployment

To deploy VaxPass to the public Ethereum Sepolia testnet:

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Configure your Sepolia RPC endpoint (Alchemy, Infura, etc.) and deployer private key:
   ```env
   SEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY"
   PRIVATE_KEY="0xYOUR_EXPORTED_SEPOLIA_PRIVATE_KEY"
   ```
3. Deploy the smart contract:
   ```bash
   npm run deploy:sepolia
   ```
   *(This automatically updates `frontend/contract.json` with the Sepolia contract address and Chain ID `11155111`).*
4. Optionally seed initial demo roles and batches on Sepolia:
   ```bash
   npm run seed:sepolia
   ```
5. Host the `frontend` folder on any static web host (Vercel, Netlify, Cloudflare Pages, or GitHub Pages). MetaMask will prompt users to switch network to Sepolia (Chain ID `11155111`).

---

## Repository Structure

```
VaxPass/
├── contracts/
│   └── VaxPass.sol             # Core smart contract with RBAC, custody, telemetry & privacy logic
├── frontend/
│   ├── app.js                  # DApp client logic, ethers.js v6 integration, preflight simulation
│   ├── contract.json           # Active contract address, chain ID, and public ABI (auto-generated)
│   ├── favicon.svg             # VaxPass vector brand icon
│   ├── index.html              # Single-page application structure & semantic modal dialogs
│   └── style.css               # Design system: Apple translucency, dark mode, responsive styling
├── scripts/
│   ├── deploy.js               # Contract deployment script (exports ABI/address to frontend)
│   ├── seed.js                 # Local/Sepolia account role authorization and batch seeding
│   └── simulate-sensor.js      # CLI telemetry generator (normal, spike, breach modes)
├── test/
│   └── VaxPass.test.js         # 13 comprehensive Chai/Mocha smart contract integration tests
├── build_vaxpass_document.py   # Python docx generator for project documentation and report guide
├── start.bat                   # 1-click Windows runner (starts node, deploys, seeds, launches UI)
├── start-vaxpass.bat           # Startup wrapper (delegates to start.bat)
├── hardhat.config.js           # Hardhat network, compiler optimizer, and chain configuration
├── package.json                # Project dependencies, scripts, and dev packages
└── README.md                   # Comprehensive project documentation and guides
```

---

## Smart Contract Logic Reference

- **Expiry Penalty Formula:**
  $$\Delta \text{Expiry} = \text{durationMins} \times 10 \times 60 \text{ seconds}$$
  $$\text{effectiveExpiry} = \max(\text{manufactureTime}, \text{effectiveExpiry} - \Delta \text{Expiry})$$
  *(Guaranteed by the contract never to underflow below `manufactureTime`).*
- **Spoilage Condition:**
  $$\text{excursionMinsUsed} > \text{excursionBudgetMins} \implies \text{status} = \text{Status.SPOILED}$$
- **Verification Return Codes:**
  - `0 (VALID)`: Status is `MANUFACTURED`, `IN_TRANSIT`, `DELIVERED`, or `IN_USE`, not expired, with zero excursions.
  - `1 (WARNING)`: Status is active, but excursions have been recorded, or expiry is within 7 days.
  - `2 (INVALID)`: Status is `SPOILED`, `RECALLED`, `EXPIRED`, or `block.timestamp >= effectiveExpiry`.
- **Public Maintenance:**
  - `markExpired(uint256 id)`: Can be executed permissionlessly by any account or keeper bot when `block.timestamp >= effectiveExpiry` to transition an outdated batch to `EXPIRED`.
- **Cryptographic Patient Privacy:**
  - Dose administration requires passing `bytes32 patientHash = keccak256(bytes(patientId))`.
  - The contract stores `mapping(uint256 => mapping(bytes32 => bool)) private _patientTreated`.
  - No personal identification records (PII) exist on the Ethereum state ledger.

---

## License

This project is open-source and released under the [MIT License](LICENSE).
