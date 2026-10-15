const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("VaxPass", function () {
  const DAY = 24 * 60 * 60;
  const Status = { MANUFACTURED: 0, IN_TRANSIT: 1, DELIVERED: 2, IN_USE: 3, DEPLETED: 4, SPOILED: 5, RECALLED: 6, EXPIRED: 7 };
  let vax, regulator, manufacturer, distributor, clinic, logger, outsider;
  let roles;

  async function deployFixture() {
    [regulator, manufacturer, distributor, clinic, logger, outsider] = await ethers.getSigners();
    const VaxPass = await ethers.getContractFactory("VaxPass");
    vax = await VaxPass.deploy();
    await vax.waitForDeployment();
    roles = {
      manufacturer: await vax.MANUFACTURER_ROLE(), distributor: await vax.DISTRIBUTOR_ROLE(),
      clinic: await vax.CLINIC_ROLE(), logger: await vax.LOGGER_ROLE()
    };
  }

  async function approve(signer, role) {
    await vax.connect(signer).requestRole(role);
    await vax.connect(regulator).approveEntity(signer.address, role);
  }

  async function approveAll() {
    await approve(manufacturer, roles.manufacturer);
    await approve(distributor, roles.distributor);
    await approve(clinic, roles.clinic);
    await approve(logger, roles.logger);
  }

  async function register({ doses = 3, budget = 30, expiryDays = 90 } = {}) {
    const expiry = (await time.latest()) + expiryDays * DAY;
    await vax.connect(manufacturer).registerBatch("Vax-A", "LOT-001", doses, expiry, 20, 80, budget, "QmDemoCID");
    return 1;
  }

  async function sendToClinic(id = 1) {
    await vax.connect(manufacturer).dispatchBatch(id, distributor.address);
    await vax.connect(distributor).acceptCustody(id);
    await vax.connect(distributor).deliverToClinic(id, clinic.address);
    await vax.connect(distributor).confirmReceipt(id);
    await vax.connect(clinic).confirmReceipt(id);
  }

  beforeEach(deployFixture);

  it("lets entities request, approve and revoke only valid roles", async function () {
    await expect(vax.connect(manufacturer).requestRole(roles.manufacturer))
      .to.emit(vax, "RoleRequested").withArgs(manufacturer.address, roles.manufacturer);
    expect(await vax.requestedRole(manufacturer.address)).to.equal(roles.manufacturer);
    await expect(vax.connect(regulator).approveEntity(manufacturer.address, roles.manufacturer))
      .to.emit(vax, "EntityApproved");
    expect(await vax.hasRole(roles.manufacturer, manufacturer.address)).to.equal(true);
    await expect(vax.connect(regulator).revokeEntity(manufacturer.address, roles.manufacturer))
      .to.emit(vax, "EntityRevoked");
    expect(await vax.hasRole(roles.manufacturer, manufacturer.address)).to.equal(false);
    await expect(vax.connect(outsider).approveEntity(manufacturer.address, roles.manufacturer)).to.be.revertedWith("Regulator role required");
    await expect(vax.connect(outsider).requestRole(await vax.REGULATOR_ROLE())).to.be.revertedWith("Invalid requested role");
  });

  it("transfers the regulator role", async function () {
    await expect(vax.connect(regulator).transferRegulator(outsider.address)).to.emit(vax, "RegulatorTransferred");
    expect(await vax.hasRole(await vax.REGULATOR_ROLE(), outsider.address)).to.equal(true);
    expect(await vax.hasRole(await vax.REGULATOR_ROLE(), regulator.address)).to.equal(false);
    await expect(vax.connect(regulator).revokeEntity(outsider.address, roles.logger)).to.be.revertedWith("Regulator role required");
  });

  it("rejects registration by an unapproved account and creates complete batches for manufacturers", async function () {
    const expiry = (await time.latest()) + 30 * DAY;
    await expect(vax.connect(outsider).registerBatch("No", "NO", 1, expiry, 20, 80, 2, ""))
      .to.be.revertedWithCustomError(vax, "AccessControlUnauthorizedAccount");
    await approve(manufacturer, roles.manufacturer);
    await expect(vax.connect(manufacturer).registerBatch("Vax-A", "LOT-001", 10, expiry, 20, 80, 30, "QmCID"))
      .to.emit(vax, "BatchRegistered").withArgs(1, "LOT-001", manufacturer.address);
    const batch = await vax.getBatch(1);
    expect(batch.id).to.equal(1);
    expect(batch.dosesRemaining).to.equal(10);
    expect(batch.custodian).to.equal(manufacturer.address);
    expect(batch.status).to.equal(Status.MANUFACTURED);
    expect((await vax.getBatchHistory(1)).length).to.equal(1);
  });

  it("runs the full dual-confirmation custody flow", async function () {
    await approveAll();
    await register();
    await vax.connect(manufacturer).dispatchBatch(1, distributor.address);
    expect((await vax.getBatch(1)).status).to.equal(Status.IN_TRANSIT);
    expect(await vax.pendingCustodian(1)).to.equal(distributor.address);
    await vax.connect(distributor).acceptCustody(1);
    await vax.connect(distributor).deliverToClinic(1, clinic.address);
    await expect(vax.connect(distributor).confirmReceipt(1)).to.emit(vax, "ReceiptConfirmed");
    expect((await vax.getBatch(1)).status).to.equal(Status.IN_TRANSIT);
    await expect(vax.connect(clinic).confirmReceipt(1)).to.emit(vax, "CustodyTransferred");
    const batch = await vax.getBatch(1);
    expect(batch.status).to.equal(Status.DELIVERED);
    expect(batch.custodian).to.equal(clinic.address);
    // Registration, dispatch, acceptance, clinic arrival, two confirmations, final transfer.
    expect((await vax.getBatchHistory(1)).length).to.equal(7);
  });

  it("keeps expiry and budget unchanged for in-range readings and stores the temperature log", async function () {
    await approveAll(); await register();
    await vax.connect(manufacturer).dispatchBatch(1, distributor.address);
    const before = await vax.getBatch(1);
    await expect(vax.connect(logger).logTemperature(1, 55, 5)).to.emit(vax, "TemperatureLogged").withArgs(1, 55, 5, false);
    const after = await vax.getBatch(1);
    expect(after.effectiveExpiry).to.equal(before.effectiveExpiry);
    expect(after.excursionMinsUsed).to.equal(0);
    const logs = await vax.getTemperatureLogs(1);
    expect(logs.length).to.equal(1);
    expect(logs[0].excursion).to.equal(false);
  });

  it("applies an expiry penalty and counts an out-of-range reading", async function () {
    await approveAll(); await register({ budget: 20 });
    await vax.connect(manufacturer).dispatchBatch(1, distributor.address);
    const before = await vax.getBatch(1);
    await expect(vax.connect(logger).logTemperature(1, 120, 4)).to.emit(vax, "ExcursionDetected").withArgs(1, 120, 4, 4 * 10 * 60);
    const after = await vax.getBatch(1);
    expect(after.excursionMinsUsed).to.equal(4);
    expect(after.effectiveExpiry).to.equal(before.effectiveExpiry - BigInt(4 * 10 * 60));
    expect((await vax.getTemperatureLogs(1))[0].excursion).to.equal(true);
  });

  it("automatically spoils a batch on budget overflow and blocks receipt and administration", async function () {
    await approveAll(); await register({ budget: 5 });
    await vax.connect(manufacturer).dispatchBatch(1, distributor.address);
    await vax.connect(distributor).acceptCustody(1);
    await vax.connect(distributor).deliverToClinic(1, clinic.address);
    await expect(vax.connect(logger).logTemperature(1, 150, 6)).to.emit(vax, "BatchSpoiled").withArgs(1, 6);
    expect((await vax.getBatch(1)).status).to.equal(Status.SPOILED);
    await expect(vax.connect(distributor).confirmReceipt(1)).to.be.revertedWith("Batch is blocked");
    await expect(vax.connect(clinic).administerDose(1, ethers.id("patient-1"))).to.be.revertedWith("Only clinic custodian");
  });

  it("blocks administration when a delivered batch later becomes spoiled", async function () {
    await approveAll(); await register({ budget: 2 }); await sendToClinic();
    await vax.connect(logger).logTemperature(1, 200, 3);
    expect((await vax.getBatch(1)).status).to.equal(Status.SPOILED);
    await expect(vax.connect(clinic).administerDose(1, ethers.id("patient-after-spoil")))
      .to.be.revertedWith("Batch cannot be used");
  });

  it("allows one hashed patient dose only, then marks the empty batch depleted", async function () {
    await approveAll(); await register({ doses: 2 }); await sendToClinic();
    const aliceHash = ethers.keccak256(ethers.toUtf8Bytes("patient-alice"));
    await expect(vax.connect(clinic).administerDose(1, aliceHash)).to.emit(vax, "DoseAdministered");
    expect((await vax.getBatch(1)).status).to.equal(Status.IN_USE);
    await expect(vax.connect(clinic).administerDose(1, aliceHash)).to.be.revertedWith("Patient already recorded for this batch");
    await vax.connect(clinic).administerDose(1, ethers.id("patient-bob"));
    const batch = await vax.getBatch(1);
    expect(batch.dosesRemaining).to.equal(0);
    expect(batch.status).to.equal(Status.DEPLETED);
  });

  it("recalls batches and blocks later use", async function () {
    await approveAll(); await register(); await sendToClinic();
    await expect(vax.connect(regulator).recallBatch(1, "Safety notice")).to.emit(vax, "BatchRecalled");
    expect((await vax.getBatch(1)).status).to.equal(Status.RECALLED);
    await expect(vax.connect(clinic).administerDose(1, ethers.id("patient"))).to.be.revertedWith("Batch cannot be used");
    await expect(vax.connect(outsider).recallBatch(1, "bad")).to.be.revertedWith("Regulator role required");
  });

  it("marks expired batches, rejects expired receipt/use, and reports invalid verification", async function () {
    await approveAll(); await register({ expiryDays: 1 });
    await vax.connect(manufacturer).dispatchBatch(1, distributor.address);
    await vax.connect(distributor).acceptCustody(1);
    await vax.connect(distributor).deliverToClinic(1, clinic.address);
    await time.increase(2 * DAY);
    await expect(vax.connect(distributor).confirmReceipt(1)).to.be.revertedWith("Batch is expired");
    await expect(vax.connect(outsider).markExpired(1)).to.emit(vax, "BatchExpired");
    expect((await vax.getBatch(1)).status).to.equal(Status.EXPIRED);
    const result = await vax.verifyBatch(1);
    expect(result.code).to.equal(2);
  });

  it("rejects unauthorized and invalid state transitions", async function () {
    await approveAll(); await register();
    await expect(vax.connect(distributor).acceptCustody(1)).to.be.revertedWith("Batch is not in transit");
    await expect(vax.connect(outsider).dispatchBatch(1, distributor.address)).to.be.revertedWith("Only current custodian");
    await expect(vax.connect(manufacturer).dispatchBatch(1, outsider.address)).to.be.revertedWith("Distributor not approved");
    await vax.connect(manufacturer).dispatchBatch(1, distributor.address);
    await expect(vax.connect(outsider).logTemperature(1, 50, 1)).to.be.revertedWithCustomError(vax, "AccessControlUnauthorizedAccount");
    await expect(vax.connect(logger).logTemperature(1, 50, 0)).to.be.revertedWith("Duration must be positive");
    await expect(vax.connect(distributor).deliverToClinic(1, clinic.address)).to.be.revertedWith("Only distributor custodian");
  });

  it("returns valid, warning and invalid verification codes and accurate aggregate statistics", async function () {
    await approveAll(); await register({ budget: 10 });
    let verification = await vax.verifyBatch(1);
    expect(verification.code).to.equal(0);
    await vax.connect(manufacturer).dispatchBatch(1, distributor.address);
    await vax.connect(logger).logTemperature(1, 120, 6); // 60% budget: warning
    verification = await vax.verifyBatch(1);
    expect(verification.code).to.equal(1);
    const missing = await vax.verifyBatch(999);
    expect(missing.code).to.equal(2);
    await vax.connect(logger).logTemperature(1, 120, 5); // exceeds budget: spoiled
    verification = await vax.verifyBatch(1);
    expect(verification.code).to.equal(2);
    const stats = await vax.getStats();
    expect(stats.totalBatches).to.equal(1);
    expect(stats.spoiled).to.equal(1);
    expect(stats.totalExcursionMinutes).to.equal(11);
    expect(stats.dosesAdministered).to.equal(0);
  });
});
