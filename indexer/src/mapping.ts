import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  BatchRegistered,
  CustodyHopRecorded,
  CustodyTransferred,
  ReceiptConfirmed,
  TemperatureLogged,
  TelemetryVerified,
  ExcursionDetected,
  BatchSpoiled,
  BatchRecalled,
  DoseAdministeredWithCommitment,
  BatchExpired,
  VaxPassUpgradeable
} from "../generated/VaxPassUpgradeable/VaxPassUpgradeable";
import {
  Batch,
  CustodyHop,
  TemperatureLog,
  DoseReceipt,
  ProtocolStat
} from "../generated/schema";

function getOrCreateProtocolStat(): ProtocolStat {
  let stats = ProtocolStat.load("global");
  if (!stats) {
    stats = new ProtocolStat("global");
    stats.totalBatchesRegistered = BigInt.fromI32(0);
    stats.totalDosesAdministered = BigInt.fromI32(0);
    stats.totalExcursionsLogged = BigInt.fromI32(0);
    stats.totalSpoiledBatches = BigInt.fromI32(0);
    stats.lastUpdated = BigInt.fromI32(0);
    stats.save();
  }
  return stats;
}

export function handleBatchRegistered(event: BatchRegistered): void {
  let batchId = event.params.id.toString();
  let batch = new Batch(batchId);
  let contract = VaxPassUpgradeable.bind(event.address);
  let onChainBatch = contract.getBatch(event.params.id);

  batch.batchId = event.params.id;
  batch.lotNumber = event.params.lotNumber;
  batch.vaccineName = onChainBatch.vaccineName;
  batch.dosesRemaining = onChainBatch.dosesRemaining;
  batch.totalDoses = onChainBatch.totalDoses;
  batch.printedExpiry = onChainBatch.printedExpiry;
  batch.effectiveExpiry = onChainBatch.effectiveExpiry;
  batch.minTempX10 = onChainBatch.minTempX10;
  batch.maxTempX10 = onChainBatch.maxTempX10;
  batch.excursionBudgetMins = onChainBatch.excursionBudgetMins;
  batch.excursionMinsUsed = onChainBatch.excursionMinsUsed;
  batch.ipfsCid = onChainBatch.ipfsCid;
  batch.status = "MANUFACTURED";
  batch.manufacturer = event.params.manufacturer;
  batch.custodian = onChainBatch.custodian;
  batch.clinic = onChainBatch.clinic;
  batch.distributorConfirmed = false;
  batch.clinicConfirmed = false;
  batch.createdAt = event.block.timestamp;
  batch.updatedAt = event.block.timestamp;
  batch.save();

  let stats = getOrCreateProtocolStat();
  stats.totalBatchesRegistered = stats.totalBatchesRegistered.plus(BigInt.fromI32(1));
  stats.lastUpdated = event.block.timestamp;
  stats.save();
}

export function handleCustodyHopRecorded(event: CustodyHopRecorded): void {
  let batchId = event.params.id.toString();
  let hopId = batchId + "-" + event.params.hopIndex.toString();
  let hop = new CustodyHop(hopId);

  hop.batch = batchId;
  hop.hopIndex = event.params.hopIndex;
  hop.from = event.params.from;
  hop.to = event.params.to;
  hop.timestamp = event.params.timestamp;
  hop.locationCode = event.params.locationCode;
  hop.notes = event.params.notes;
  hop.transactionHash = event.transaction.hash;
  hop.save();

  let batch = Batch.load(batchId);
  if (batch) {
    batch.custodian = event.params.to;
    batch.updatedAt = event.block.timestamp;
    batch.save();
  }
}

export function handleCustodyTransferred(event: CustodyTransferred): void {
  let batch = Batch.load(event.params.id.toString());
  if (batch) {
    batch.custodian = event.params.to;
    let s = event.params.status;
    if (s == 1) batch.status = "IN_TRANSIT";
    else if (s == 2) batch.status = "DELIVERED";
    else if (s == 3) batch.status = "IN_USE";
    batch.updatedAt = event.block.timestamp;
    batch.save();
  }
}

export function handleReceiptConfirmed(event: ReceiptConfirmed): void {
  let batch = Batch.load(event.params.id.toString());
  if (batch) {
    if (event.params.distributorSide) {
      batch.distributorConfirmed = true;
    } else {
      batch.clinicConfirmed = true;
    }
    batch.updatedAt = event.block.timestamp;
    batch.save();
  }
}

export function handleTemperatureLogged(event: TemperatureLogged): void {
  let batchId = event.params.id.toString();
  let logId = batchId + "-" + event.block.timestamp.toString() + "-" + event.logIndex.toString();
  let log = new TemperatureLog(logId);

  log.batch = batchId;
  log.tempX10 = event.params.tempX10;
  log.durationMins = event.params.durationMins;
  log.timestamp = event.block.timestamp;
  log.isExcursion = event.params.excursion;
  log.sequenceNonce = BigInt.fromI32(0);
  log.transactionHash = event.transaction.hash;
  log.save();

  let batch = Batch.load(batchId);
  if (batch) {
    let contract = VaxPassUpgradeable.bind(event.address);
    let onChainBatch = contract.getBatch(event.params.id);
    batch.effectiveExpiry = onChainBatch.effectiveExpiry;
    batch.excursionMinsUsed = onChainBatch.excursionMinsUsed;
    batch.updatedAt = event.block.timestamp;
    batch.save();
  }
}

export function handleTelemetryVerified(event: TelemetryVerified): void {
  let stats = getOrCreateProtocolStat();
  stats.lastUpdated = event.block.timestamp;
  stats.save();
}

export function handleExcursionDetected(event: ExcursionDetected): void {
  let stats = getOrCreateProtocolStat();
  stats.totalExcursionsLogged = stats.totalExcursionsLogged.plus(BigInt.fromI32(1));
  stats.lastUpdated = event.block.timestamp;
  stats.save();
}

export function handleBatchSpoiled(event: BatchSpoiled): void {
  let batch = Batch.load(event.params.id.toString());
  if (batch) {
    batch.status = "SPOILED";
    batch.updatedAt = event.block.timestamp;
    batch.save();
  }

  let stats = getOrCreateProtocolStat();
  stats.totalSpoiledBatches = stats.totalSpoiledBatches.plus(BigInt.fromI32(1));
  stats.lastUpdated = event.block.timestamp;
  stats.save();
}

export function handleBatchRecalled(event: BatchRecalled): void {
  let batch = Batch.load(event.params.id.toString());
  if (batch) {
    batch.status = "RECALLED";
    batch.updatedAt = event.block.timestamp;
    batch.save();
  }
}

export function handleDoseAdministeredWithCommitment(event: DoseAdministeredWithCommitment): void {
  let batchId = event.params.id.toString();
  let receiptId = batchId + "-" + event.params.commitment.toHexString();
  let receipt = new DoseReceipt(receiptId);

  receipt.batch = batchId;
  receipt.commitment = event.params.commitment;
  receipt.administeredAt = event.block.timestamp;
  receipt.clinic = event.params.clinic;
  receipt.transactionHash = event.transaction.hash;
  receipt.save();

  let batch = Batch.load(batchId);
  if (batch) {
    let contract = VaxPassUpgradeable.bind(event.address);
    let onChainBatch = contract.getBatch(event.params.id);
    batch.dosesRemaining = onChainBatch.dosesRemaining;
    if (onChainBatch.dosesRemaining.equals(BigInt.fromI32(0))) {
      batch.status = "DEPLETED";
    }
    batch.updatedAt = event.block.timestamp;
    batch.save();
  }

  let stats = getOrCreateProtocolStat();
  stats.totalDosesAdministered = stats.totalDosesAdministered.plus(BigInt.fromI32(1));
  stats.lastUpdated = event.block.timestamp;
  stats.save();
}

export function handleBatchExpired(event: BatchExpired): void {
  let batch = Batch.load(event.params.id.toString());
  if (batch) {
    batch.status = "EXPIRED";
    batch.updatedAt = event.block.timestamp;
    batch.save();
  }
}
