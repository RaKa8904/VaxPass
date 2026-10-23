const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

/**
 * Enterprise Layer-2 Deployment Script (Base Sepolia / Arbitrum Sepolia)
 * Deploys VaxPassUpgradeable UUPS proxy, MockPaymaster, and exports L2 deployment metadata.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`====================================================`);
  console.log(`Deploying VaxPass Enterprise to Layer-2: ${network.name}`);
  console.log(`Chain ID: ${net.chainId}`);
  console.log(`Deployer Address: ${deployer.address}`);
  console.log(`Deployer Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log(`====================================================`);

  // 1. Deploy Logic Implementation
  console.log("\n[1/4] Deploying VaxPassUpgradeable Implementation...");
  const VaxPassFactory = await ethers.getContractFactory("VaxPassUpgradeable");
  const implementation = await VaxPassFactory.deploy();
  await implementation.waitForDeployment();
  const implAddress = await implementation.getAddress();
  console.log(`✓ Implementation deployed at: ${implAddress}`);

  // 2. Initialize UUPS Proxy
  console.log("\n[2/4] Deploying ERC1967 Proxy Wrapper...");
  const initData = implementation.interface.encodeFunctionData("initialize", [deployer.address]);
  const ProxyFactory = await ethers.getContractFactory("VaxPassProxy");
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  console.log(`✓ VaxPass Enterprise L2 Proxy deployed at: ${proxyAddress}`);

  // 3. Deploy ERC-4337 Paymaster on L2
  console.log("\n[3/4] Deploying ERC-4337 Paymaster on L2...");
  const PaymasterFactory = await ethers.getContractFactory("MockPaymaster");
  const paymaster = await PaymasterFactory.deploy();
  await paymaster.waitForDeployment();
  const paymasterAddress = await paymaster.getAddress();
  console.log(`✓ Paymaster deployed at: ${paymasterAddress}`);

  // Fund Paymaster if deployer has enough balance
  const deployerBal = await ethers.provider.getBalance(deployer.address);
  if (deployerBal >= ethers.parseEther("0.1")) {
    const fundAmount = ethers.parseEther("0.05");
    const fundTx = await deployer.sendTransaction({ to: paymasterAddress, value: fundAmount });
    await fundTx.wait();
    console.log(`✓ Funded Paymaster with ${ethers.formatEther(fundAmount)} ETH gas sponsorship reserve.`);
  }

  // 4. Export L2 Artifacts
  console.log("\n[4/4] Exporting L2 deployment metadata...");
  const artifact = await hre.artifacts.readArtifact("VaxPassUpgradeable");
  const paymasterArtifact = await hre.artifacts.readArtifact("MockPaymaster");

  const l2Deployment = {
    network: network.name,
    chainId: Number(net.chainId),
    vaxPassProxy: proxyAddress,
    vaxPassImplementation: implAddress,
    paymasterAddress: paymasterAddress,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      VaxPassUpgradeable: {
        address: proxyAddress,
        abi: artifact.abi
      },
      MockPaymaster: {
        address: paymasterAddress,
        abi: paymasterArtifact.abi
      }
    }
  };

  const outputPath = path.join(__dirname, "..", "frontend", "contract-l2.json");
  fs.writeFileSync(outputPath, JSON.stringify(l2Deployment, null, 2));
  console.log(`✓ Saved L2 configuration to: frontend/contract-l2.json`);
  console.log(`\nDeployment successfully finished on ${network.name}!`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
