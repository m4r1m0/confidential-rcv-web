// Voter-only page: cast a ballot via window.tari. Deliberately asks for as little as possible —
// the election component/resource and the voter's own ballot commitment are all looked up
// automatically from the election record and the connected wallet address, never typed in.
const $ = (id) => document.getElementById(id);

const XTR_RESOURCE = 'resource_0101010101010101010101010101010101010101010101010101010101010101';
const FEE_SHIELD_AMOUNT = '500000';
const FEE_MAX_FEE = '100000';
const FEE_COMMITMENT_KEY = 'rcv-voter-fee-commitment';
// Every ballot the template mints is worth exactly 1 unit ("one amount-1 stealth ballot UTXO per
// voter" — see the mint statement in lib/mint.mjs), so this is a fixed constant, not user input.
const BALLOT_REVEALED_AMOUNT = '1';

let election = null;
let voterAccount = null;
let ballotCommitment = null;

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function voterError(msg) {
  const el = $('v-error');
  el.textContent = msg;
  el.hidden = !msg;
}

function rankingCborHex(ranking) {
  const bytes = [0x80 | ranking.length, ...ranking];
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- rank candidate list ----------
// Renders one <li> per candidate, in the election's own declared order (index = candidate id,
// what cast_ballot's ranking refers to). The voter reorders the <li> elements via the up/down
// buttons only -- current top-to-bottom DOM order at cast time *is* the ranking, read straight
// off data-id. (Drag-to-reorder was tried and dropped: HTML5 native drag-and-drop broke inside
// Tari Universe's dApp iframe -- dragstart fired but dragend/drop never did, leaving an item stuck
// mid-drag -- and a Pointer Events replacement was judged not worth the extra interaction surface
// over the buttons alone.)
function renderRankList(candidates) {
  const list = $('v-rank-list');
  list.innerHTML = '';
  candidates.forEach((name, id) => {
    const li = document.createElement('li');
    li.dataset.id = String(id);
    li.innerHTML = `
      <span class="rank-pos"></span>
      <span class="rank-name"></span>
      <span class="rank-moves">
        <button type="button" class="ghost" data-dir="-1" title="Move up">▲</button>
        <button type="button" class="ghost" data-dir="1" title="Move down">▼</button>
      </span>`;
    li.querySelector('.rank-name').textContent = name;
    list.appendChild(li);
  });
  renumberRankList();

  list.querySelectorAll('.rank-moves button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const li = btn.closest('li');
      const dir = Number(btn.dataset.dir);
      const sibling = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
      if (!sibling) return;
      if (dir < 0) list.insertBefore(li, sibling);
      else list.insertBefore(sibling, li);
      renumberRankList();
    });
  });
}

function renumberRankList() {
  $('v-rank-list')
    .querySelectorAll('li')
    .forEach((li, i) => {
      li.querySelector('.rank-pos').textContent = String(i + 1);
    });
}

function currentRanking() {
  return Array.from($('v-rank-list').querySelectorAll('li')).map((li) => Number(li.dataset.id));
}

// The create -> poll -> submit helper lives in wallet.js (shared with the initiator console).

// ---------- load the election ----------
async function loadElection(id) {
  try {
    const e = await api(`/api/elections/${id}`);
    election = e;
    $('v-not-found').hidden = true;
    $('v-title').textContent = e.title;
    renderRankList(e.candidates);
    const closed = e.status === 'ended' || (e.epoch != null && e.expiresAtEpoch != null && e.epoch > e.expiresAtEpoch);
    if (closed) {
      $('v-scan-row').hidden = true;
      $('v-ballot-fields').hidden = true;
      $('v-not-eligible').hidden = false;
      $('v-not-eligible').textContent = 'This election is closed — no more ballots can be cast.';
      return;
    }
    $('v-not-eligible').textContent = 'No ballot for this election\'s ballot resource was found in your wallet.';
    if (voterAccount) await scanForBallot();
  } catch {
    $('v-not-found').hidden = false;
  }
}

async function populatePicker() {
  const list = await api('/api/elections');
  const sel = $('election-select');
  list.forEach((e) => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.title;
    sel.appendChild(opt);
  });
  $('election-picker').hidden = false;
}

$('election-select').addEventListener('change', () => {
  const id = $('election-select').value;
  if (id) loadElection(id);
});

// ---------- wallet + eligibility ----------
// Eligibility is decided *entirely* on-chain: whether this wallet can decrypt a ballot UTXO of
// this election's own ballot resource. Deliberately never consults this site's own voter-list
// bookkeeping (election.voters) -- that list only exists to drive the mint at election creation,
// and a server-held record of who's allowed to vote is exactly the kind of thing a private ballot
// scheme shouldn't depend on to answer "can I vote."

// Prompts once (a no-op thereafter) for the private-view grant this account's confidential reads
// need -- shared by the ballot scan below and the fee-shield check.
async function ensureViewAccess() {
  let view = await window.tari.request({ method: 'tari_getViewAccess' });
  if (!view.granted) view = await window.tari.request({ method: 'tari_requestViewAccess' });
  if (!view.granted) throw new Error('Private view access is required.');
}

async function scanForBallot() {
  voterError('');
  if (!voterAccount) {
    voterError('Connect your wallet first.');
    return false;
  }
  if (!election?.ballotResource) {
    voterError('Election not loaded yet.');
    return false;
  }
  $('btn-vote-scan').disabled = true;
  $('v-not-eligible').hidden = true;
  $('v-scan-status').textContent = 'checking view access…';
  try {
    await ensureViewAccess();

    // Cheap path first: if the wallet already holds/knows about a ballot for this resource (e.g.
    // a previous scan on this page already found and recorded it), that alone is enough to vote --
    // no need to pay for another chain walk just to re-confirm something already established.
    $('v-scan-status').textContent = 'checking your wallet…';
    const known = await window.tari.request({ method: 'tari_getShieldedOutputs', params: { resourceAddress: election.ballotResource } });
    let match = known?.[0];

    if (!match) {
      $('v-scan-status').textContent = "checking the election's creation transaction for your ballot…";
      // Every ballot for this election was minted in exactly one transaction -- the election's own
      // creation (see lib/mint.mjs). Checking that transaction id directly turns this into a single
      // lookup instead of a blind walk over recent chain history, which is both far faster and
      // avoids retrying every unrelated transaction the indexer happens to have served up recently.
      const { found } = await window.tari.request({
        method: 'tari_scanForResourceUtxos',
        params: {
          resourceAddress: election.ballotResource,
          transactionIds: election.txId ? [election.txId] : [],
          maxPages: 20,
          pageSize: 50,
          limit: 1,
        },
      });
      match = found?.[0];
    }

    if (!match) {
      $('v-scan-status').textContent = '';
      $('v-not-eligible').hidden = false;
      $('v-ballot-fields').hidden = true;
      return false;
    }
    ballotCommitment = match.commitment;
    // The wallet may still hold a record of a ballot that was already spent (a previous
    // visit). Ask the chain whether the output is still live before offering the cast.
    try {
      const res = await window.tari.request({
        method: 'tari_getSubstate',
        params: { substateId: `utxo_${election.ballotResource.replace('resource_', '')}_${ballotCommitment}`, version: null },
      });
      const utxo = res?.substate?.Utxo;
      if (!utxo || !utxo.output) throw new Error('spent');
    } catch {
      $('v-scan-status').textContent = '';
      $('v-ballot-fields').hidden = true;
      $('v-not-eligible').hidden = false;
      $('v-not-eligible').textContent = 'This ballot has already been spent — you appear to have voted already.';
      return false;
    }
    $('v-scan-status').textContent = 'ballot found ✓';
    $('v-ballot-fields').hidden = false;
    $('btn-vote-cast').disabled = false;
    await checkExistingFeeShield();
    return true;
  } catch (e) {
    $('v-scan-status').textContent = '';
    voterError(e?.message || String(e));
    return false;
  } finally {
    $('btn-vote-scan').disabled = false;
  }
}

$('btn-vote-scan').addEventListener('click', scanForBallot);

$('btn-vote-connect').addEventListener('click', async () => {
  voterError('');
  if (!window.tari) {
    voterError('No Tari wallet found — install Sapient or open this page from inside Tari Universe.');
    return;
  }
  try {
    // tari_requestAccounts resolves to the account's *component* address -- a different, unrelated
    // string from the otl_... wallet address a ballot is actually minted to. Only the wallet
    // address is meaningful here (it's what the on-chain scan below decrypts against).
    await window.tari.request({ method: 'tari_requestAccounts' });
    const walletAddress = await window.tari.request({ method: 'tari_getWalletAddress' });
    voterAccount = walletAddress;
    $('v-account').textContent = `connected: ${walletAddress.slice(0, 14)}…${walletAddress.slice(-8)}`;
    $('v-scan-row').hidden = false;
    if (election) await scanForBallot();
  } catch (e) {
    voterError(e?.message || String(e));
  }
});

// ---------- fee (always private) ----------
try {
  const saved = localStorage.getItem(FEE_COMMITMENT_KEY);
  if (saved) $('v-fee-commitment').value = saved;
} catch {
  /* private browsing or storage disabled -- the field just starts empty */
}

// If the wallet already holds shielded XTR, there's no reason to make the voter shield more --
// pick the largest existing stealth UTXO (best chance of covering the fee) and use it. Best-effort:
// a denial or failure here just leaves whatever was already in the field (localStorage, or blank),
// and the voter can still shield manually.
//
// The wallet's own record of "unspent" can be stale (e.g. a previous cast attempt that spent this
// exact output but got interrupted before the wallet's local bookkeeping caught up, or the output
// was already used from another session/tab) -- confirmed live 2026-09-21 as the cause of a cast
// failing with "Input substate ... is down" using a fee commitment this same check had just handed
// back as good. The ballot-liveness check above (tari_getSubstate before offering to cast) already
// guards against exactly this for the ballot itself; this is the same guard for the fee input,
// walking candidates largest-first until one is confirmed still live on-chain.
async function checkExistingFeeShield() {
  try {
    await ensureViewAccess();
    const outputs = await window.tari.request({ method: 'tari_getShieldedOutputs', params: { resourceAddress: XTR_RESOURCE } });
    if (!outputs || outputs.length === 0) return;
    const candidates = [...outputs].sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
    for (const candidate of candidates) {
      try {
        const res = await window.tari.request({
          method: 'tari_getSubstate',
          params: { substateId: `utxo_${XTR_RESOURCE.replace('resource_', '')}_${candidate.commitment}`, version: null },
        });
        if (!res?.substate?.Utxo?.output) continue; // stale record -- already spent, try the next
        $('v-fee-commitment').value = candidate.commitment;
        try {
          localStorage.setItem(FEE_COMMITMENT_KEY, candidate.commitment);
        } catch {
          /* best-effort only */
        }
        $('v-fee-status').textContent = 'using your existing shielded XTR ✓';
        return;
      } catch {
        continue; // not found / already spent -- try the next candidate
      }
    }
    // Every known output was already spent on-chain -- leave the field as-is (localStorage or
    // blank) rather than pre-filling a doomed one; the voter shields fresh below.
  } catch {
    /* no existing shielded XTR, or the voter hasn't granted view access -- shield manually below */
  }
}

$('btn-vote-shield-fee').addEventListener('click', async () => {
  voterError('');
  if (!voterAccount) {
    voterError('Connect your wallet first.');
    return;
  }
  $('btn-vote-shield-fee').disabled = true;
  $('v-fee-status').textContent = 'shielding XTR for fees — waiting on wallet approval…';
  try {
    const result = await window.RcvWallet.submitTransactionRequest({ kind: 'shield', resourceAddress: XTR_RESOURCE, amount: FEE_SHIELD_AMOUNT });
    $('v-fee-commitment').value = result.commitment;
    try {
      localStorage.setItem(FEE_COMMITMENT_KEY, result.commitment);
    } catch {
      /* best-effort only */
    }
    $('v-fee-status').textContent = 'shielded ✓ — ready to cover several ballot fees';
  } catch (e) {
    $('v-fee-status').textContent = '';
    voterError(e?.message || String(e));
  } finally {
    $('btn-vote-shield-fee').disabled = false;
  }
});

// ---------- cast ----------
$('btn-vote-cast').addEventListener('click', async () => {
  voterError('');
  $('v-result').hidden = true;
  if (!election || !voterAccount || !ballotCommitment) {
    voterError('Connect an eligible wallet first.');
    return;
  }
  const ranking = currentRanking();
  const feeCommitmentHex = $('v-fee-commitment').value.trim().replace(/^0x/, '');
  if (!feeCommitmentHex) {
    voterError('This needs a stealth XTR UTXO to pay the fee from — click "Shield XTR for fees".');
    return;
  }

  const followUpInstructions = [
    {
      CallMethod: {
        call: { Address: election.componentAddress },
        method: 'cast_ballot',
        args: [{ Workspace: { id: 0, offset: null } }, { Literal: rankingCborHex(ranking) }],
      },
    },
  ];

  $('btn-vote-cast').disabled = true;
  $('v-progress').hidden = false;
  $('v-progress').textContent = 'waiting for wallet approval…';
  try {
    const caps = await window.tari.request({ method: 'tari_getCapabilities' });
    // Always paid privately -- see the fee field's own hint: any other way links this transaction
    // (including your ranking) to your wallet address on-chain.
    if (!caps.stealthRedeemPrivateFee) throw new Error('This wallet cannot pay fees privately yet — update it.');
    const result = await window.RcvWallet.submitTransactionRequest({
      kind: 'redeemStealthOutputWithPrivateFee',
      resourceAddress: election.ballotResource,
      commitmentHex: ballotCommitment,
      revealedAmount: BALLOT_REVEALED_AMOUNT,
      followUpInstructions,
      feeResourceAddress: XTR_RESOURCE,
      feeCommitmentHex,
      maxFee: FEE_MAX_FEE,
      relatedComponents: [election.componentAddress],
    });
    if (result?.feeChangeCommitment) {
      $('v-fee-commitment').value = result.feeChangeCommitment;
      try {
        localStorage.setItem(FEE_COMMITMENT_KEY, result.feeChangeCommitment);
      } catch {
        /* best-effort only */
      }
    }
    $('v-txid').textContent = result?.transactionId ?? '(no transaction id returned)';
    $('v-result').hidden = false;
    $('v-ballot-fields').hidden = true;
  } catch (e) {
    const msg = e?.message || String(e);
    // "Input substate ... is down" is the indexer's wording for "already spent" -- if this exact
    // fee commitment is the culprit, leaving it in the field (and in localStorage) just makes the
    // next click fail the same way. Clear it and say plainly what to do instead of surfacing the
    // raw indexer error.
    if (/is down/i.test(msg) && msg.includes(feeCommitmentHex)) {
      $('v-fee-commitment').value = '';
      try {
        localStorage.removeItem(FEE_COMMITMENT_KEY);
      } catch {
        /* best-effort only */
      }
      voterError('That shielded XTR was already spent (from an earlier attempt or elsewhere) — click "Shield XTR for fees" to get a fresh one, then cast again.');
    } else {
      voterError(msg);
    }
  } finally {
    $('btn-vote-cast').disabled = false;
    $('v-progress').hidden = true;
  }
});

// ---------- init ----------
const params = new URLSearchParams(location.search);
const electionId = params.get('election');
if (electionId) {
  loadElection(electionId);
} else {
  populatePicker().catch((e) => {
    voterError(e?.message || String(e));
  });
}
