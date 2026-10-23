# VaxPass Enterprise Frontend: Account Abstraction, Paymaster & GS1 Barcode Scanner

Welcome to the **VaxPass Enterprise** frontend application. Phase 3 upgrades the user interface from a MetaMask-dependent web3 demo into a frictionless **Web2.5 pharmaceutical logistics portal**, featuring ERC-4337 Account Abstraction, gasless Paymaster transactions, zero-PII digital dose receipts, and GS1 2D DataMatrix camera scanning.

---

## Key Phase 3 Capabilities

### 1. ERC-4337 Account Abstraction (Passkeys & Email OTP)
* **Zero Seed Phrases:** Drivers, warehouse workers, and clinic nurses do not need to install browser extensions (like MetaMask) or manage 12-word seed phrases.
* **WebAuthn Passkeys:** Native biometric authentication using Touch ID, Face ID, or Windows Hello security keys.
* **Deterministic Smart Contract Accounts:** A smart contract wallet is deterministically provisioned under the hood using CREATE2 derivation (`VaxPassAA.deriveSmartAccountAddress`), providing a dedicated on-chain identity for each employee.
* **Corporate Email Login:** Instant sign-in via hospital or logistics corporate email.

### 2. Gasless Transactions (ERC-4337 Paymaster Integration)
* **Zero Native Gas Required:** End-users can interact with the smart contract with **0 ETH** in their wallets.
* **Sponsored Core Operations:**
  - `dispatchTransfer`: Dispatches batches across logistics hops.
  - `acceptTransfer`: Confirms intake at transit hubs.
  - `administerDose`: Records salted patient dose commitments.
  - `submitSignedTelemetry`: Broadcasts hardware enclave sensor readings.
* **Production & Local Paymaster Support:**
  - **Local Development:** Employs [`contracts/MockPaymaster.sol`](../contracts/MockPaymaster.sol) and a sponsoring relayer to fund and execute transactions seamlessly on Hardhat.
  - **Production:** Out-of-the-box support for Biconomy Paymaster, Alchemy Gas Manager, and Pimlico VerifyingPaymaster via ERC-4337 UserOperations.

### 3. GS1 2D DataMatrix Camera Scanner
* **Camera-Based Scanning:** Integrated `html5-qrcode` engine allowing smartphone and laptop camera barcode recognition.
* **Standard Compliance:** Full parsing for **FDA DSCSA** (Drug Supply Chain Security Act) and **EU FMD** (Falsified Medicines Directive) packaging:
  - **AI (01):** GTIN (Global Trade Item Number - 14 digits)
  - **AI (17):** Expiration Date (YYMMDD format converted to ISO and Unix timestamp)
  - **AI (10):** Batch / Lot Number
  - **AI (21):** Unit Serial Number
* **One-Click Auto-Fill:**
  - In Manufacturer view: Scans GS1 packaging and automatically populates the Lot Number and Expiry Date.
  - In Distributor view: Scans packaging barcode to search and accept incoming shipments.
  - In Public Verification: Scans packaging DataMatrix to immediately verify cold-chain compliance.
  - Includes a "Test with Sample GS1 Barcode" fallback button for headless/test environments.

### 4. Zero-PII Salted Vaccination Passes
* **Cryptographic Privacy:** Generates a 256-bit blinding salt client-side for each administered dose (`keccak256(patientSecret + batchId + salt)`).
* **Verifiable Digital Pass:** Upon dose administration, renders a digital pass modal with an exportable JSON receipt and a framed QR code for mobile wallet verification.

---

## Configuration & Environment Variables

Paymaster and RPC settings can be configured via environment variables or in `frontend/account-abstraction.js`:

```javascript
// Biconomy / Alchemy / Pimlico Paymaster URL
const DEFAULT_PAYMASTER_URL = "https://paymaster.biconomy.io/api/v1/YOUR_API_KEY";

// ERC-4337 Bundler RPC Endpoint (e.g., Alto, Stackup, Biconomy)
const DEFAULT_BUNDLER_URL = "https://bundler.biconomy.io/api/v2/YOUR_API_KEY";
```

For local testing on Hardhat:
* The system defaults to local RPC (`http://127.0.0.1:8545`).
* Signer #0 acts as the gas sponsorship relayer, executing through `MockPaymaster`.

---

## Running the Application Locally

1. **Start Hardhat Node:**
   ```bash
   npx hardhat node
   ```

2. **Deploy Upgradeable System & Paymaster:**
   ```bash
   npx hardhat run scripts/deploy-upgradeable.js --network localhost
   npx hardhat run scripts/deploy-paymaster.js --network localhost
   ```

3. **Launch Frontend:**
   ```bash
   npx http-server frontend -p 8080
   ```
   Open `http://localhost:8080` in any modern web browser.

4. **Run Unit Tests:**
   ```bash
   npm test
   ```
   Runs the full 32-test suite covering UUPS upgradeability, DAG multi-hop tracking, EIP-712 telemetry, and ERC-4337 Paymaster sponsorship.
