# VaxPass

VaxPass is a college mini-project demonstrating a blockchain-based cold-chain vaccine passport. It tracks batch custody, temperature readings, temperature-aware effective expiry, recalls, and privacy-preserving dose administration on Ethereum.

> Sensor data in this project is simulated. A production system would need trusted, tamper-resistant hardware and an oracle/attestation design before putting sensor readings on-chain.

## Stack

- Solidity `^0.8.20`, Hardhat, OpenZeppelin `AccessControl`
- Plain HTML, CSS, and JavaScript; ethers.js v6 and qrcode.js loaded from CDNs
- MetaMask for transactions, local Hardhat first, then Sepolia

## Prerequisites

- Node.js 20 or 22 LTS is recommended. The project was also validated on Windows ARM64 with Node 24, which makes Hardhat print a compatibility warning.
- MetaMask browser extension
- Python 3 (only to serve the static frontend locally)

## Setup and local run

For an easier Windows startup, double-click `start-vaxpass.bat` in the project folder. It opens the Hardhat node, deploys and seeds the demo contract, and starts the frontend server in separate PowerShell windows. Keep those windows open while using the application.

```bash
npm install
npx hardhat compile
npx hardhat test
```

On Windows ARM64 with a Node release that cannot build the unused `classic-level` native adapter, use this equivalent install command:

```bash
npm install --ignore-scripts
```

Start the blockchain in terminal 1. The host option lets another device on the same Wi-Fi network read the local chain for QR verification:

```bash
npm run node
```

Deploy and seed it in terminal 2:

```bash
npm run deploy:local
npm run seed:local
```

`deploy.js` writes the address and ABI to `frontend/contract.json`, so the UI always uses the current deployment. Serve the frontend in terminal 3:

```bash
python -m http.server 8080 --directory frontend
```

Open `http://localhost:8080`. Add the Hardhat local network to MetaMask (RPC `http://127.0.0.1:8545`, chain ID `31337`, currency `ETH`) and import one of the public development accounts printed by `npm run node`. Never use those development keys on a real network.

Batch QR codes open the public verification route without requiring a wallet. For phone scanning on the same Wi-Fi network:

```powershell
python -m http.server 8080 --bind 0.0.0.0 --directory frontend
```

Open `http://192.168.0.106:8080` on the computer, open a batch passport, and click **Set phone-accessible URL** if the QR still shows `localhost`. Enter the computer's current Wi-Fi address, such as `http://192.168.0.106:8080`. A QR containing `localhost` can only be opened on the computer running the server. Both devices must be on the same Wi-Fi network, and Windows Firewall must allow Python through private networks.

## Verify each project step

1. **Contract:** `npx hardhat compile` should compile `VaxPass.sol`.
2. **Tests:** `npx hardhat test` runs 13 tests covering roles, custody, readings, spoilage, expiry, recall, privacy hashing, verification, and statistics.
3. **Deploy/seed:** after the commands above, `frontend/contract.json` has a non-empty address and the console reports approvals plus VX001 through VX005 registration.
4. **Frontend:** open the site, use **Verify** and enter `VX001`; it works without a wallet. Connect MetaMask for write actions.
5. **Simulator:** dispatch a batch, then log readings as shown below.

## Roles and local demo accounts

The seeded local accounts map to the first five Hardhat accounts. The seed script creates five batches, VX001 through VX005, on a fresh chain and adds missing batches without duplicating existing ones:

| Account | Role |
| --- | --- |
| #0 | Regulator / deployer |
| #1 | Manufacturer |
| #2 | Distributor |
| #3 | Clinic |
| #4 | Temperature logger |

An entity first uses **Register role**. The regulator approves that wallet in **Regulator panel**. The seed script performs this approval for the demo accounts.

## Sensor simulator

The batch must be `IN_TRANSIT` or `DELIVERED` before it can receive readings. The demo page lets the manufacturer dispatch VX001 and the distributor accept it.

PowerShell:

```powershell
$env:BATCH_ID="1"; $env:SENSOR_MODE="normal"; npx hardhat run scripts/simulate-sensor.js --network localhost
$env:BATCH_ID="1"; $env:SENSOR_MODE="spike";  npx hardhat run scripts/simulate-sensor.js --network localhost
$env:BATCH_ID="1"; $env:SENSOR_MODE="breach"; npx hardhat run scripts/simulate-sensor.js --network localhost
```

`normal` emits 2–8 °C readings; `spike` logs a few 12–15 °C excursions; `breach` logs long 20+ °C excursions that exceed the demo budget and mark the batch `SPOILED`.

## Live Wallet and RBAC

The frontend uses MetaMask for all write actions. The local Hardhat accounts are useful development wallets, but their private keys never enter the frontend:

| Account | Seeded role |
| --- | --- |
| Regulator | #0 |
| Manufacturer | #1 |
| Distributor | #2 |
| Clinic | #3 |
| Temperature Logger | #4 |

Connect the appropriate MetaMask account to access its workspace. The app listens for MetaMask account changes and immediately refreshes the signer, on-chain roles, visible workspace, and account-specific batch data. Public Verify, Passport, and Analytics remain available without a wallet; write workspaces enforce the corresponding on-chain role in the UI and contract.

## Demo Runbook

For a five-minute presentation, start with public Verify (30 seconds), open the VX001 Passport and explain custody (45 seconds), connect the Logger MetaMask account and run normal/spike/breach readings (90 seconds), switch MetaMask accounts for the VX002 custody and clinic flow (75 seconds), administer a dose and attempt a duplicate (30 seconds), then recall a batch and finish on Analytics (30 seconds). Sensor data is simulated; the signer and access control remain MetaMask/on-chain.

### Screenshots checklist

Capture these 14 views for the report:

1. MetaMask-connected navbar with the active account and role.
2. Public Verify page with no wallet connected.
3. VALID verification result for VX001.
4. VX001 Passport supply-chain stepper.
5. Passport QR code and public verification URL.
6. Logger MetaMask account on the Sensor Console before readings.
7. Normal readings showing confirmed feed entries.
8. Spike readings showing excursion budget and expiry impact.
9. Breach result showing the prominent `SPOILED` alert.
10. VX002 Manufacturer action queue and dispatch control.
11. Distributor custody acceptance and clinic handover queue.
12. Clinic dose administration and duplicate patient-hash blocked card.
13. Regulator recall with the contract-enforcement shield card.
14. Analytics dashboard with labeled outcomes, legend, and live activity.

## Sepolia deployment

1. Copy `.env.example` to `.env`.
2. Set `SEPOLIA_RPC_URL` to a Sepolia RPC endpoint and `PRIVATE_KEY` to a funded development wallet key (never commit `.env`).
3. Deploy with `npm run deploy:sepolia`. This updates `frontend/contract.json` to use Sepolia.
4. Seed optional demo roles/batches with `npm run seed:sepolia`.
5. Host the `frontend` directory over HTTPS. MetaMask will detect chain ID `11155111` from `contract.json`; switch it to Sepolia before transacting.

For a hosted frontend, replace the default local RPC in `app.js` or save a preferred RPC URL in browser local storage under `vaxpassRpc`.

## Suggested project demonstration

1. Approve the manufacturer, distributor, clinic, and logger roles.
2. Register VX001 and dispatch it to the distributor.
3. Log `normal`, then `spike`, then `breach` sensor modes; show the expiry penalty and automatic `SPOILED` result.
4. Use VX002 for the happy path: dispatch → accept custody → deliver to clinic → distributor confirms handover → clinic confirms receipt.
5. Administer doses using different patient IDs; explain that only the local `keccak256` hashes are sent on-chain.
6. Open its Passport, inspect the temperature chart/timeline, and scan its QR code to reach public verification.
7. Use the regulator panel to recall a batch and show that further actions are blocked.

## Screenshots checklist for the report

- Home screen with connected wallet and recent batches
- Role request and regulator approval transaction
- Manufacturer registration form and a new `VX00x` batch
- Distributor custody acceptance and dual-confirmation flow
- Temperature chart showing normal and excursion readings
- Spoiled batch with excursion budget progress
- Clinic dose administration and privacy statement
- Batch Passport QR code and public VALID/WARNING/INVALID verification banner
- Analytics cards/bar chart and regulator recall form

## Contract behavior notes

- A temperature excursion reduces `effectiveExpiry` by `duration × 10 minutes` and never underflows.
- More than the excursion budget automatically spoils a batch.
- `verifyBatch` returns `0 = VALID`, `1 = WARNING`, and `2 = INVALID`.
- `markExpired` is public, letting anyone finalize an expired active batch.
- The contract stores no patient identity—only a non-reversible `bytes32` patient hash per batch, preventing duplicate administration for that batch.
