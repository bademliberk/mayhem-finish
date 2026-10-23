import { getTransactionDecoder, getTransactionEncoder } from '@solana/transactions';
import { getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } from '@solana/transaction-messages';

export const unsupported = (code, details = {}) => Object.assign(new Error(code), { code, details });
export function decodeFrame(raw, resolveLookup) {
  const bytes = Buffer.from(raw);
  if (bytes.length < 74 || bytes.length > 65536 || bytes[0] !== 1) throw unsupported('frame_layout');
  const slotBig = bytes.readBigUInt64LE(1);
  if (slotBig > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported('slot_overflow');
  const slot = Number(slotBig), signature = base58(bytes.subarray(9,73));
  let transaction, message;
  try {
    transaction = getTransactionDecoder().decode(bytes.subarray(73));
    if (!Buffer.from(getTransactionEncoder().encode(transaction)).equals(bytes.subarray(73))) throw new Error('noncanonical_wire');
    message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (!Buffer.from(getCompiledTransactionMessageEncoder().encode(message)).equals(Buffer.from(transaction.messageBytes))) throw new Error('noncanonical_message');
  } catch { throw unsupported('wire_version_or_layout', { slot, signature }); }
  const signatures = Object.values(transaction.signatures);
  if (!signatures.length || signatures.length !== message.header.numSignerAccounts ||
      signatures.some(value => !value || value.every(byte => byte === 0)) ||
      !Buffer.from(transaction.signatures[message.staticAccounts[0]] ?? []).equals(bytes.subarray(9,73))) {
    throw unsupported('signature_mismatch', { slot, signature });
  }
  const keys = [...message.staticAccounts], writable = [], readonly = [];
  for (const lookup of message.addressTableLookups ?? []) {
    const addresses = resolveLookup?.(lookup.lookupTableAddress, slot, [...lookup.writableIndexes, ...lookup.readonlyIndexes]);
    if (!addresses) throw unsupported('address_lookup_table', { slot, signature, table: lookup.lookupTableAddress });
    for (const [indices, target] of [[lookup.writableIndexes,writable],[lookup.readonlyIndexes,readonly]]) {
      for (const index of indices) {
        if (!addresses[index]) throw unsupported('lookup_index', { slot, signature });
        target.push(addresses[index]);
      }
    }
  }
  keys.push(...writable, ...readonly);
  const compiled = message.version === 1 ? message.instructionHeaders.map((header, i) => ({
    programAddressIndex: header.programAccountIndex,
    accountIndices: message.instructionPayloads[i].instructionAccountIndices,
    data: message.instructionPayloads[i].instructionData,
  })) : message.instructions;
  const instructions = compiled.map(ix => {
    if (!keys[ix.programAddressIndex] || (ix.accountIndices ?? []).some(index => !keys[index])) throw unsupported('account_index', { slot, signature });
    return { program: keys[ix.programAddressIndex], accounts: (ix.accountIndices ?? []).map(index => keys[index]), data: Buffer.from(ix.data ?? []) };
  });
  return { slot, signature, version: message.version, instructions };
}
function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt('0x' + bytes.toString('hex')), text = '';
  while (value) { text = alphabet[Number(value % 58n)] + text; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; text = '1' + text; }
  return text;
}
