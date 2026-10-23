const { ethers } = require("hardhat");
const { signTelemetry, createReadingPayload } = require("../frontend/hardware-enclave");

async function approve(vax, regulator, account, role, label) {
  try {
    if (!(await vax.hasRole(role, account.address))) {
      await (await vax.connect(account).requestRole(role)).wait();
      await (await vax.connect(regulator).approveEntity(account.address, role)).wait();
      console.log(`Approved ${label}: ${account.address}`);
    }
  } catch (e) {
    console.log(`Role check for ${label}: ${e.message}`);
  }
}

async function safeTx(fn, desc) {
  try {
    const tx = await fn();
    await tx.wait();
    console.log(`✔ ${desc}`);
    return true;
  } catch (err) {
    console.log(`ℹ Skipped (${desc}): ${err.shortMessage || err.reason || err.message}`);
    return false;
  }
}

async function main() {
  const [regulator, manufacturer, distributor, clinic, logger] = await ethers.getSigners();
  const contractConfig = require("../frontend/contract.json");
  const address = contractConfig?.address;
  if (!address) {
    console.error("ERROR: No contract address found in frontend/contract.json.");
    process.exit(1);
  }

  const vax = await ethers.getContractAt("VaxPass", address);
  console.log(`Connected to VaxPass at: ${address}`);

  // 1. Ensure all standard dev personas have roles approved
  await approve(vax, regulator, manufacturer, await vax.MANUFACTURER_ROLE(), "manufacturer");
  await approve(vax, regulator, distributor, await vax.DISTRIBUTOR_ROLE(), "distributor");
  await approve(vax, regulator, clinic, await vax.CLINIC_ROLE(), "clinic");
  await approve(vax, regulator, logger, await vax.LOGGER_ROLE(), "temperature logger");

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  let stats = await vax.getStats();
  let total = Number(stats.totalBatches);

  // 2. Ensure baseline batches exist (VX001 to VX006)
  const presets = [
    ["DemoVax mRNA", "VX001-LOT", 100, 90, 30, "QmVaxPassDemo1"],
    ["DemoVax mRNA", "VX002-LOT", 50, 120, 45, "QmVaxPassDemo2"],
    ["ColdStorageVax", "VX003-LOT", 80, 150, 20, "QmVaxPassDemo3"],
    ["PediatricVax", "VX004-LOT", 40, 180, 30, "QmVaxPassDemo4"],
    ["TravelVax Flu", "VX005-LOT", 60, 210, 25, "QmVaxPassDemo5"],
    ["QualityInspectVax", "VX006-LOT", 30, 60, 15, "QmVaxPassDemo6"]
  ];

  if (total < presets.length) {
    for (let i = total; i < presets.length; i++) {
      const [name, lot, doses, expiryDays, budget, cid] = presets[i];
      const expiry = now + expiryDays * 86400;
      await safeTx(
        () => vax.connect(manufacturer).registerBatch(name, lot, doses, expiry, 20, 80, budget, cid),
        `Registered batch VX${String(i + 1).padStart(3, "0")} (${name})`
      );
    }
  }

  // 3. Progress Batch 2 to in-transit distributor custody
  await safeTx(() => vax.connect(manufacturer).dispatchBatch(2, distributor.address), "Dispatched VX002 to distributor");
  await safeTx(() => vax.connect(distributor).acceptCustody(2), "Distributor accepted custody of VX002 (IN_TRANSIT)");

  // 4. Progress Batch 3 to clinic and administer doses
  await safeTx(() => vax.connect(manufacturer).dispatchBatch(3, distributor.address), "Dispatched VX003 to distributor");
  await safeTx(() => vax.connect(distributor).acceptCustody(3), "Distributor accepted custody of VX003");
  await safeTx(() => vax.connect(distributor).deliverToClinic(3, clinic.address), "Designated Clinic for VX003");
  await safeTx(() => vax.connect(distributor).confirmReceipt(3), "Distributor confirmed VX003 handover");
  await safeTx(() => vax.connect(clinic).confirmReceipt(3), "Clinic confirmed VX003 receipt (DELIVERED)");

  // Administer sample patient doses on Batch 3
  const patientSeeds = ["NHS-2026-ALPHA-01", "NHS-2026-ALPHA-02", "NHS-2026-ALPHA-03", "NHS-2026-ALPHA-04"];
  for (const pid of patientSeeds) {
    const salt = ethers.keccak256(ethers.toUtf8Bytes(pid + "-SALT-SECRET"));
    const commitment = ethers.keccak256(ethers.concat([ethers.toUtf8Bytes(pid), ethers.getBytes(salt)]));
    await safeTx(
      () => vax.connect(clinic).administerDose(3, commitment),
      `Administered dose on VX003 for patient ${pid}`
    );
  }

  // 5. Progress Batch 4 into clinic and administer doses
  await safeTx(() => vax.connect(manufacturer).dispatchBatch(4, distributor.address), "Dispatched VX004 to distributor");
  await safeTx(() => vax.connect(distributor).acceptCustody(4), "Distributor accepted custody of VX004");
  await safeTx(() => vax.connect(distributor).deliverToClinic(4, clinic.address), "Designated Clinic for VX004");
  await safeTx(() => vax.connect(distributor).confirmReceipt(4), "Distributor confirmed VX004 handover");
  await safeTx(() => vax.connect(clinic).confirmReceipt(4), "Clinic confirmed VX004 receipt (DELIVERED)");
  const pid4 = "NHS-2026-BETA-01";
  const salt4 = ethers.keccak256(ethers.toUtf8Bytes(pid4 + "-SALT-SECRET"));
  const commitment4 = ethers.keccak256(ethers.concat([ethers.toUtf8Bytes(pid4), ethers.getBytes(salt4)]));
  await safeTx(
    () => vax.connect(clinic).administerDose(4, commitment4),
    `Administered dose on VX004 for patient ${pid4}`
  );

  // 6. Submit hardware IoT telemetry on Batch 2 (safe reading + slight excursion)
  try {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const nonce = await vax.sensorNonces(logger.address);
    const reading = createReadingPayload({
      batchId: 2,
      tempX10: 95, // 9.5°C (slight excursion for 2-8°C vax)
      durationMins: 15,
      nonce: Number(nonce)
    });
    const sig = await signTelemetry(logger, reading, address, chainId);
    await safeTx(
      () => vax.connect(logger).submitSignedTelemetry(reading, sig),
      "Submitted EIP-712 hardware telemetry reading on VX002 (15 min excursion)"
    );
  } catch (err) {
    console.log("Telemetry simulation notice:", err.message);
  }

  // 7. Recall Batch 6 for quality assurance signal on the analytics dashboard
  await safeTx(
    () => vax.connect(regulator).recallBatch(6, "Packaging seal integrity recall (Quality Assurance Demo)"),
    "Batch VX006 recalled on-chain by Regulator"
  );

  const finalStats = await vax.getStats();
  console.log("==========================================================================");
  console.log("On-Chain Seeding Complete! Real-Time Analytics State:");
  console.log(`- Total Batches Registered : ${finalStats.totalBatches}`);
  console.log(`- Total Doses Administered : ${finalStats.dosesAdministered}`);
  console.log(`- Spoiled Batches          : ${finalStats.spoiled}`);
  console.log(`- Recalled Batches         : ${finalStats.recalled}`);
  console.log(`- Total Excursion Minutes  : ${finalStats.totalExcursionMinutes} min`);
  console.log(`- Total Custody Hops       : ${finalStats.totalHopsRecorded}`);
  console.log("==========================================================================");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
