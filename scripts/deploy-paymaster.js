const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying MockPaymaster using account: ${deployer.address}`);

  const MockPaymasterFactory = await ethers.getContractFactory("MockPaymaster");
  const paymaster = await MockPaymasterFactory.deploy();
  await paymaster.waitForDeployment();
  const paymasterAddress = await paymaster.getAddress();
  console.log(`MockPaymaster deployed at: ${paymasterAddress}`);

  // Fund Paymaster with 2 ETH sponsorship gas reserve
  const fundTx = await deployer.sendTransaction({
    to: paymasterAddress,
    value: ethers.parseEther("2.0")
  });
  await fundTx.wait();
  console.log(`MockPaymaster funded with 2.0 ETH gas sponsorship balance.`);

  const artifact = await hre.artifacts.readArtifact("MockPaymaster");
  const output = {
    contractName: "MockPaymaster",
    address: paymasterAddress,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    network: network.name,
    abi: artifact.abi,
    deployedAt: new Date().toISOString()
  };

  const frontendDir = path.join(__dirname, "..", "frontend");
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.writeFileSync(path.join(frontendDir, "paymaster.json"), JSON.stringify(output, null, 2));
  console.log(`Saved frontend/paymaster.json with Paymaster address: ${paymasterAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
