const { ethers } = require("hardhat");

const STATUS = ["MANUFACTURED", "IN_TRANSIT", "DELIVERED", "IN_USE", "DEPLETED", "SPOILED", "RECALLED", "EXPIRED"];
const READINGS = {
  normal: [[25, 5], [45, 5], [70, 5]],       // 2.5 C, 4.5 C, 7.0 C
  spike: [[120, 3], [150, 3], [65, 5]],      // a short 12-15 C excursion
  breach: [[220, 20], [250, 20]]             // long excursion; exceeds demo budget
};

async function main() {
  // Older Hardhat releases do not forward `-- <args>` to run scripts, so both
  // ordinary Node arguments and environment variables are supported.
  const id = Number(process.env.BATCH_ID || process.argv[2]);
  const mode = process.env.SENSOR_MODE || process.argv[3];
  if (!Number.isInteger(id) || id < 1 || !READINGS[mode]) {
    throw new Error("Set BATCH_ID and SENSOR_MODE (normal|spike|breach), e.g. BATCH_ID=1 SENSOR_MODE=normal npx hardhat run scripts/simulate-sensor.js --network localhost");
  }
  const address = require("../frontend/contract.json").address;
  const vax = await ethers.getContractAt("VaxPass", address);
  const logger = (await ethers.getSigners())[4]; // matches the seeded LOGGER account
  for (const [tempX10, minutes] of READINGS[mode]) {
    const tx = await vax.connect(logger).logTemperature(id, tempX10, minutes);
    await tx.wait();
    console.log(`Logged ${(tempX10 / 10).toFixed(1)} C for ${minutes} minute(s).`);
  }
  const batch = await vax.getBatch(id);
  console.log(`Resulting status: ${STATUS[Number(batch.status)]}; excursion used: ${batch.excursionMinsUsed} min.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
