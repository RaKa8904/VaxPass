const { ethers } = require("hardhat");

async function approve(vax, regulator, account, role, label) {
  if (!(await vax.hasRole(role, account.address))) {
    await (await vax.connect(account).requestRole(role)).wait();
    await (await vax.connect(regulator).approveEntity(account.address, role)).wait();
    console.log(`Approved ${label}: ${account.address}`);
  }
}

async function main() {
  const [regulator, manufacturer, distributor, clinic, logger] = await ethers.getSigners();
  const address = require("../frontend/contract.json").address;
  const vax = await ethers.getContractAt("VaxPass", address);
  await approve(vax, regulator, manufacturer, await vax.MANUFACTURER_ROLE(), "manufacturer");
  await approve(vax, regulator, distributor, await vax.DISTRIBUTOR_ROLE(), "distributor");
  await approve(vax, regulator, clinic, await vax.CLINIC_ROLE(), "clinic");
  await approve(vax, regulator, logger, await vax.LOGGER_ROLE(), "temperature logger");

  const stats = await vax.getStats();
  if (stats.totalBatches === 0n) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await (await vax.connect(manufacturer).registerBatch(
      "DemoVax", "VX001-LOT", 20, now + 90 * 24 * 60 * 60, 20, 80, 30, "QmVaxPassDemo1"
    )).wait();
    await (await vax.connect(manufacturer).registerBatch(
      "DemoVax", "VX002-LOT", 10, now + 120 * 24 * 60 * 60, 20, 80, 45, "QmVaxPassDemo2"
    )).wait();
    console.log("Registered sample batches VX001 and VX002.");
  } else {
    console.log("Batches already exist; roles were checked without creating duplicates.");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
