// Fixed-size order evidence only: never raw RPC errors, messages, URLs or payloads.
const stages = new Set(['requested', 'status_pending', 'status_unconfirmed', 'status_confirmed', 'status_failed',
  'status_invalid', 'account_pending', 'snapshot_behind', 'snapshot_changed', 'entry_rejected', 'ready_to_fill', 'filled', 'canceled', 'unavailable']);
const integers = ['signalSlot', 'currentSlot', 'executedSlot', 'snapshotSlot', 'requiredSlot', 'peakSlot', 'windowStartSlot',
  'createdAtMs', 'updatedAtMs', 'elapsedMs', 'statusElapsedMs', 'accountElapsedMs', 'statusAttempts', 'accountAttempts',
  'eventIndex', 'triggerRevision', 'triggerToRequestSlots', 'triggerToFillSlots'];
const transactionKinds = new Set(['AccountInUse', 'AccountLoadedTwice', 'AccountNotFound', 'ProgramAccountNotFound',
  'InsufficientFundsForFee', 'InvalidAccountForFee', 'AlreadyProcessed', 'BlockhashNotFound', 'CallChainTooDeep',
  'MissingSignatureForFee', 'InvalidAccountIndex', 'SignatureFailure', 'InvalidProgramForExecution', 'SanitizeFailure',
  'ClusterMaintenance', 'AccountBorrowOutstanding', 'UnsupportedVersion', 'InvalidWritableAccount',
  'WouldExceedMaxBlockCostLimit', 'WouldExceedMaxAccountCostLimit', 'WouldExceedAccountDataBlockLimit',
  'TooManyAccountLocks', 'AddressLookupTableNotFound', 'InvalidAddressLookupTableOwner', 'InvalidAddressLookupTableData',
  'InvalidAddressLookupTableIndex', 'InvalidRentPayingAccount', 'WouldExceedMaxVoteCostLimit',
  'WouldExceedAccountDataTotalLimit', 'MaxLoadedAccountsDataSizeExceeded', 'InvalidLoadedAccountsDataSizeLimit',
  'ResanitizationNeeded', 'ProgramExecutionTemporarilyRestricted', 'UnbalancedTransaction', 'ProgramCacheHitMaxLimit',
  'CommitCancelled', 'InstructionError', 'Unknown']);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

export function transactionFailure(error) {
  if (error === null) return null;
  if (typeof error === 'string') return { kind: transactionKinds.has(error) ? error : 'Unknown' };
  const instruction = error?.InstructionError;
  if (Array.isArray(instruction) && instruction.length === 2 && nonnegative(instruction[0]) && instruction[0] <= 65535) {
    const result = { kind: 'InstructionError', instructionIndex: instruction[0] };
    const code = instruction[1]?.Custom;
    if (nonnegative(code) && code <= 4294967295) result.customCode = code;
    return result;
  }
  return { kind: 'Unknown' };
}

export function safeOrderDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const key of ['stage', 'lastStage']) if (stages.has(value[key])) result[key] = value[key];
  if (['slot', 'clock'].includes(value.expiryCause)) result.expiryCause = value.expiryCause;
  if (['buy', 'sell'].includes(value.triggerSide)) result.triggerSide = value.triggerSide;
  if (['processed', 'confirmed', 'finalized', 'unknown'].includes(value.confirmationStatus)) result.confirmationStatus = value.confirmationStatus;
  for (const key of integers) if (nonnegative(value[key])) result[key] = value[key];
  for (const key of ['requestedBudgetLamports', 'referenceRealSolLamports', 'currentRealSolLamports', 'exposureLamports']) {
    if (typeof value[key] === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(value[key])) result[key] = value[key];
  }
  for (const key of ['marketCapSol', 'floorCapSol', 'ceilingCapSol']) {
    if (Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1e15) result[key] = value[key];
  }
  if (Number.isSafeInteger(value.dropBps) && Math.abs(value.dropBps) <= 1e12) result.dropBps = value.dropBps;
  if (nonnegative(value.requiredDropBps) && value.requiredDropBps <= 10000) result.requiredDropBps = value.requiredDropBps;
  for (const key of ['rangePassed', 'dropPassed']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (value.failure && typeof value.failure === 'object') {
    const failure = value.failure;
    result.failure = { kind: transactionKinds.has(failure.kind) ? failure.kind : 'Unknown' };
    if (result.failure.kind === 'InstructionError') {
      if (nonnegative(failure.instructionIndex) && failure.instructionIndex <= 65535) result.failure.instructionIndex = failure.instructionIndex;
      if (nonnegative(failure.customCode) && failure.customCode <= 4294967295) result.failure.customCode = failure.customCode;
    }
  }
  return result;
}

export function readOrderDiagnostics(raw) {
  if (typeof raw !== 'string') return null;
  try { return safeOrderDiagnostics(JSON.parse(raw)); } catch { return null; }
}
