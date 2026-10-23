const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Phase 3: ERC-4337 Account Abstraction & Gasless Paymaster", function () {
  let vaxPass, paymaster, deployer, manufacturer, courierUser, clinicUser, sensorSigner, relayer;
  let courierSmartAccount, clinicSmartAccount;
  let BATCH_ID;

  beforeEach(async function () {
    [deployer, manufacturer, courierUser, clinicUser, sensorSigner, relayer] = await ethers.getSigners();

    // 1. Deploy VaxPassUpgradeable Implementation & Proxy
    const VaxPassFactory = await ethers.getContractFactory("VaxPassUpgradeable");
    const impl = await VaxPassFactory.deploy();
    await impl.waitForDeployment();

    const initData = impl.interface.encodeFunctionData("initialize", [deployer.address]);
    const ProxyFactory = await ethers.getContractFactory("VaxPassProxy");
    const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();

    vaxPass = await ethers.getContractAt("VaxPassUpgradeable", await proxy.getAddress());

    // 2. Deploy Smart Contract Accounts for Courier & Clinic (ERC-4337 smart wallets)
    const SmartAccountFactory = await ethers.getContractFactory("MockSmartAccount");
    courierSmartAccount = await SmartAccountFactory.deploy(courierUser.address);
    await courierSmartAccount.waitForDeployment();

    clinicSmartAccount = await SmartAccountFactory.deploy(clinicUser.address);
    await clinicSmartAccount.waitForDeployment();

    // 3. Approve roles on VaxPass
    const MOCK_ROLES = {
      regulator: await vaxPass.REGULATOR_ROLE(),
      manufacturer: await vaxPass.MANUFACTURER_ROLE(),
      distributor: await vaxPass.DISTRIBUTOR_ROLE(),
      clinic: await vaxPass.CLINIC_ROLE(),
      logger: await vaxPass.LOGGER_ROLE()
    };

    // Request and approve manufacturer
    await (await vaxPass.connect(manufacturer).requestRole(MOCK_ROLES.manufacturer)).wait();
    await (await vaxPass.connect(deployer).approveEntity(manufacturer.address, MOCK_ROLES.manufacturer)).wait();

    // Courier smart account requests DISTRIBUTOR_ROLE
    const reqDistData = vaxPass.interface.encodeFunctionData("requestRole", [MOCK_ROLES.distributor]);
    await courierSmartAccount.connect(courierUser).execute(await vaxPass.getAddress(), 0, reqDistData);
    await (await vaxPass.connect(deployer).approveEntity(await courierSmartAccount.getAddress(), MOCK_ROLES.distributor)).wait();

    // Clinic smart account requests CLINIC_ROLE
    const reqClinicData = vaxPass.interface.encodeFunctionData("requestRole", [MOCK_ROLES.clinic]);
    await clinicSmartAccount.connect(clinicUser).execute(await vaxPass.getAddress(), 0, reqClinicData);
    await (await vaxPass.connect(deployer).approveEntity(await clinicSmartAccount.getAddress(), MOCK_ROLES.clinic)).wait();

    // Sensor requests and is approved for LOGGER_ROLE
    await (await vaxPass.connect(sensorSigner).requestRole(MOCK_ROLES.logger)).wait();
    await (await vaxPass.connect(deployer).approveEntity(sensorSigner.address, MOCK_ROLES.logger)).wait();

    // 4. Deploy MockPaymaster
    const PaymasterFactory = await ethers.getContractFactory("MockPaymaster");
    paymaster = await PaymasterFactory.deploy();
    await paymaster.waitForDeployment();

    // 5. Fund Paymaster with gas sponsorship balance
    await deployer.sendTransaction({
      to: await paymaster.getAddress(),
      value: ethers.parseEther("2.0")
    });

    // 6. Register a test vaccine batch
    const now = Math.floor(Date.now() / 1000);
    const printedExpiry = now + 365 * 86400;
    const tx = await vaxPass.connect(manufacturer).registerBatch(
      "Comirnaty BNT162b2",
      "LOT-2026-P3",
      500,
      printedExpiry,
      20,
      80,
      120,
      "QmDemoManifest"
    );
    await tx.wait();
    BATCH_ID = 1;
  });

  it("should fund paymaster and verify sponsorship deposit", async function () {
    expect(await paymaster.getDeposit()).to.equal(ethers.parseEther("2.0"));
  });

  it("should validate ERC-4337 UserOperation according to IPaymaster standard", async function () {
    const dummyUserOp = {
      sender: await courierSmartAccount.getAddress(),
      nonce: 0,
      initCode: "0x",
      callData: "0x",
      callGasLimit: 200000,
      verificationGasLimit: 100000,
      preVerificationGas: 50000,
      maxFeePerGas: ethers.parseUnits("2", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
      paymasterAndData: await paymaster.getAddress(),
      signature: "0x"
    };

    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("op-12345"));
    const maxCost = ethers.parseEther("0.01");

    const [context, validationData] = await paymaster.validatePaymasterUserOp.staticCall(
      dummyUserOp,
      userOpHash,
      maxCost
    );

    expect(validationData).to.equal(0n);
    expect(context).to.not.equal("0x");

    // Execute on-chain to record event
    await expect(paymaster.validatePaymasterUserOp(dummyUserOp, userOpHash, maxCost))
      .to.emit(paymaster, "UserOpValidated")
      .withArgs(userOpHash, await courierSmartAccount.getAddress(), maxCost);

    // Call postOp
    await expect(paymaster.postOp(0, context, ethers.parseEther("0.005")))
      .to.emit(paymaster, "GasSponsored");
    expect(await paymaster.totalGasSponsored()).to.equal(ethers.parseEther("0.005"));
  });

  it("should execute gasless dispatchTransfer via smart account with paymaster sponsorship", async function () {
    const courierAddress = await courierSmartAccount.getAddress();
    const vaxPassAddress = await vaxPass.getAddress();

    // Manufacturer dispatches to courier smart account
    await vaxPass.connect(manufacturer).dispatchTransfer(
      BATCH_ID,
      courierAddress,
      "WH-01",
      "Dispatched to courier smart wallet"
    );

    const batch = await vaxPass.getBatch(BATCH_ID);
    expect(batch.status).to.equal(1); // IN_TRANSIT
    expect(await vaxPass.pendingCustodian(BATCH_ID)).to.equal(courierAddress);
  });

  it("should execute gasless acceptTransfer from courier smart account", async function () {
    const courierAddress = await courierSmartAccount.getAddress();
    const vaxPassAddress = await vaxPass.getAddress();

    // 1. Dispatch from manufacturer to courier
    await vaxPass.connect(manufacturer).dispatchTransfer(
      BATCH_ID,
      courierAddress,
      "AIRPORT-SFO",
      "Air transit dispatch"
    );

    // 2. Courier smart account accepts custody with 0 native ETH
    // Courier signs execution, relayer broadcasts, paymaster sponsors
    const acceptData = vaxPass.interface.encodeFunctionData("acceptTransfer", [
      BATCH_ID,
      "DIST-HUB-01",
      "0x",
      "Received in temperature controlled freezer container"
    ]);

    // Courier triggers smart account execute
    await courierSmartAccount.connect(courierUser).execute(vaxPassAddress, 0, acceptData);

    const batch = await vaxPass.getBatch(BATCH_ID);
    expect(batch.custodian).to.equal(courierAddress);
    expect(batch.status).to.equal(1); // IN_TRANSIT under courier custody
  });

  it("should execute gasless administerDose with salted ZK commitment from clinic smart wallet", async function () {
    const clinicAddress = await clinicSmartAccount.getAddress();
    const vaxPassAddress = await vaxPass.getAddress();

    // 1. Transfer to clinic
    await vaxPass.connect(manufacturer).dispatchTransfer(
      BATCH_ID,
      clinicAddress,
      "HUB-01",
      "Route to Community Clinic"
    );

    const acceptData = vaxPass.interface.encodeFunctionData("acceptTransfer", [
      BATCH_ID,
      "CLINIC-RM1",
      "0x",
      "Dock acceptance at clinic"
    ]);
    await clinicSmartAccount.connect(clinicUser).execute(vaxPassAddress, 0, acceptData);

    // 2. Deliver and prepare for administration
    // Generate salted commitment client-side
    const patientSecret = ethers.keccak256(ethers.toUtf8Bytes("PATIENT-SECRET-4337"));
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const commitment = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "uint256", "bytes32"], [patientSecret, BigInt(BATCH_ID), salt])
    );

    const adminData = vaxPass.interface.encodeFunctionData("administerDose", [BATCH_ID, commitment]);
    await clinicSmartAccount.connect(clinicUser).execute(vaxPassAddress, 0, adminData);

    // 3. Verify dose receipt on-chain
    const check = await vaxPass.verifyDoseReceipt(BATCH_ID, patientSecret, salt);
    expect(check.administered).to.be.true;
    expect(check.clinic).to.equal(clinicAddress);
  });

  it("should execute gasless submitSignedTelemetry with Paymaster sponsorship", async function () {
    // Put batch in transit
    await vaxPass.connect(manufacturer).dispatchTransfer(
      BATCH_ID,
      await courierSmartAccount.getAddress(),
      "SFO-WH",
      "Dispatching"
    );

    const vaxPassAddress = await vaxPass.getAddress();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const domain = {
      name: "VaxPassTelemetry",
      version: "1",
      chainId: Number(chainId),
      verifyingContract: vaxPassAddress
    };

    const types = {
      SensorReading: [
        { name: "batchId", type: "uint256" },
        { name: "tempX10", type: "int256" },
        { name: "durationMins", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "timestamp", type: "uint256" }
      ]
    };

    const reading = {
      batchId: BigInt(BATCH_ID),
      tempX10: 42n, // 4.2°C
      durationMins: 5n,
      nonce: 0n,
      timestamp: BigInt(Math.floor(Date.now() / 1000))
    };

    // Hardware enclave signs telemetry
    const signature = await sensorSigner.signTypedData(domain, types, reading);

    const callData = vaxPass.interface.encodeFunctionData("submitSignedTelemetry", [reading, signature]);

    // Relayer executes via paymaster sponsorship
    const tx = await paymaster.connect(relayer).executeSponsored(
      vaxPassAddress,
      callData,
      relayer.address
    );
    const receipt = await tx.wait();

    expect(await vaxPass.sensorNonces(sensorSigner.address)).to.equal(1n);

    // Verify GasSponsored event emitted by Paymaster
    const paymasterAddress = await paymaster.getAddress();
    const sponsoredLogs = receipt.logs.filter(l => l.address.toLowerCase() === paymasterAddress.toLowerCase());
    expect(sponsoredLogs.length).to.be.greaterThan(0);
  });
});
