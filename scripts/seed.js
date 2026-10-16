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

  const presets = [
    ["DemoVax", "VX001-LOT", 20, 90, 30, "QmVaxPassDemo1"],
    ["DemoVax", "VX002-LOT", 10, 120, 45, "QmVaxPassDemo2"],
    ["ColdStorageVax", "VX003-LOT", 50, 150, 20, "QmVaxPassDemo3"],
    ["PediatricVax", "VX004-LOT", 30, 180, 30, "QmVaxPassDemo4"],
    ["TravelVax", "VX005-LOT", 15, 210, 15, "QmVaxPassDemo5"]
  ];
  const stats = await vax.getStats();
  let total = Number(stats.totalBatches);
  if (total < presets.length) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    for (const [name, lot, doses, expiryDays, budget, cid] of presets.slice(total)) {
      await (await vax.connect(manufacturer).registerBatch(
        name, lot, doses, now + expiryDays * 24 * 60 * 60, 20, 80, budget, cid
      )).wait();
      total++;
      console.log(`Registered sample batch VX${String(total).padStart(3, "0")}.`);
    }
  } else {
    console.log(`Batches already exist (${total}); roles were checked without creating duplicates.`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
