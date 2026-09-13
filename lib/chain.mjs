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
import { buildMintStatement } from './mint.mjs';

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

/** Find the ballot resource (SYMBOL = RVOTE) from the resource.create events. */
export function findBallotResource(res) {
  for (const e of events(res)) {
    if (e.topic === 'std.resource.create' && e.payload?.SYMBOL === 'RVOTE') {
      return e.substate_id;
    }
  }
  return null;
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