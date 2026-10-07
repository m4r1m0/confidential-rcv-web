// Builds the stealth mint statement for a ranked-voting election: one amount-1
// stealth ballot UTXO per voter, with `voter_count` as the revealed input amount.
//
// The statement is assembled from the ootle-wasm primitives and serialized to the
// exact CBOR wire form the template's `new()` constructor decodes. The encoder is
// verified byte-for-byte against the Rust codec (tari_template_lib_types
// StealthTransferStatement minicbor implementation).
import {
  buildStealthInputsStatement,
  createStealthOutputWitness,
  generateStealthBalanceProofSignature,
  generateStealthOutputsStatement,
  parseOotleAddress,
} from '@tari-project/ootle-wasm';

const PLACEHOLDER_RESOURCE = 'resource_' + '0'.repeat(64);

// --- tiny CBOR encoder (arrays / maps / bytes / uints only) ---

function cborUint(n) {
  n = typeof n === 'bigint' ? n : BigInt(n);
  if (n < 24n) return Uint8Array.of(Number(n));
  if (n < 256n) return Uint8Array.of(0x18, Number(n));
  if (n < 65536n) return Uint8Array.of(0x19, Number((n >> 8n) & 255n), Number(n & 255n));
  if (n < 4294967296n) {
    return Uint8Array.of(
      0x1a,
      Number((n >> 24n) & 255n),
      Number((n >> 16n) & 255n),
      Number((n >> 8n) & 255n),
      Number(n & 255n),
    );
  }
  const b = new Uint8Array(9);
  b[0] = 0x1b;
  for (let i = 8; i >= 1; i--) {
    b[i] = Number(n & 255n);
    n >>= 8n;
  }
  return b;
}

function cborArray(n) {
  return Uint8Array.of(0x80 | n);
}

function cborBytes(u8) {
  if (u8.length < 24) return Uint8Array.of(0x40 | u8.length, ...u8);
  if (u8.length < 256) return Uint8Array.of(0x58, u8.length, ...u8);
  if (u8.length < 65536) {
    const b = new Uint8Array(3 + u8.length);
    b[0] = 0x59;
    b[1] = u8.length >> 8;
    b[2] = u8.length & 255;
    b.set(u8, 3);
    return b;
  }
  throw new Error('bytes too long');
}

function concat(...parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const hexToU8 = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const u8ToHex = (b) => Buffer.from(b).toString('hex');

function encodeAuth(auth) {
  if (auth.Key) {
    return concat(cborArray(2), cborUint(0), cborArray(1), cborBytes(hexToU8(auth.Key)));
  }
  if (auth.Script) {
    return concat(cborArray(2), cborUint(1), cborArray(1), cborBytes(hexToU8(auth.Script)));
  }
  throw new Error('unsupported auth shape: ' + JSON.stringify(auth));
}

/** Serialize a mint statement (wire JSON) to the CBOR hex used as the template arg. */
export function encodeMintStatement(stmt) {
  const inputsStmt = concat(
    cborArray(2),
    cborArray(stmt.inputs_statement.inputs.length),
    ...stmt.inputs_statement.inputs.map((i) => cborBytes(hexToU8(i.commitment))),
    cborUint(BigInt(stmt.inputs_statement.revealed_amount)),
  );
  const outputs = stmt.outputs_statement.outputs.map((o) => {
    const body = concat(
      cborArray(4),
      cborBytes(hexToU8(o.output.commitment)),
      cborBytes(hexToU8(o.output.sender_public_nonce)),
      cborBytes(hexToU8(o.output.encrypted_data)),
      cborUint(o.output.minimum_value_promise),
    );
    return concat(cborArray(3), body, encodeAuth(o.auth), cborUint(o.tag));
  });
  const outputsStmt = concat(
    cborArray(3),
    cborArray(outputs.length),
    ...outputs,
    cborUint(BigInt(stmt.outputs_statement.revealed_output_amount)),
    cborBytes(hexToU8(stmt.outputs_statement.agg_range_proof)),
  );
  const balance = stmt.balance_proof
    ? concat(
        cborArray(2),
        cborBytes(hexToU8(stmt.balance_proof.public_nonce)),
        cborBytes(hexToU8(stmt.balance_proof.signature)),
      )
    : Uint8Array.of(0xf6);
  const claims = cborArray(stmt.covenant_claims?.length ?? 0);
  return concat(cborArray(4), inputsStmt, outputsStmt, balance, claims);
}

/**
 * Build the mint statement for `voterAddresses` (otl_... addresses).
 * Returns { statement, encodedHex, ballots } where ballots[i] holds
 * { commitment, nonce, address } for each voter — the data voters need to
 * spend their ballot token from their own wallet.
 */
export function buildMintStatement(network, voterAddresses) {
  const witnesses = voterAddresses.map((addr) => {
    const p = parseOotleAddress(addr);
    return createStealthOutputWitness(
      network,
      new Uint8Array(p.owner_key),
      new Uint8Array(p.view_key),
      1n,
      PLACEHOLDER_RESOURCE,
      null,
      null,
      null,
      1n,
    );
  });
  const witnessJson = '[' + witnesses.join(',') + ']';
  const count = BigInt(voterAddresses.length);

  const inputsJson = buildStealthInputsStatement([], count);
  const outputsRes = generateStealthOutputsStatement(witnessJson, 0n);

  const inputsStatement = JSON.parse(inputsJson);
  const outputsStatement = JSON.parse(outputsRes.statement_json);
  const mask = outputsRes.aggregated_output_mask;
  const outMask = mask instanceof Uint8Array
    ? mask
    : Uint8Array.from(Object.values(mask));
  const balanceSig = generateStealthBalanceProofSignature(
    new Uint8Array(32),
    outMask,
    inputsJson,
    outputsRes.statement_json,
  );

  const statement = {
    inputs_statement: JSON.parse(inputsJson),
    outputs_statement: JSON.parse(outputsRes.statement_json),
    covenant_claims: [],
  };
  statement.balance_proof = {
    public_nonce: u8ToHex(new Uint8Array(balanceSig.public_nonce)),
    signature: u8ToHex(new Uint8Array(balanceSig.signature)),
  };

  const ballots = outputsStatement.outputs.map((o, i) => ({
    address: voterAddresses[i],
    commitment: o.output.commitment,
    nonce: o.output.sender_public_nonce,
  }));

  return {
    statement,
    encodedHex: u8ToHex(encodeMintStatement(statement)),
    ballots,
  };
}
// --- tiny CBOR decoder (bytes / arrays / maps / uints / tags / nulls) ---
// The inverse of the encoder above. Used to read the mint statement back out of
// a committed transaction's `new()` argument (see lib/chain.mjs
// `verifyElectionCreation`).

function cborDecode(buf) {
  let pos = 0;
  const read = (n) => {
    const b = buf.slice(pos, pos + n);
    pos += n;
    return b;
  };
  const head = () => {
    const ib = buf[pos++];
    const mt = ib >> 5;
    let ai = ib & 31;
    if (ai === 24) ai = buf[pos++];
    else if (ai === 25) {
      ai = (buf[pos] << 8) | buf[pos + 1];
      pos += 2;
    } else if (ai === 26) {
      ai = ((buf[pos] << 24) >>> 0) + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3];
      pos += 4;
    } else if (ai === 27) {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[pos + i]);
      pos += 8;
      return [mt, v];
    } else if (ai === 31) {
      throw new Error('indefinite-length CBOR not supported');
    }
    return [mt, ai];
  };
  const item = () => {
    const [mt, ai] = head();
    if (mt === 0) return ai;
    if (mt === 1) return -1 - ai;
    if (mt === 2) return read(ai);
    if (mt === 3) return Buffer.from(read(ai)).toString();
    if (mt === 4) {
      const a = [];
      for (let i = 0; i < ai; i++) a.push(item());
      return a;
    }
    if (mt === 5) {
      const m = {};
      for (let i = 0; i < ai; i++) {
        const k = item();
        m[String(k)] = item();
      }
      return m;
    }
    if (mt === 6) return { tag: ai, value: item() };
    if (mt === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22 || ai === 23) return null;
      throw new Error('unsupported simple value ' + ai);
    }
    throw new Error('unsupported major type ' + mt);
  };
  return item();
}

/**
 * Decode a mint-statement CBOR hex (as embedded in the `new()` transaction argument)
 * back into its ballots: one `{ commitment, nonce }` per output, in order, plus the
 * revealed input/output amounts. Structure mirrors `encodeMintStatement` above.
 */
export function decodeMintStatement(hex) {
  const v = cborDecode(Uint8Array.from(Buffer.from(hex, 'hex')));
  if (!Array.isArray(v) || v.length < 4) {
    throw new Error('mint statement: expected a 4-element array');
  }
  const [inputsStmt, outputsStmt] = v;
  const inputs = (inputsStmt?.[0] ?? []).map((b) => {
    if (!(b instanceof Uint8Array)) throw new Error('mint statement: input is not bytes');
    return u8ToHex(b);
  });
  const outputs = (outputsStmt?.[0] ?? []).map((out) => {
    const body = out?.[0];
    if (!Array.isArray(body) || body.length < 2) {
      throw new Error('mint statement: output body malformed');
    }
    if (!(body[0] instanceof Uint8Array) || !(body[1] instanceof Uint8Array)) {
      throw new Error('mint statement: output commitment/nonce are not bytes');
    }
    return { commitment: u8ToHex(body[0]), nonce: u8ToHex(body[1]) };
  });
  return {
    inputs,
    revealedInputAmount: inputsStmt?.[1] ?? 0,
    outputs,
    revealedOutputAmount: outputsStmt?.[1] ?? 0,
  };
}
