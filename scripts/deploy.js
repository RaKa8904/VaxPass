const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const VaxPass = await ethers.getContractFactory("VaxPass");
  const vaxPass = await VaxPass.deploy();
  await vaxPass.waitForDeployment();
  const address = await vaxPass.getAddress();

  // The frontend deliberately receives only the deployed address and public ABI.
  const artifact = await hre.artifacts.readArtifact("VaxPass");
  const output = {
    contractName: "VaxPass",
    address,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    network: network.name,
    abi: artifact.abi
  };
  const frontendDir = path.join(__dirname, "..", "frontend");
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.writeFileSync(path.join(frontendDir, "contract.json"), JSON.stringify(output, null, 2));
  console.log(`VaxPass deployed to ${address} on ${network.name}.`);
  console.log("Wrote frontend/contract.json");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
