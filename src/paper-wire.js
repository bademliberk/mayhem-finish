import { VersionedTransaction } from '@solana/web3.js';

export const unsupported = code => Object.assign(new Error(code), { code });
export function decodeFrame(raw) {
  const bytes = Buffer.from(raw);
  if (bytes.length < 74 || bytes.length > 65536 || bytes[0] !== 1) throw unsupported('frame_layout');
  const slotBig = bytes.readBigUInt64LE(1);
  if (slotBig > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported('slot_overflow');
  let transaction;
  try { transaction = VersionedTransaction.deserialize(bytes.subarray(73)); }
  catch { throw unsupported('wire_version_or_layout'); }
  if (!transaction.signatures.length || transaction.signatures.length !== transaction.message.header.numRequiredSignatures ||
      transaction.signatures.some(signature => signature.every(byte => byte === 0)) ||
      !Buffer.from(transaction.signatures[0]).equals(bytes.subarray(9,73))) throw unsupported('signature_mismatch');
  if (transaction.version !== 'legacy' && transaction.version !== 0) throw unsupported('wire_version');
  const message = transaction.message;
  if (message.addressTableLookups?.length) throw unsupported('address_lookup_table');
  const keys = message.staticAccountKeys.map(key => key.toBase58());
  const instructions = message.compiledInstructions.map(ix => {
    if (!keys[ix.programIdIndex] || ix.accountKeyIndexes.some(index => !keys[index])) throw unsupported('account_index');
    return { program: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map(index => keys[index]), data: Buffer.from(ix.data) };
  });
  // Signatures need the full 64-byte base58 representation, not a 32-byte public key encoding.
  return { slot: Number(slotBig), signature: base58(bytes.subarray(9,73)), instructions };
}
function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt('0x' + bytes.toString('hex')), text = '';
  while (value) { text = alphabet[Number(value % 58n)] + text; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; text = '1' + text; }
  return text;
}
