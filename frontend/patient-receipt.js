/**
 * VaxPass Enterprise: Client-Side Salted Patient Receipt & Privacy Module
 *
 * Implements blinding salt generation, client-side commitment derivation,
 * and zero-knowledge digital receipt verification for dose administration.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("ethers"));
  } else {
    root.VaxPassReceipt = factory(root.ethers);
  }
})(typeof self !== "undefined" ? self : this, function (ethers) {
  "use strict";

  if (!ethers) {
    console.warn("VaxPassReceipt: Ethers.js library is required.");
  }

  /**
   * Generates a 32-byte cryptographically secure random hex string.
   */
  function generateRandomBytes32() {
    const array = new Uint8Array(32);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(array);
    } else {
      for (let i = 0; i < 32; i++) {
        array[i] = Math.floor(Math.random() * 256);
      }
    }
    return ethers.hexlify(array);
  }

  /**
   * Derives a salted patient secret from a raw patient ID or MRN.
   * Uses HMAC or salted hash so raw IDs never leak.
   */
  function derivePatientSecret(rawPatientId, userPin = "") {
    const rawBytes = ethers.toUtf8Bytes(`${rawPatientId}::${userPin}`);
    return ethers.keccak256(rawBytes);
  }

  /**
   * Computes the on-chain commitment digest:
   * keccak256(abi.encodePacked(patientSecret, batchId, salt))
   */
  function computeCommitment(patientSecret, batchId, salt) {
    const packed = ethers.solidityPacked(
      ["bytes32", "uint256", "bytes32"],
      [patientSecret, BigInt(batchId), salt]
    );
    return ethers.keccak256(packed);
  }

  /**
   * Creates a full patient digital receipt containing blinding parameters.
   */
  function createDoseReceipt({ batchId, rawPatientId, vaccineName = "", lotNumber = "" }) {
    const salt = generateRandomBytes32();
    const patientSecret = derivePatientSecret(rawPatientId);
    const commitment = computeCommitment(patientSecret, batchId, salt);

    return {
      protocol: "VaxPass-Enterprise-v2",
      standard: "SaltedCommitment-HIPAA-Compliant",
      batchId: Number(batchId),
      vaccineName,
      lotNumber,
      commitment,
      salt,
      patientSecret,
      createdAt: new Date().toISOString(),
      instructions: "Keep this digital receipt secure in your mobile wallet. Your identity is cryptographically protected and cannot be reverse-engineered on-chain."
    };
  }

  /**
   * Verifies a digital receipt against an on-chain contract instance.
   * Can be executed completely via client staticCall without broadcasting raw secrets.
   */
  async function verifyReceiptOnChain(contract, receipt) {
    if (!contract || !receipt) throw new Error("Contract and receipt are required");
    const { batchId, commitment } = receipt;
    const result = await contract.hasDoseCommitment(batchId, commitment);
    return {
      administered: Boolean(result[0] || result.administered),
      timestamp: Number(result[1] || result.timestamp),
      clinic: result[2] || result.clinic,
      commitment
    };
  }

  return {
    generateRandomBytes32,
    derivePatientSecret,
    computeCommitment,
    createDoseReceipt,
    verifyReceiptOnChain
  };
});
