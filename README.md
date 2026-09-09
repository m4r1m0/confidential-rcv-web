# Confidential Ranked-Choice Voting — Web Front End

A minimal web front end for the [confidential ranked-choice voting template](https://github.com/m4r1m0/confidential-rcv-template)
on Tari Ootle (Esmeralda testnet). Election setup, stealth-ballot minting, live
monitoring and trustless IRV/STV results — all in plain HTML/CSS/JS with a small
Node backend.

## What it does

- **Create an election** — pick the tally method (IRV, Sequential IRV or STV),
  set candidates/winners and a **voting deadline by calendar date/time (UTC)**,
  add voters by address (or bulk-import a CSV), and initiate on-chain. One
  stealth ballot token (amount-1) is minted per voter.
- **Show each voter their ballot** — the per-voter UTXO commitment + sender
  nonce needed to spend the token from their own wallet client.
- **Monitor & results** — live ballot count / voter count / deadline, end the
  vote (initiator) or finalize after expiry, and a round-by-round tally table
  computed on-chain (`result()`), with the raw JSON available.
- **Terminal log** — a collapsible monospace log of every API call and
  transaction, so the details are visible to anyone who wants them.

## Privacy model

The template obscures *who* cast each ballot: ballot tokens are stealth UTXOs
and are spent via one-time keys, so no on-chain observer can link a ballot to a
voter. Ballot *contents* (rankings) and the tally are public by design.

This front end is the **initiator's console** — it never holds or signs voter
ballots. Voters cast with their own wallet/client. The reference voter client
is the template repo's Rust integration client, and this repo ships a
JavaScript example (`scripts/cast-ballot.mjs`).

> Note on fees: the cast script pays the transaction fee from the voter's
> (revealed) account for simplicity. For full anonymity the fee must come from
> a stealth TARI UTXO — see the template README; the Rust integration client
> implements the canonical pattern.

## Architecture

```
public/            Vanilla front end (index.html, app.js, style.css) — no build
                   step, no frameworks, readable in one sitting.
lib/
  provider.mjs     Provider adapter over the indexer REST client.
  signer.mjs       Signer built on ootle-wasm primitives.
  derive.mjs       Account-address derivation (mirrors the engine's hasher).
  mint.mjs         Stealth mint-statement builder + CBOR wire encoder
                   (byte-for-byte verified against the template's codec).
  chain.mjs        On-chain operations (initiate, read state, end vote).
server.mjs         HTTP server: static files + small JSON API.
scripts/
  patch-packages.mjs  Fixes extensionless ESM imports in @tari-project npm
                      packages (postinstall).
  cast-ballot.mjs     Voter client example.
```

Everything is dependency-light: the `@tari-project` SDK packages (official),
`@noble/hashes` for blake2b, and Node's built-in HTTP server.

## Run it

```bash
npm install
cp config.example.env config.env   # fill in TEMPLATE_ADDRESS after publishing
npm start
```

The server generates a fresh initiator wallet on first start (writes
`config.env`) and prints the account. Fund it with the **Faucet** button in the
page header (creates the account and claims testnet funds in one transaction).

`EPOCH_DURATION_SECS` (default 1200) converts the calendar deadline to an epoch
number. Esmeralda epochs are ~20-30 minutes, so the conversion is approximate:
the vote closes at the first epoch boundary at or after the chosen time.

### Publishing the template

Publish the ranked-voting WASM through the wallet web UI, then set
`TEMPLATE_ADDRESS` in `config.env`:

```bash
# after publishing, e.g.:
TEMPLATE_ADDRESS=template_1234…abcd
```

### Elections data

Election records (component address, voters, ballot commitments/nonces) are
stored in `elections.json` (gitignored) by the server.

## Voter flow (example client)

```bash
node scripts/cast-ballot.mjs \
  --component component_… \
  --resource resource_… \
  --address otl_esm_… \
  --owner-key <32-byte hex> \
  --view-key <32-byte hex> \
  --commitment <ballot commitment hex> \
  --nonce <ballot sender nonce hex> \
  --ranking 0,2,1
```

The ballot data per voter is shown in the web UI right after initiation
(also downloadable as CSV). The cast spends the ballot UTXO via the voter's
one-time stealth key — the transaction cannot be linked to the voter.

## API

| Endpoint | Description |
|---|---|
| `GET /api/status` | Network, epoch, template, initiator account |
| `POST /api/setup` | Create initiator account + faucet (idempotent) |
| `POST /api/elections` | Create + initiate an election (`endUtc` ISO deadline or `expiresInEpochs`) |
| `GET /api/elections` | List elections |
| `GET /api/elections/:id` | Election record + live chain state |
| `POST /api/elections/:id/end` | End the vote (initiator) |
| `POST /api/elections/:id/end-expired` | Finalize after the deadline (anyone) |

## Security notes

- The initiator's private keys live only in `config.env` (gitignored).
- No voter keys ever pass through the server.
- The tally is computed on-chain by the template — this site only displays it.