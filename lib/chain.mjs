// On-chain operations: account setup/faucet, election initiation, read-only
// state queries (dry-run), and ending elections.
import {
  Network,
  OotleWallet,
  TransactionBuilder,
  XTR_FAUCET_COMPONENT_ADDRESS,
  defaultIndexerUrl,
  getVaultIdsForAccount,
  intLiteral,
  resolveMaxEpoch,
  sealTransaction,
  sendTransaction,
  signTransaction,
} from '@tari-project/ootle';

import { IndexerProvider } from './provider.mjs';
import { SecretKeySigner } from './signer.mjs';
import { accountAddressFromPublicKey } from './derive.mjs';
import { buildMintStatement, decodeMintStatement } from './mint.mjs';

export function networkFromString(name) {
  const n = name?.toLowerCase() ?? 'esmeralda';
  if (n === 'esmeralda') return Network.Esmeralda;
  if (n === 'localnet') return Network.LocalNet;
  if (n === 'mainnet') return Network.MainNet;
  throw new Error(`unsupported network: ${n}`);
}

export function makeContext(cfg) {
  const network = networkFromString(cfg.NETWORK);
  const url = cfg.OOTLE_INDEXER_URL || defaultIndexerUrl(network);
  const provider = new IndexerProvider(url, network);
  const signer = new SecretKeySigner(
    Buffer.from(cfg.OWNER_KEY_HEX, 'hex'),
    Buffer.from(cfg.VIEW_KEY_HEX, 'hex'),
    network,
  );
  const wallet = new OotleWallet()
    .registerKeyProvider(signer.address, signer)
    .setDefaultSigner(signer.address);
  return {
    network,
    provider,
    signer,
    wallet,
    account: accountAddressFromPublicKey(signer.ownerPublicKey),
  };
}

/** Create the initiator's account (if missing) and grab faucet funds in one tx. */
export async function setupAccount(ctx) {
  const maxEpoch = await resolveMaxEpoch(ctx.provider);
  const b = new TransactionBuilder(ctx.network, maxEpoch);
  b.withFeeInstructionsBuilder((fb) => {
    fb.createAccount(Buffer.from(ctx.signer.ownerPublicKey).toString('hex'));
    fb.saveVar('acct');
    fb.callMethod(
      {
        methodName: 'take',
        componentAddress: XTR_FAUCET_COMPONENT_ADDRESS,
      },
      [{ Workspace: 'acct' }],
    );
    fb.callMethod({ methodName: 'pay_fee', fromWorkspace: 'acct' }, [intLiteral(1_000_000n)]);
    return fb;
  });
  b.addInput({ substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null });
  b.addInput({ substate_id: 'vault_0102030000000000000000000000000000000000000000000000000000000001', version: null });
  b.addInput({ substate_id: 'resource_0102030000000000000000000000000000000000000000000000000000000002', version: null });
  const unsigned = b.buildUnsignedTransaction();
  const res = await sendTransaction(ctx.provider, [ctx.signer], unsigned, {
    timeoutMs: 120_000,
  });
  return res;
}

function finalizedResult(res) {
  const r = res?.result;
  if (r === 'Pending') return null;
  if (typeof r === 'object' && 'Finalized' in r) return r.Finalized;
  if (typeof r === 'object' && 'Rejected' in r) {
    throw new Error('transaction rejected: ' + JSON.stringify(r.Rejected));
  }
  return null;
}

function finalizeOf(res) {
  // dry-run responses: { result: { finalize: {...} } }
  if (res?.result?.finalize) return res.result.finalize;
  // submitted tx responses: { result: { Finalized: { execution_result: { finalize } } } }
  const fin = finalizedResult(res);
  return fin?.execution_result?.finalize ?? null;
}

/** Submit a dry-run via the indexer's dedicated endpoint and return the finalize result. */
async function dryRunTx(ctx, unsigned) {
  unsigned.dry_run = true;
  const signed = await signTransaction([ctx.signer], unsigned);
  const envelope = sealTransaction(signed);
  const resp = await ctx.provider.client
    .getTransport()
    .sendPost('/transactions/dry-run', { transaction: envelope });
  return finalizeOf(resp);
}

function upSubstates(res) {
  const accept = finalizeOf(res)?.result?.Accept;
  return accept?.up_substates ?? [];
}

function events(res) {
  return finalizeOf(res)?.events ?? [];
}

/** Find the new component address in a committed receipt. */
export function findComponentAddress(res) {
  for (const [id] of upSubstates(res)) {
    if (typeof id === 'string' && id.startsWith('component_')) return id;
  }
  return null;
}

/**
 * Find the ballot resource (SYMBOL = RVOTE) among the transaction's newly-created substates.
 *
 * Reads `up_substates` (the actual created Resource substate's own `metadata.SYMBOL`), not the
 * `std.resource.create` event's payload -- confirmed live (2026-09-21) that a wallet-submitted
 * transaction's finalize.events carry `std.resource.create` with an *empty* payload (`{}`) even
 * though the resource is genuinely created correctly with the right SYMBOL in its own substate
 * metadata (verified independently on the block explorer). The server's own signed path
 * (initiateElection, below) happened to have both populated, which is why this only ever showed
 * up for wallet-submitted creations. Reading the substate directly is authoritative either way --
 * the event payload was always a shortcut, never the actual source of truth.
 */
export function findBallotResource(res) {
  for (const [id, entry] of upSubstates(res)) {
    if (typeof id === 'string' && id.startsWith('resource_') && entry?.substate?.Resource?.metadata?.SYMBOL === 'RVOTE') {
      return id;
    }
  }
  // Fallback to the event payload, in case some receipt shape only has it there.
  for (const e of events(res)) {
    if (e.topic === 'std.resource.create' && e.payload?.SYMBOL === 'RVOTE') {
      return e.substate_id;
    }
  }
  return null;
}

/**
 * Builds the *unsigned* main instructions for creating + initiating an election, without signing
 * or submitting anything. Building the mint statement needs no secret key at all: the statement's
 * balance proof is a real signature, but over a revealed-input-only transfer (no stealth inputs,
 * so the aggregated input mask is genuinely zero) and is generated inside the wallet-free
 * ootle-wasm primitives -- see lib/mint.mjs. So this can safely run against ANY future signer,
 * not just this server's own account: the browser is meant to hand these straight to
 * `window.tari`'s `{ kind: "instructions" }` and let the *connected wallet* (Sapient, Tari
 * Universe, whichever) sign and pay the fee from its own account -- the wallet's own `execute()`
 * already knows how to register inputs and retry on newly-discovered substates, so this
 * deliberately returns bare instructions and a `maxFee`, no pre-resolved inputs of its own to get
 * out of sync with.
 *
 * Note: the returned `ballots` (commitment + nonce per voter, in address order) are processed by
 * this server transiently while building the statement, but the election record never persists
 * the address<->ballot mapping (see /api/elections/finalize).
 */
export async function prepareInitiateElection(ctx, cfg, params) {
  const { voterAddresses, numCandidates, numWinners, tallyMethod, expiresAtEpoch } = params;
  const voterCount = voterAddresses.length;

  const mint = buildMintStatement(ctx.network, voterAddresses);
  const methodLiteral =
    tallyMethod === 'stv' ? '820180' : tallyMethod === 'fptp' ? '820280' : '820080';

  const maxEpoch = await resolveMaxEpoch(ctx.provider);
  const b = new TransactionBuilder(ctx.network, maxEpoch);
  b.allocateAddress('Resource', 'ballot_res');
  b.callFunction(
    { templateAddress: cfg.TEMPLATE_ADDRESS, functionName: 'new' },
    [
      { Workspace: 'ballot_res' },
      intLiteral(BigInt(voterCount)),
      intLiteral(BigInt(numCandidates)),
      intLiteral(BigInt(numWinners)),
      { Literal: methodLiteral },
      intLiteral(BigInt(expiresAtEpoch)),
      { Literal: mint.encodedHex },
    ],
  );
  const unsigned = b.buildUnsignedTransaction();

  return { instructions: unsigned.instructions, ballots: mint.ballots };
}

/**
 * The other half of `prepareInitiateElection`: given the `transactionId` the connected wallet
 * returned after signing and submitting those instructions, reads the committed receipt back from
 * the indexer (this server's own read-only provider -- no signer involved) and extracts the new
 * component/resource addresses the same way `initiateElection` always has.
 */
export async function finalizeInitiateElection(ctx, transactionId) {
  const { watchTransaction } = await import('@tari-project/ootle');
  const res = await watchTransaction(ctx.provider, transactionId, { timeoutMs: 180_000 });
  const component = findComponentAddress(res);
  const ballotResource = findBallotResource(res);
  if (!component || !ballotResource) {
    // Seen repeatedly in production (since 2026-09-19) for wallet-submitted creations
    // specifically -- the same event-matching logic works for the server's own signed path
    // (initiateElection, below). Dumping the full receipt here (once, only on this failure) is
    // meant to catch the next real occurrence with enough detail to actually root-cause it,
    // rather than continuing to guess -- delete this once that's done.
    console.error(
      `[rcv] finalizeInitiateElection: missing ${!component ? 'component' : 'ballot resource'} for tx ${transactionId}. Full receipt:`,
      JSON.stringify(res, null, 2),
    );
  }
  if (!component) throw new Error('no component address in receipt');
  if (!ballotResource) throw new Error('no ballot resource in receipt events');
  return {
    componentAddress: component,
    ballotResource,
    txId: res?.transaction_id ?? transactionId,
    events: events(res).map((e) => ({ topic: e.topic, payload: e.payload })),
  };
}

/**
 * Verifies that a committed `transactionId` really is this template's `new()` call for `draft`,
 * with a mint statement whose outputs exactly match the `ballots` the client claims. Reads the
 * transaction body back from the indexer (read-only, no signer) and decodes the mint statement
 * out of the `new()` argument -- the only authoritative source, since mint outputs are randomized
 * per build and can never be re-derived by re-running the builder. Throws on any mismatch.
 */
export async function verifyElectionCreation(ctx, cfg, transactionId, draft, ballots) {
  const tx = await ctx.provider.client.getTransaction(transactionId);
  const instructions =
    tx?.transaction?.transaction?.V1?.body?.transaction?.instructions ?? [];
  const call = instructions.find(
    (i) =>
      i?.CallFunction?.function === 'new' &&
      i.CallFunction.address === String(cfg.TEMPLATE_ADDRESS).replace('template_', ''),
  );
  if (!call) {
    throw new Error(`transaction ${transactionId} does not call new() on the configured template`);
  }
  const args = call.CallFunction.args ?? [];
  if (args.length !== 7) {
    throw new Error(`new() call has ${args.length} args, expected 7`);
  }
  const arg = (i) => args[i]?.Literal;
  if (!arg(1) || !arg(2) || !arg(3) || !arg(4) || !arg(5) || !arg(6)) {
    throw new Error('new() call arguments are not literals');
  }
  const num = (hex) => decodeCborUint(hex);
  const voterCount = num(arg(1));
  const numCandidates = num(arg(2));
  const numWinners = num(arg(3));
  const expiresAtEpoch = num(arg(5));
  if (voterCount !== draft.voterAddresses.length) {
    throw new Error('new() voter_count does not match the draft');
  }
  if (numCandidates !== draft.numCandidates || numWinners !== draft.numWinners) {
    throw new Error('new() candidate/winner counts do not match the draft');
  }
  if (expiresAtEpoch !== draft.expiresAtEpoch) {
    throw new Error('new() expires_at_epoch does not match the draft');
  }
  const method = decodeCborEnumVariant(arg(4));
  const methodOk =
    (method === 0 && ['irv', 'sequential-irv'].includes(draft.tallyMethod)) ||
    (method === 1 && draft.tallyMethod === 'stv') ||
    (method === 2 && draft.tallyMethod === 'fptp');
  if (!methodOk) {
    throw new Error('new() tally method does not match the draft');
  }
  const decoded = decodeMintStatement(arg(6));
  if (decoded.outputs.length !== ballots.length || decoded.outputs.length !== voterCount) {
    throw new Error('mint statement output count does not match the supplied ballots');
  }
  decoded.outputs.forEach((out, i) => {
    if (out.commitment !== ballots[i]?.commitment || out.nonce !== ballots[i]?.nonce) {
      throw new Error(`mint statement output ${i} does not match the supplied ballot`);
    }
  });
  return true;
}

// CBOR helpers for the verify path (plain uints and `[variant, payload]` enums).
function decodeCborUint(hex) {
  const buf = Uint8Array.from(Buffer.from(hex, 'hex'));
  const ib = buf[0];
  const mt = ib >> 5;
  if (mt !== 0) throw new Error('expected a CBOR uint');
  let ai = ib & 31;
  if (ai < 24) return ai;
  if (ai === 24) return buf[1];
  if (ai === 25) return (buf[1] << 8) | buf[2];
  if (ai === 26) return ((buf[1] << 24) >>> 0) + (buf[2] << 16) + (buf[3] << 8) + buf[4];
  throw new Error('uint too large');
}

function decodeCborEnumVariant(hex) {
  const buf = Uint8Array.from(Buffer.from(hex, 'hex'));
  if (buf[0] !== 0x82) throw new Error('expected a 2-element CBOR array');
  const ib = buf[1];
  if ((ib >> 5) !== 0) throw new Error('expected a CBOR uint variant');
  return ib & 31;
}

export async function initiateElection(ctx, cfg, params) {
  const { voterAddresses, numCandidates, numWinners, tallyMethod, expiresAtEpoch } = params;
  const voterCount = voterAddresses.length;

  const mint = buildMintStatement(ctx.network, voterAddresses);
  const methodLiteral =
    tallyMethod === 'stv' ? '820180' : tallyMethod === 'fptp' ? '820280' : '820080';

  const maxEpoch = await resolveMaxEpoch(ctx.provider);
  const b = new TransactionBuilder(ctx.network, maxEpoch);
  b.allocateAddress('Resource', 'ballot_res');
  b.callFunction(
    {
      templateAddress: cfg.TEMPLATE_ADDRESS,
      functionName: 'new',
    },
    [
      { Workspace: 'ballot_res' },
      intLiteral(BigInt(voterCount)),
      intLiteral(BigInt(numCandidates)),
      intLiteral(BigInt(numWinners)),
      { Literal: methodLiteral },
      intLiteral(BigInt(expiresAtEpoch)),
      { Literal: mint.encodedHex },
    ],
  );
  b.feeTransactionPayFromComponent(ctx.account, 1_000_000n);
  b.addInput({ substate_id: ctx.account, version: null });
  const vaults = await getVaultIdsForAccount(ctx.provider, ctx.account);
  for (const v of vaults) b.addInput({ substate_id: v, version: null });
  const unsigned = b.buildUnsignedTransaction();

  const res = await sendTransaction(ctx.provider, [ctx.signer], unsigned, {
    timeoutMs: 180_000,
  });
  const component = findComponentAddress(res);
  const ballotResource = findBallotResource(res);
  if (!component) throw new Error('no component address in receipt');
  if (!ballotResource) throw new Error('no ballot resource in receipt events');

  return {
    componentAddress: component,
    ballotResource,
    ballots: mint.ballots,
    txId: res?.transaction_id ?? null,
    events: events(res).map((e) => ({ topic: e.topic, payload: e.payload })),
  };
}

function instructionValues(res) {
  const results = finalizeOf(res)?.execution_results ?? [];
  return results.map((r) => r?.indexed?.value);
}

/** Dry-run a read-only template method and return its decoded return value. */
export async function readMethod(ctx, component, method, args = []) {
  const maxEpoch = await resolveMaxEpoch(ctx.provider);
  const b = new TransactionBuilder(ctx.network, maxEpoch);
  b.callMethod({ methodName: method, componentAddress: component }, args);
  b.feeTransactionPayFromComponent(ctx.account, 100_000n);
  b.addInput({ substate_id: component, version: null });
  b.addInput({ substate_id: ctx.account, version: null });
  const vaults = await getVaultIdsForAccount(ctx.provider, ctx.account);
  for (const v of vaults) b.addInput({ substate_id: v, version: null });
  const unsigned = b.buildUnsignedTransaction();
  const fin = await dryRunTx(ctx, unsigned);
  if (fin?.result && typeof fin.result === 'object' && 'Reject' in fin.result) {
    throw new Error('dry-run rejected: ' + JSON.stringify(fin.result.Reject));
  }
  const values = (fin?.execution_results ?? []).map((r) => r?.indexed?.value);
  return values.length ? values[values.length - 1] : undefined;
}

export async function readElectionState(ctx, component) {
  const [voterCount, ballotCount, vaultBalance, result] = await Promise.all([
    readMethod(ctx, component, 'voter_count'),
    readMethod(ctx, component, 'ballot_count'),
    readMethod(ctx, component, 'ballot_vault_balance'),
    readMethod(ctx, component, 'result'),
  ]);
  return { voterCount, ballotCount, vaultBalance, result };
}

/** End the vote: method = 'end_vote' (initiator) or 'end_vote_expired' (after deadline). */
export async function endVote(ctx, component, method) {
  const maxEpoch = await resolveMaxEpoch(ctx.provider);
  const b = new TransactionBuilder(ctx.network, maxEpoch);
  b.callMethod({ methodName: method, componentAddress: component }, []);
  b.feeTransactionPayFromComponent(ctx.account, 200_000n);
  b.addInput({ substate_id: component, version: null });
  b.addInput({ substate_id: ctx.account, version: null });
  const vaults = await getVaultIdsForAccount(ctx.provider, ctx.account);
  for (const v of vaults) b.addInput({ substate_id: v, version: null });
  const unsigned = b.buildUnsignedTransaction();
  const res = await sendTransaction(ctx.provider, [ctx.signer], unsigned, {
    timeoutMs: 180_000,
  });
  return {
    result: instructionValues(res).find((v) => v !== undefined),
    events: events(res).map((e) => ({ topic: e.topic, payload: e.payload })),
  };
}

export async function currentEpoch(ctx) {
  return ctx.provider.getCurrentEpoch();
}