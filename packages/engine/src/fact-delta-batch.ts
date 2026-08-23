/**
 * The native batch contract is owned by Schema IR and published by
 * `@urdira/contracts`. Engine re-exports it for callers that already depend
 * on the indexing package; it does not maintain a second wire or value model.
 */
export {
  FACT_DELTA_BATCH_MAX_BYTES,
  FACT_DELTA_BATCH_MAX_ROWS,
  FACT_DELTA_BATCH_PROTOCOL_VERSION,
  FACT_DELTA_BATCH_SCHEMA_ID,
  buildFactDeltaBatch,
  factDeltaBatchTransferList,
  readFactDeltaString,
  readArenaString,
  validateFactDeltaBatch,
  type FactDeltaBatch,
  type FactDeltaBatchRow,
  type FactDeltaColumnBatch,
  type Utf8Arena,
} from "@urdira/contracts";
