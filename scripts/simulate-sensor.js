const { ethers, network } = require("hardhat");
const { signTelemetry, createReadingPayload } = require("../frontend/hardware-enclave");

const STATUS = [
  "MANUFACTURED",
  "IN_TRANSIT",
  "DELIVERED",
  "IN_USE",
  "DEPLETED",
  "SPOILED",
  "RECALLED",
  "EXPIRED"
];

const PRESET_TELEMETRY = {
  normal: [
    { temp: 2.5, duration: 5 },
    { temp: 4.8, duration: 5 },
    { temp: 7.2, duration: 5 }
  ],
  spike: [
    { temp: 12.5, duration: 3 },
    { temp: 14.8, duration: 4 },
    { temp: 6.5, duration: 5 }
  ],
  breach: [
    { temp: 22.0, duration: 25 },
    { temp: 26.5, duration: 30 }
  ]
};

async function main() {
  const batchId = Number(process.env.BATCH_ID || process.argv[2] || 1);
  const mode = process.env.SENSOR_MODE || process.argv[3] || "normal";

  if (!Number.isInteger(batchId) || batchId < 1 || !PRESET_TELEMETRY[mode]) {
    console.log("==========================================================================");
    console.log("VaxPass Enterprise IoT Hardware Enclave Simulator");
    console.log("==========================================================================");
    console.log("Usage:");
    console.log("  npx hardhat run scripts/simulate-sensor.js --network localhost <batchId> <mode>");
    console.log("Or via environment variables:");
    console.log("  BATCH_ID=1 SENSOR_MODE=spike npm run sensor:local");
    console.log("");
    console.log("Modes: normal (2-8°C), spike (12-15°C excursion), breach (22-26°C spoilage)");
    console.log("==========================================================================");
    process.exit(1);
  }

  const contractConfig = require("../frontend/contract.json");
  const contractAddress = contractConfig.address;
  const chainId = contractConfig.chainId || Number((await ethers.provider.getNetwork()).chainId);

  console.log(`Target Contract Address: ${contractAddress} (Chain ID: ${chainId})`);
  console.log(`Simulating Batch ID: ${batchId} in Mode: [${mode.toUpperCase()}]`);

  // Signer #4 is the designated hardware IoT sensor with LOGGER_ROLE
  const signers = await ethers.getSigners();
  const hardwareSensor = signers[4];
  const sensorAddress = await hardwareSensor.getAddress();
  console.log(`Hardware Sensor Device Address: ${sensorAddress}`);

  // Attach ABI to contract
  const vax = await ethers.getContractAt(contractConfig.contractName || "VaxPassUpgradeable", contractAddress);

  // Ensure batch exists and is in transitable status
  const initialBatch = await vax.getBatch(batchId);
  console.log(`Current Status: ${STATUS[Number(initialBatch.status)]}`);
  console.log(`Effective Expiry: ${new Date(Number(initialBatch.effectiveExpiry) * 1000).toLocaleString()}`);
  console.log(`Excursion Used: ${initialBatch.excursionMinsUsed} / ${initialBatch.excursionBudgetMins} mins\n`);

  for (const item of PRESET_TELEMETRY[mode]) {
    // 1. Fetch current sequence nonce from smart contract
    const currentNonce = await vax.sensorNonces(sensorAddress);
    const nowTimestamp = (await ethers.provider.getBlock("latest")).timestamp;

    // 2. Build structured reading payload
    const reading = createReadingPayload({
      batchId,
      tempCelsius: item.temp,
      durationMins: item.duration,
      nonce: currentNonce,
      timestamp: nowTimestamp
    });

    console.log(`[Sensor Enclave] Signing packet: ${item.temp}°C for ${item.duration}m | Nonce: ${currentNonce}`);

    // 3. Generate cryptographic EIP-712 signature inside simulated secure element
    const { signature } = await signTelemetry(hardwareSensor, contractAddress, chainId, reading);

    // 4. Submit cryptographically authenticated payload to smart contract
    const tx = await vax.connect(hardwareSensor).submitSignedTelemetry(reading, signature);
    const receipt = await tx.wait();

    console.log(`  └─ Verified & Mined in tx ${receipt.hash.slice(0, 18)}… | Gas: ${receipt.gasUsed}`);
  }

  // Final State Report
  const updatedBatch = await vax.getBatch(batchId);
  console.log("\n==========================================================================");
  console.log("Telemetry Run Summary:");
  console.log(`Batch ${batchId} Status: ${STATUS[Number(updatedBatch.status)]}`);
  console.log(`Excursion Mins Used: ${updatedBatch.excursionMinsUsed} / ${updatedBatch.excursionBudgetMins} mins`);
  console.log(`Effective Expiry: ${new Date(Number(updatedBatch.effectiveExpiry) * 1000).toLocaleString()}`);
  console.log("==========================================================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
