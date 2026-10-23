/**
 * VaxPass Enterprise: IoT Hardware Secure Element Enclave Simulator
 *
 * Implements EIP-712 typed structured data signing for cold-chain IoT temperature
 * sensors (e.g., Microchip ATECC608A / Nordic nRF9160 secure elements).
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("ethers"));
  } else {
    root.HardwareEnclave = factory(root.ethers);
  }
})(typeof self !== "undefined" ? self : this, function (ethers) {
  "use strict";

  const EIP712_DOMAIN_NAME = "VaxPassTelemetry";
  const EIP712_DOMAIN_VERSION = "1";

  const SENSOR_READING_TYPES = {
    SensorReading: [
      { name: "batchId", type: "uint256" },
      { name: "tempX10", type: "int256" },
      { name: "durationMins", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "timestamp", type: "uint256" }
    ]
  };

  /**
   * Constructs the EIP-712 domain descriptor for VaxPass telemetry.
   */
  function getDomain(chainId, verifyingContractAddress) {
    return {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: Number(chainId),
      verifyingContract: verifyingContractAddress
    };
  }

  /**
   * Creates a structured telemetry reading payload.
   */
  function createReadingPayload({
    batchId,
    tempCelsius,
    durationMins = 5,
    nonce = 0,
    timestamp = Math.floor(Date.now() / 1000)
  }) {
    return {
      batchId: BigInt(batchId),
      tempX10: BigInt(Math.round(tempCelsius * 10)),
      durationMins: BigInt(durationMins),
      nonce: BigInt(nonce),
      timestamp: BigInt(timestamp)
    };
  }

  /**
   * Signs a telemetry payload using an Ethers Signer or Wallet (representing the hardware private key).
   *
   * @param {ethers.Signer|ethers.Wallet} hardwareSigner Signer possessing the device's private key.
   * @param {string} contractAddress Proxy address of VaxPass.
   * @param {number|string} chainId Network chain ID.
   * @param {Object} reading The SensorReading payload.
   * @returns {Promise<{ reading: Object, signature: string, sensorAddress: string, domain: Object }>}
   */
  async function signTelemetry(hardwareSigner, contractAddress, chainId, reading) {
    const domain = getDomain(chainId, contractAddress);
    const signature = await hardwareSigner.signTypedData(domain, SENSOR_READING_TYPES, reading);
    const sensorAddress = await hardwareSigner.getAddress();

    return {
      reading,
      signature,
      sensorAddress,
      domain
    };
  }

  /**
   * Verifies off-chain that an EIP-712 signature matches the claimed hardware sensor address.
   */
  function verifyTelemetrySignature(contractAddress, chainId, reading, signature) {
    const domain = getDomain(chainId, contractAddress);
    return ethers.verifyTypedData(domain, SENSOR_READING_TYPES, reading, signature);
  }

  return {
    EIP712_DOMAIN_NAME,
    EIP712_DOMAIN_VERSION,
    SENSOR_READING_TYPES,
    getDomain,
    createReadingPayload,
    signTelemetry,
    verifyTelemetrySignature
  };
});
