// Account address derivation, mirroring the engine's
// `derive_component_address_from_public_key` (see tari-engine hashing.rs).
//
// The hash is: blake2b256(domain_sep_tag || template_address || borsh(public_key))
// where borsh(RistrettoPublicKeyBytes) is a u32-LE length prefix followed by the
// 32 key bytes, and the template address is the all-zero account template.
import { blake2b } from '@noble/hashes/blake2.js';

const ENGINE_DOMAIN = 'com.tari.ootle.engine';
const ENGINE_DOMAIN_VERSION = 0;
const ACCOUNT_TEMPLATE_ADDRESS = new Uint8Array(32);
const LABEL = 'ComponentAddress';

function byteToDecimalAsciiBytes(byte) {
  const ZERO = 48;
  const bytes = [0, 0, ZERO];
  let pos = 3;
  if (byte === 0) return [2, bytes];
  let b = byte;
  while (b > 0) {
    const rem = b % 10;
    b = Math.floor(b / 10);
    bytes[pos - 1] = ZERO + rem;
    pos -= 1;
  }
  return [pos, bytes];
}

function domainSeparationTag(label) {
  const [versionOffset, versionBytes] = byteToDecimalAsciiBytes(ENGINE_DOMAIN_VERSION);
  const versionSlice = versionBytes.slice(versionOffset);
  const len =
    ENGINE_DOMAIN.length + (3 - versionOffset) + label.length + 3;
  const tag = Buffer.alloc(8);
  tag.writeBigUInt64LE(BigInt(len));
  return Buffer.concat([
    tag,
    Buffer.from(ENGINE_DOMAIN),
    Buffer.from('.v'),
    Buffer.from(versionSlice),
    Buffer.from('.'),
    Buffer.from(label),
  ]);
}

/** Derive the on-chain account component address for an owner public key. */
export function accountAddressFromPublicKey(ownerPublicKey, label = LABEL) {
  const pk = Buffer.from(ownerPublicKey);
  if (pk.length !== 32) throw new Error('public key must be 32 bytes');
  const pkLen = Buffer.alloc(4);
  pkLen.writeUInt32LE(32);
  const hash = blake2b(
    Buffer.concat([domainSeparationTag(label), ACCOUNT_TEMPLATE_ADDRESS, pkLen, pk]),
    { dkLen: 32 },
  );
  return 'component_' + Buffer.from(hash).toString('hex');
}