# VaxPass Enterprise Data Indexer (The Graph & Envio)

This directory contains the indexing infrastructure for VaxPass, replacing $O(N)$ client-side RPC polling with high-performance GraphQL queries.

---

## Architecture Overview

```
                      ┌─────────────────────────────────┐
                      │  Ethereum L2 / Base Sepolia     │
                      │  VaxPassUpgradeable.sol Events   │
                      └──────────────┬──────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
                    ▼                                 ▼
      ┌───────────────────────────┐     ┌───────────────────────────┐
      │     The Graph Subgraph    │     │      Envio HyperIndex     │
      │  (subgraph.yaml / WASM)   │     │  (envio.config.yaml / TS) │
      └─────────────┬─────────────┘     └─────────────┬─────────────┘
                    │                                 │
                    └────────────────┬────────────────┘
                                     │
                                     ▼
                      ┌─────────────────────────────────┐
                      │    PostgreSQL / GraphQL Store   │
                      │   Entities: Batch, Hop, Log...  │
                      └──────────────┬──────────────────┘
                                     │
                                     ▼
                      ┌─────────────────────────────────┐
                      │   Frontend GraphQL Client       │
                      │  (graphql-client.js / Apollo)   │
                      └─────────────────────────────────┘
```

---

## Indexed Entities

1. **`Batch`**: Real-time batch state, excursion budgets, custodian assignments, and timestamps.
2. **`CustodyHop`**: Complete supply chain custody lineage across international transit hops (DAG model).
3. **`TemperatureLog`**: IoT temperature records authenticated via EIP-712 secure elements.
4. **`DoseReceipt`**: Salted ZK patient dose commitments ensuring HIPAA compliance.
5. **`ProtocolStat`**: Global statistics on total batches, spoilage rates, and doses administered.

---

## Local Development & Deployment

### 1. Generate AssemblyScript Types:
```bash
npm install
npm run codegen
```

### 2. Build Subgraph:
```bash
npm run build
```

### 3. Deploy to Local Graph Node:
```bash
npm run create-local
npm run deploy-local
```

### 4. Deploy to The Graph Studio / Goldsky:
```bash
graph auth --studio <DEPLOY_KEY>
graph deploy --studio vaxpass-enterprise
```
