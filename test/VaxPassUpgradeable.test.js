const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("VaxPassUpgradeable (Phase 1 Enterprise Architecture)", function () {
  const DAY = 24 * 60 * 60;
  const Status = {
    MANUFACTURED: 0,
    IN_TRANSIT: 1,
    DELIVERED: 2,
    IN_USE: 3,
    DEPLETED: 4,
    SPOILED: 5,
    RECALLED: 6,
    EXPIRED: 7
  };

  let regulator, manufacturer, carrier1, carrier2, clinic, outsider;
  let vaxImpl, vaxProxy, vax;
  let roles;

  async function deployUpgradeableFixture() {
    [regulator, manufacturer, carrier1, carrier2, clinic, outsider] = await ethers.getSigners();

    // 1. Deploy Implementation
    const VaxPassFactory = await ethers.getContractFactory("VaxPassUpgradeable");
    vaxImpl = await VaxPassFactory.deploy();
    await vaxImpl.waitForDeployment();
    const implAddress = await vaxImpl.getAddress();

    // 2. Encode Initialize Data
    const initData = vaxImpl.interface.encodeFunctionData("initialize", [regulator.address]);

    // 3. Deploy ERC1967Proxy via VaxPassProxy wrapper
    const ProxyFactory = await ethers.getContractFactory("VaxPassProxy");
    vaxProxy = await ProxyFactory.deploy(implAddress, initData);
    await vaxProxy.waitForDeployment();
    const proxyAddress = await vaxProxy.getAddress();

    // 4. Attach implementation ABI to proxy address
    vax = VaxPassFactory.attach(proxyAddress);

    roles = {
      regulator: await vax.REGULATOR_ROLE(),
      manufacturer: await vax.MANUFACTURER_ROLE(),
      distributor: await vax.DISTRIBUTOR_ROLE(),
      clinic: await vax.CLINIC_ROLE(),
      logger: await vax.LOGGER_ROLE()
    };
  }

  async function approveRole(signer, role) {
    await (await vax.connect(signer).requestRole(role)).wait();
    await (await vax.connect(regulator).approveEntity(signer.address, role)).wait();
  }

  beforeEach(deployUpgradeableFixture);

  describe("1. Upgradeability & UUPS Proxy Verification", function () {
    it("initializes proxy with regulator role and prevents re-initialization", async function () {
      expect(await vax.hasRole(roles.regulator, regulator.address)).to.equal(true);
      await expect(vax.initialize(outsider.address)).to.be.revertedWithCustomError(
        vax,
        "InvalidInitialization"
      );
    });

    it("rejects upgrades from unauthorized callers", async function () {
      const VaxPassFactory = await ethers.getContractFactory("VaxPassUpgradeable");
      const newImpl = await VaxPassFactory.deploy();
      await newImpl.waitForDeployment();

      await expect(
        vax.connect(outsider).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(vax, "AccessControlUnauthorizedAccount");
    });

    it("allows regulator to authorize upgrade to new implementation", async function () {
      const VaxPassFactory = await ethers.getContractFactory("VaxPassUpgradeable");
      const newImpl = await VaxPassFactory.deploy();
      await newImpl.waitForDeployment();
      const newImplAddress = await newImpl.getAddress();

      await expect(
        vax.connect(regulator).upgradeToAndCall(newImplAddress, "0x")
      ).to.emit(vax, "Upgraded").withArgs(newImplAddress);
    });
  });

  describe("2. Multi-Hop Supply Chain (DAG Model)", function () {
    beforeEach(async function () {
      await approveRole(manufacturer, roles.manufacturer);
      await approveRole(carrier1, roles.distributor);
      await approveRole(carrier2, roles.distributor);
      await approveRole(clinic, roles.clinic);
    });

    it("tracks an open multi-hop trajectory across international logistics checkpoints", async function () {
      const now = await time.latest();
      await vax.connect(manufacturer).registerBatch(
        "ModernaVax",
        "LOT-MULTI-01",
        1000,
        now + 180 * DAY,
        20,
        80,
        120,
        "QmIPFSManifest"
      );

      // Hop 1: Manufacturer (Basel, Switzerland) -> Air Cargo Carrier 1
      await vax.connect(manufacturer).dispatchTransfer(
        1,
        carrier1.address,
        "CHBSL",
        "Handover to Air Freight Carrier at Basel EuroAirport"
      );
      expect((await vax.getBatch(1)).status).to.equal(Status.IN_TRANSIT);

      await vax.connect(carrier1).acceptTransfer(
        1,
        "DEFRK",
        "0x1234abcd",
        "Received at Frankfurt CargoCity Hub"
      );
      expect((await vax.getBatch(1)).custodian).to.equal(carrier1.address);

      // Hop 2: Carrier 1 -> Carrier 2 (Cold Storage Logistics, Rotterdam Port)
      await vax.connect(carrier1).dispatchTransfer(
        1,
        carrier2.address,
        "DEFRK",
        "Dispatched via refrigerated truck to Rotterdam distribution center"
      );
      await vax.connect(carrier2).acceptTransfer(
        1,
        "NLRTM",
        "0x5678ef01",
        "Received at Rotterdam Port Cold Logistics"
      );
      expect((await vax.getBatch(1)).custodian).to.equal(carrier2.address);

      // Hop 3: Carrier 2 -> Destination Hospital Clinic (New York, JFK/Manhattan)
      await vax.connect(carrier2).dispatchTransfer(
        1,
        clinic.address,
        "NLRTM",
        "Transatlantic flight to JFK, delivery to Mount Sinai Clinic"
      );
      await vax.connect(clinic).acceptTransfer(
        1,
        "USNYC",
        "0x9abcdef0",
        "Delivered to Hospital Central Pharmacy"
      );

      const batch = await vax.getBatch(1);
      expect(batch.custodian).to.equal(clinic.address);
      expect(batch.clinic).to.equal(clinic.address);
      expect(batch.status).to.equal(Status.DELIVERED);

      // Verify immutable custody hop audit trail
      const hops = await vax.getCustodyHops(1);
      expect(hops.length).to.equal(3);

      expect(hops[0].from).to.equal(manufacturer.address);
      expect(hops[0].to).to.equal(carrier1.address);
      expect(hops[0].locationCode).to.equal("DEFRK");

      expect(hops[1].from).to.equal(carrier1.address);
      expect(hops[1].to).to.equal(carrier2.address);
      expect(hops[1].locationCode).to.equal("NLRTM");

      expect(hops[2].from).to.equal(carrier2.address);
      expect(hops[2].to).to.equal(clinic.address);
      expect(hops[2].locationCode).to.equal("USNYC");
    });
  });

  describe("3. Zero-PII Patient Privacy (Salted Commitments)", function () {
    beforeEach(async function () {
      await approveRole(manufacturer, roles.manufacturer);
      await approveRole(clinic, roles.clinic);

      const now = await time.latest();
      await vax.connect(manufacturer).registerBatch(
        "BioNTech",
        "LOT-SALT-01",
        2,
        now + 90 * DAY,
        20,
        80,
        60,
        "QmCID"
      );

      // Fast-track direct delivery to clinic
      await vax.connect(manufacturer).dispatchTransfer(1, clinic.address, "USNYC", "Direct clinic delivery");
      await vax.connect(clinic).acceptTransfer(1, "USNYC", "0x", "Received at clinic");
    });

    it("records salted commitments without leaking patient ID and verifies digital receipt", async function () {
      const patientId = "PATIENT-SSN-987-65-4321";
      const patientSecret = ethers.keccak256(ethers.toUtf8Bytes(patientId));
      const salt = ethers.hexlify(ethers.randomBytes(32));
      const batchId = 1;

      // Client computes commitment
      const commitment = await vax.computeCommitment(patientSecret, batchId, salt);

      // Clinic administers dose
      await expect(vax.connect(clinic).administerDose(batchId, commitment))
        .to.emit(vax, "DoseAdministeredWithCommitment")
        .withArgs(batchId, commitment, clinic.address);

      // Check on-chain commitment record
      const [administered, timestamp, administeringClinic] = await vax.hasDoseCommitment(batchId, commitment);
      expect(administered).to.equal(true);
      expect(timestamp).to.be.gt(0);
      expect(administeringClinic).to.equal(clinic.address);

      // Patient verifies receipt using secret and salt
      const receiptCheck = await vax.verifyDoseReceipt(batchId, patientSecret, salt);
      expect(receiptCheck.administered).to.equal(true);
      expect(receiptCheck.clinic).to.equal(clinic.address);

      // Double-dose rejection with same commitment
      await expect(
        vax.connect(clinic).administerDose(batchId, commitment)
      ).to.be.revertedWith("Commitment already used for this batch");

      // Second patient dose administration depletes batch
      const bobSecret = ethers.keccak256(ethers.toUtf8Bytes("PATIENT-BOB-1234"));
      const bobSalt = ethers.hexlify(ethers.randomBytes(32));
      const bobCommitment = await vax.computeCommitment(bobSecret, batchId, bobSalt);

      await vax.connect(clinic).administerDose(batchId, bobCommitment);
      const batch = await vax.getBatch(batchId);
      expect(batch.dosesRemaining).to.equal(0);
      expect(batch.status).to.equal(Status.DEPLETED);
    });
  });

  describe("4. Hardware-Authenticated Telemetry (EIP-712 IoT Verification)", function () {
    const { signTelemetry, createReadingPayload } = require("../frontend/hardware-enclave");
    let loggerSigner, proxyAddress, chainId;

    beforeEach(async function () {
      loggerSigner = outsider; // assign signer for hardware secure element tests
      await approveRole(manufacturer, roles.manufacturer);
      await approveRole(carrier1, roles.distributor);
      await approveRole(loggerSigner, roles.logger);

      proxyAddress = await vax.getAddress();
      chainId = Number((await ethers.provider.getNetwork()).chainId);

      const now = await time.latest();
      await vax.connect(manufacturer).registerBatch(
        "PfizerColdVax",
        "LOT-IOT-01",
        500,
        now + 120 * DAY,
        20,
        80,
        20, // 20-minute excursion budget
        "QmTelemetryCID"
      );

      // Dispatch to carrier1 so batch is in transitable status
      await vax.connect(manufacturer).dispatchTransfer(1, carrier1.address, "CHBSL", "Shipped via cold truck");
    });

    it("accepts valid in-range telemetry from an authorized hardware sensor", async function () {
      const now = await time.latest();
      const currentNonce = await vax.sensorNonces(loggerSigner.address);
      expect(currentNonce).to.equal(0n);

      const reading = createReadingPayload({
        batchId: 1,
        tempCelsius: 4.5, // within 2.0 - 8.0 range
        durationMins: 5,
        nonce: currentNonce,
        timestamp: now
      });

      const { signature } = await signTelemetry(loggerSigner, proxyAddress, chainId, reading);

      await expect(vax.connect(loggerSigner).submitSignedTelemetry(reading, signature))
        .to.emit(vax, "TelemetryVerified")
        .withArgs(1, loggerSigner.address, 0, 45)
        .and.to.emit(vax, "TemperatureLogged")
        .withArgs(1, 45, 5, false);

      expect(await vax.sensorNonces(loggerSigner.address)).to.equal(1n);

      const logs = await vax.getTemperatureLogs(1);
      expect(logs.length).to.equal(1);
      expect(logs[0].tempX10).to.equal(45);
      expect(logs[0].excursion).to.equal(false);
      expect(logs[0].logger).to.equal(loggerSigner.address);
    });

    it("applies dynamic expiry penalty and consumes excursion budget for thermal spikes", async function () {
      const batchBefore = await vax.getBatch(1);
      const now = await time.latest();
      const currentNonce = await vax.sensorNonces(loggerSigner.address);

      const reading = createReadingPayload({
        batchId: 1,
        tempCelsius: 14.0, // Excursion: above 8.0°C limit
        durationMins: 6,
        nonce: currentNonce,
        timestamp: now
      });

      const { signature } = await signTelemetry(loggerSigner, proxyAddress, chainId, reading);
      const expectedPenaltySeconds = 6 * 10 * 60; // 6 mins * 10 factor * 60 secs = 3600s (1 hr)

      await expect(vax.connect(loggerSigner).submitSignedTelemetry(reading, signature))
        .to.emit(vax, "ExcursionDetected")
        .withArgs(1, 140, 6, expectedPenaltySeconds);

      const batchAfter = await vax.getBatch(1);
      expect(batchAfter.excursionMinsUsed).to.equal(6);
      expect(batchAfter.effectiveExpiry).to.equal(batchBefore.effectiveExpiry - BigInt(expectedPenaltySeconds));
    });

    it("autonomously transitions batch to SPOILED when excursion budget is exhausted", async function () {
      const now = await time.latest();
      const currentNonce = await vax.sensorNonces(loggerSigner.address);

      // Excursion budget is 20 mins; submit 25-minute excursion
      const reading = createReadingPayload({
        batchId: 1,
        tempCelsius: 24.5,
        durationMins: 25,
        nonce: currentNonce,
        timestamp: now
      });

      const { signature } = await signTelemetry(loggerSigner, proxyAddress, chainId, reading);

      await expect(vax.connect(loggerSigner).submitSignedTelemetry(reading, signature))
        .to.emit(vax, "BatchSpoiled")
        .withArgs(1, 25);

      const batch = await vax.getBatch(1);
      expect(batch.status).to.equal(Status.SPOILED);

      // Verification report reflects spoiled status
      const verification = await vax.verifyBatch(1);
      expect(verification.code).to.equal(2);
      expect(verification.message).to.equal("Batch is spoiled");

      // Spoiled batch blocks custody acceptance
      await expect(
        vax.connect(carrier1).acceptTransfer(1, "DEFRK", "0x", "Attempt acceptance")
      ).to.be.revertedWith("Batch is blocked");
    });

    it("reverts replay attacks reusing an already-processed sequence nonce", async function () {
      const now = await time.latest();
      const reading = createReadingPayload({
        batchId: 1,
        tempCelsius: 5.0,
        durationMins: 5,
        nonce: 0,
        timestamp: now
      });

      const { signature } = await signTelemetry(loggerSigner, proxyAddress, chainId, reading);

      // First submission succeeds
      await vax.connect(loggerSigner).submitSignedTelemetry(reading, signature);

      // Second replay attempt with identical signature and nonce must revert
      await expect(
        vax.connect(loggerSigner).submitSignedTelemetry(reading, signature)
      ).to.be.revertedWith("Invalid sequence nonce");
    });

    it("reverts skipped or out-of-order nonces", async function () {
      const now = await time.latest();
      const skippedNonceReading = createReadingPayload({
        batchId: 1,
        tempCelsius: 5.0,
        durationMins: 5,
        nonce: 99, // Expected 0
        timestamp: now
      });

      const { signature } = await signTelemetry(loggerSigner, proxyAddress, chainId, skippedNonceReading);

      await expect(
        vax.connect(loggerSigner).submitSignedTelemetry(skippedNonceReading, signature)
      ).to.be.revertedWith("Invalid sequence nonce");
    });

    it("reverts tampered readings where temperature payload was altered in transit", async function () {
      const now = await time.latest();
      const validReading = createReadingPayload({
        batchId: 1,
        tempCelsius: 4.0,
        durationMins: 5,
        nonce: 0,
        timestamp: now
      });

      // Sign the 4.0°C reading
      const { signature } = await signTelemetry(loggerSigner, proxyAddress, chainId, validReading);

      // Adversary tampers with the temperature, changing it to 15.0°C without resigning
      const tamperedReading = { ...validReading, tempX10: 150n };

      await expect(
        vax.connect(loggerSigner).submitSignedTelemetry(tamperedReading, signature)
      ).to.be.revertedWith("Unauthorized sensor");
    });

    it("reverts telemetry signed by unauthorized hardware keys", async function () {
      const unauthorizedSigner = carrier2; // Not granted LOGGER_ROLE
      const now = await time.latest();
      const reading = createReadingPayload({
        batchId: 1,
        tempCelsius: 5.0,
        durationMins: 5,
        nonce: 0,
        timestamp: now
      });

      const { signature } = await signTelemetry(unauthorizedSigner, proxyAddress, chainId, reading);

      await expect(
        vax.connect(unauthorizedSigner).submitSignedTelemetry(reading, signature)
      ).to.be.revertedWith("Unauthorized sensor");
    });

    it("reverts calls to legacy manual logTemperature", async function () {
      await expect(
        vax.connect(loggerSigner).logTemperature(1, 50, 5)
      ).to.be.revertedWith("Deprecated: Use submitSignedTelemetry with hardware EIP-712 signatures");
    });
  });
});
