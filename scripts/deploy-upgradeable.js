const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying VaxPass Enterprise Upgradeable System using account: ${deployer.address}`);

  // 1. Deploy Implementation Logic Contract
  const VaxPassFactory = await ethers.getContractFactory("VaxPassUpgradeable");
  const implementation = await VaxPassFactory.deploy();
  await implementation.waitForDeployment();
  const implAddress = await implementation.getAddress();
  console.log(`VaxPassUpgradeable Implementation deployed at: ${implAddress}`);

  // 2. Encode Initialize Data (assigning regulator role to deployer)
  const initData = implementation.interface.encodeFunctionData("initialize", [deployer.address]);

  // 3. Deploy ERC1967Proxy via VaxPassProxy Wrapper
  const ProxyFactory = await ethers.getContractFactory("VaxPassProxy");
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  console.log(`VaxPass Enterprise Proxy (ERC1967) deployed at: ${proxyAddress}`);

  // 4. Export Artifacts for Frontend & DApp consumption
  const artifact = await hre.artifacts.readArtifact("VaxPassUpgradeable");
  const output = {
    contractName: "VaxPassUpgradeable",
    address: proxyAddress,
    implementationAddress: implAddress,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    network: network.name,
    abi: artifact.abi,
    deployedAt: new Date().toISOString()
  };

  const frontendDir = path.join(__dirname, "..", "frontend");
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.writeFileSync(path.join(frontendDir, "contract.json"), JSON.stringify(output, null, 2));
  console.log(`Updated frontend/contract.json with Proxy address: ${proxyAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
