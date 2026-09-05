#!/usr/bin/env node
// Voter client example: cast a ranked ballot from your own wallet.
//
// Each voter received a ballot token at election creation (see the ballot table
// in the web UI). This script spends that token privately: the ballot UTXO is
// spent via the one-time stealth key derived from your private key, so the
// transaction cannot be linked to you by any on-chain observer.
//
// Usage:
//   node scripts/cast-ballot.mjs \
//     --component component_... \
//     --resource resource_... \
//     --address otl_esm_... \
//     --owner-key <32-byte hex> \
//     --view-key <32-byte hex> \
//     --commitment <ballot commitment hex> \
//     --nonce <ballot sender nonce hex> \
//     --ranking 0,2,1
//
// Optional: --indexer <url> (default: esmeralda public indexer), --fee <max fee in µTARI>
//
// NOTE on fees: for full anonymity the fee must also be paid from a stealth
// TARI UTXO (see the template README). This example pays the fee from the
// voter's TARI account for simplicity; the canonical fully-anonymous pattern
// is implemented in the template repo's Rust integration client.
import {
  Mask,
  Network,
  OotleWallet,
  StealthInput,
  componentAddressLiteral,
  StealthInputsStatement,
  StealthOutputsStatement,
  StealthTransferStatement,
  TransactionBuilder,
  WalletStealthAuthorizer,
  XTR_FAUCET_COMPONENT_ADDRESS,
  defaultIndexerUrl,
  fromHexStr,
  getVaultIdsForAccount,
  intLiteral,
  resolveMaxEpoch,
  submitTransaction,
  watchTransaction,
} from '@tari-project/ootle';
import { IndexerProvider } from '../lib/provider.mjs';
import { SecretKeySigner } from '../lib/signer.mjs';
import { accountAddressFromPublicKey } from '../lib/derive.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const NETWORK = Network.Esmeralda;
const COMPONENT = arg('component');
const RESOURCE = arg('resource');
const ADDRESS = arg('address');
const OWNER_KEY = arg('owner-key');
const VIEW_KEY = arg('view-key');
const COMMITMENT = arg('commitment');
const NONCE = arg('nonce');
const RANKING = (arg('ranking') || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n));
const FEE = BigInt(arg('fee') || '500000');
const INDEXER = arg('indexer') || defaultIndexerUrl(NETWORK);

function need(name, v) {
  if (!v) {
    console.error(`missing required --${name}`);
    process.exit(2);
  }
  return v;
}
need('component', COMPONENT);
need('resource', RESOURCE);
need('address', ADDRESS);
need('owner-key', OWNER_KEY);
need('view-key', VIEW_KEY);
need('commitment', COMMITMENT);
need('nonce', NONCE);
if (!RANKING.length) {
  console.error('--ranking must be a comma-separated list of candidate ids (first = top choice)');
  process.exit(2);
}

const provider = new IndexerProvider(INDEXER, NETWORK);
const signer = new SecretKeySigner(
  Buffer.from(OWNER_KEY, 'hex'),
  Buffer.from(VIEW_KEY, 'hex'),
  NETWORK,
);
const wallet = new OotleWallet()
  .registerKeyProvider(signer.address, signer)
  .setDefaultSigner(signer.address);
const account = accountAddressFromPublicKey(signer.ownerPublicKey);

const log = (m) => console.log(`[voter] ${m}`);

async function faucetIfNeeded() {
  log(`account ${account}`);
  const accountExists = await accountSubstateExists();
  if (accountExists && (await accountHasTari())) {
    log('already funded — skipping faucet');
    return;
  }
  const maxEpoch = await resolveMaxEpoch(provider);
  const b = new TransactionBuilder(NETWORK, maxEpoch);
  b.withFeeInstructionsBuilder((fb) => {
    if (accountExists) {
      fb.callMethod(
        {
          methodName: 'take',
          componentAddress: XTR_FAUCET_COMPONENT_ADDRESS,
        },
        [componentAddressLiteral(account)],
      );
      fb.callMethod({ methodName: 'pay_fee', componentAddress: account }, [intLiteral(1_000_000n)]);
    } else {
      fb.createAccount(Buffer.from(signer.ownerPublicKey).toString('hex'));
      fb.saveVar('acct');
      fb.callMethod(
        {
          methodName: 'take',
          componentAddress: XTR_FAUCET_COMPONENT_ADDRESS,
        },
        [{ Workspace: 'acct' }],
      );
      fb.callMethod({ methodName: 'pay_fee', fromWorkspace: 'acct' }, [intLiteral(1_000_000n)]);
    }
    return fb;
  });
  b.addInput({ substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null });
  b.addInput({ substate_id: 'vault_0102030000000000000000000000000000000000000000000000000000000001', version: null });
  b.addInput({ substate_id: 'resource_0102030000000000000000000000000000000000000000000000000000000002', version: null });
  if (accountExists) {
    b.addInput({ substate_id: account, version: null });
    for (const v of await getVaultIdsForAccount(provider, account)) b.addInput({ substate_id: v, version: null });
  }
  const unsigned = b.buildUnsignedTransaction();
  const { signTransaction, sealTransaction, sendTransaction } = await import('@tari-project/ootle');
  const signed = await signTransaction([signer], unsigned);
  const envelope = sealTransaction(signed);
  const txId = await submitTransaction(provider, envelope);
  log(`faucet tx ${txId} …`);
  await watchTransaction(provider, txId, { timeoutMs: 120_000 });
  log('funded');
}

async function accountSubstateExists() {
  try {
    await provider.getSubstate(account);
    return true;
  } catch {
    return false;
  }
}

async function accountHasTari() {
  try {
    const vaults = await getVaultIdsForAccount(provider, account);
    for (const v of vaults) {
      const res = await provider.getSubstate(v);
      const container = res?.substate?.Vault?.resource_container;
      const stealth = container?.Stealth ?? container?.Fungible;
      if (!stealth) continue;
      const address = stealth.address ?? stealth.resource_address;
      if (address === 'resource_0101010101010101010101010101010101010101010101010101010101010101') {
        return BigInt(stealth.revealed_amount ?? 0) > 0n;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function cast() {
  await faucetIfNeeded();

  log(`spending ballot ${COMMITMENT.slice(0, 16)}… ranking=${RANKING.join(' > ')}`);

  // The SDK's StealthTransfer builder requires at least one stealth output, but a
  // ballot spend is revealed-only (the token goes straight to cast_ballot as a
  // bucket). Build the statement and spec manually instead — same shapes the
  // engine accepts (verified against the template's integration client).
  const commitment = fromHexStr(COMMITMENT);
  const inputsJson = JSON.stringify({
    inputs: [{ commitment: COMMITMENT, witness: 'KeyPath' }],
    revealed_amount: '0',
  });
  const outputsJson = JSON.stringify({
    outputs: [],
    revealed_output_amount: '1',
    agg_range_proof: '',
  });
  const inputsStatement = new StealthInputsStatement([], 0n, inputsJson);
  const outputsStatement = new StealthOutputsStatement(outputsJson);
  const statement = new StealthTransferStatement(inputsStatement, outputsStatement);

  const maxEpoch = await resolveMaxEpoch(provider);
  const b = new TransactionBuilder(NETWORK, maxEpoch);
  b.addInstruction({
    StealthTransfer: {
      resource_address_ref: { Address: RESOURCE },
      statement: { __ootleRawJson: statement.toCompactJson() },
      revealed_input_bucket: null,
    },
  });
  b.saveVar('vote');
  b.callMethod(
    { methodName: 'cast_ballot', componentAddress: COMPONENT },
    [{ Workspace: 'vote' }, { Literal: rankingCborHex(RANKING) }],
  );
  b.addFeeInstruction({
    CallMethod: {
      call: { Address: account },
      method: 'pay_fee',
      args: [intLiteral(FEE)],
    },
  });
  b.addInput({ substate_id: `utxo_${RESOURCE.replace('resource_', '')}_${COMMITMENT}`, version: null });
  b.addInput({ substate_id: RESOURCE, version: null });
  b.addInput({ substate_id: COMPONENT, version: null });
  b.addInput({ substate_id: account, version: null });
  for (const v of await getVaultIdsForAccount(provider, COMPONENT)) {
    b.addInput({ substate_id: v, version: null });
  }
  for (const v of await getVaultIdsForAccount(provider, account)) {
    b.addInput({ substate_id: v, version: null });
  }

  const spec = {
    unsignedTx: b.buildUnsignedTransaction(),
    statement,
    outputMask: Mask.zero(),
    state: {
      resource: RESOURCE,
      revealedInput: null,
      inputsToSpend: new Map([[COMMITMENT, { input: new StealthInput(commitment), owner: ADDRESS }]]),
      outputs: [],
      revealedOutputAmount: 1n,
    },
    requiredSigners: [ADDRESS],
    inputs: [{ input: new StealthInput(commitment), owner: ADDRESS }],
  };

  const authorizer = WalletStealthAuthorizer.fromSpec(wallet, spec, {
    viewSecret: signer.viewKey,
    mustSignWithAccountKey: true,
  });
  const authorized = await authorizer.prepare(provider);
  const envelope = await authorized.seal();

  const txId = await submitTransaction(provider, envelope);
  log(`cast tx ${txId} …`);
  const res = await watchTransaction(provider, txId, { timeoutMs: 180_000 });
  const fin = res?.result?.Finalized;
  if (!fin || fin.final_decision !== 'Commit') {
    console.error('ballot NOT accepted:', JSON.stringify(res?.result));
    process.exit(1);
  }
  log('ballot accepted ✓');
  for (const e of fin.execution_result?.finalize?.events ?? []) {
    log(`event: ${e.topic} ${JSON.stringify(e.payload)}`);
  }
}

// CBOR encoding of Vec<u32>: array(n) + each uint
function rankingCborHex(ranking) {
  const parts = [String.fromCharCode(0x80 | ranking.length)];
  for (const r of ranking) parts.push(String.fromCharCode(r));
  return Buffer.from(parts.join(''), 'latin1').toString('hex');
}

cast().catch((e) => {
  console.error('[voter] failed:', e.message || e);
  process.exit(1);
});
