/**
 * VaxPass Enterprise: High-Performance GraphQL Indexer Client
 *
 * Replaces O(N) RPC loop polling with indexed subsecond GraphQL queries,
 * featuring pagination, status filtering, and automatic fallback to on-chain RPC.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.VaxPassGraphQL = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Default Subgraph Endpoint (The Graph Node or Goldsky / The Graph Studio)
  let endpoint = localStorage.getItem("vaxpassGraphqlUrl") || "http://127.0.0.1:8000/subgraphs/name/vaxpass/enterprise";

  let onlineState = false;

  function setEndpoint(url) {
    if (url) {
      endpoint = url;
      localStorage.setItem("vaxpassGraphqlUrl", url);
    }
  }

  function getEndpoint() {
    return endpoint;
  }

  async function checkHealth() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      onlineState = res.ok;
      return onlineState;
    } catch {
      onlineState = false;
      return false;
    }
  }

  function isOnline() {
    return onlineState;
  }

  /**
   * Executes a GraphQL POST request.
   */
  async function request(query, variables = {}) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) {
      onlineState = false;
      throw new Error(`GraphQL request failed with HTTP ${res.status}`);
    }
    const json = await res.json();
    if (json.errors?.length) {
      onlineState = false;
      throw new Error(json.errors[0].message);
    }
    onlineState = true;
    return json.data;
  }

  /**
   * Fetches paginated and filtered vaccine batches from the indexer.
   */
  async function fetchBatches({
    status = null,
    custodian = null,
    clinic = null,
    manufacturer = null,
    limit = 20,
    offset = 0,
    contractFallback = null
  } = {}) {
    const statusMap = ["MANUFACTURED", "IN_TRANSIT", "DELIVERED", "IN_USE", "DEPLETED", "SPOILED", "RECALLED", "EXPIRED"];

    const query = `
      query GetBatches($first: Int, $skip: Int, $where: Batch_filter) {
        batches(first: $first, skip: $skip, orderBy: createdAt, orderDirection: desc, where: $where) {
          id
          batchId
          vaccineName
          lotNumber
          dosesRemaining
          totalDoses
          printedExpiry
          effectiveExpiry
          minTempX10
          maxTempX10
          excursionBudgetMins
          excursionMinsUsed
          ipfsCid
          status
          manufacturer
          custodian
          clinic
          distributorConfirmed
          clinicConfirmed
          createdAt
          updatedAt
        }
      }
    `;

    const where = {};
    if (status !== null) {
      where.status = typeof status === "number" ? statusMap[status] : status;
    }
    if (custodian) where.custodian = custodian.toLowerCase();
    if (clinic) where.clinic = clinic.toLowerCase();
    if (manufacturer) where.manufacturer = manufacturer.toLowerCase();

    try {
      const data = await request(query, { first: limit, skip: offset, where });
      return {
        source: "graphql-subgraph",
        batches: data.batches.map(b => ({
          ...b,
          id: Number(b.id || b.batchId),
          status: statusMap.indexOf(b.status) >= 0 ? statusMap.indexOf(b.status) : 0
        }))
      };
    } catch (err) {
      console.warn("[GraphQL Client] Indexer query failed, falling back to on-chain RPC:", err.message);
      if (contractFallback) {
        const rpcBatches = await contractFallback();
        return {
          source: "rpc-fallback",
          batches: rpcBatches
        };
      }
      throw err;
    }
  }

  /**
   * Fetches deep passport record for a specific batch including hops and telemetry.
   */
  async function fetchBatchDetails(id, contractFallback = null) {
    const query = `
      query GetBatchDetails($id: ID!) {
        batch(id: $id) {
          id
          batchId
          vaccineName
          lotNumber
          dosesRemaining
          totalDoses
          printedExpiry
          effectiveExpiry
          minTempX10
          maxTempX10
          excursionBudgetMins
          excursionMinsUsed
          ipfsCid
          status
          manufacturer
          custodian
          clinic
          distributorConfirmed
          clinicConfirmed
          createdAt
          updatedAt
          hops(orderBy: hopIndex, orderDirection: asc) {
            id
            hopIndex
            from
            to
            timestamp
            locationCode
            notes
            transactionHash
          }
          telemetryLogs(orderBy: timestamp, orderDirection: desc) {
            id
            tempX10
            durationMins
            timestamp
            isExcursion
            sequenceNonce
            sensor
          }
          doseReceipts(orderBy: administeredAt, orderDirection: desc) {
            id
            commitment
            administeredAt
            clinic
          }
        }
      }
    `;

    try {
      const data = await request(query, { id: String(id) });
      if (data.batch) {
        return { source: "graphql-subgraph", batch: data.batch };
      }
    } catch (err) {
      console.warn(`[GraphQL Client] Batch ${id} query failed, falling back to RPC:`, err.message);
    }

    if (contractFallback) {
      const b = await contractFallback(id);
      return { source: "rpc-fallback", batch: b };
    }
    return null;
  }

  /**
   * Fetches high-level protocol statistics from the indexer.
   */
  async function fetchProtocolStats(contractFallback = null) {
    const query = `
      query GetProtocolStats {
        protocolStat(id: "global") {
          totalBatchesRegistered
          totalDosesAdministered
          totalExcursionsLogged
          totalSpoiledBatches
          lastUpdated
        }
      }
    `;

    try {
      const data = await request(query);
      if (data.protocolStat) {
        return {
          source: "graphql-subgraph",
          stats: {
            totalBatches: Number(data.protocolStat.totalBatchesRegistered),
            dosesAdministered: Number(data.protocolStat.totalDosesAdministered),
            excursions: Number(data.protocolStat.totalExcursionsLogged),
            spoiled: Number(data.protocolStat.totalSpoiledBatches)
          }
        };
      }
    } catch (err) {
      console.warn("[GraphQL Client] Protocol stats query failed, falling back to RPC:", err.message);
    }

    if (contractFallback) {
      const stats = await contractFallback();
      return {
        source: "rpc-fallback",
        stats: {
          totalBatches: Number(stats.totalBatches || 0),
          spoiled: Number(stats.spoiled || 0),
          recalled: Number(stats.recalled || 0),
          expired: Number(stats.expired || 0)
        }
      };
    }
    return null;
  }

  return {
    setEndpoint,
    getEndpoint,
    checkHealth,
    isOnline,
    fetchBatches,
    fetchBatchDetails,
    fetchProtocolStats
  };
});
