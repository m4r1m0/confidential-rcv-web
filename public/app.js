// Confidential RCV front end — vanilla JS, no frameworks.
// Talks only to the same-origin backend API.

const $ = (id) => document.getElementById(id);
const state = {
  currentElection: null,
  status: null,
  pollTimer: null,
  candidates: [],
  voters: [],
};

// ---------- terminal log ----------
const logEl = $('log');
const badgeEl = $('log-badge');
let logCount = 0;

function log(msg, cls = '') {
  const t = new Date().toISOString().slice(11, 23);
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">[${t}]</span> ${msg}`;
  if (cls) line.classList.add(cls);
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  logCount += 1;
  badgeEl.textContent = logCount;
}

$('btn-log-clear').addEventListener('click', () => {
  logEl.innerHTML = '';
  logCount = 0;
  badgeEl.textContent = '0';
});
$('btn-log-copy').addEventListener('click', () => {
  navigator.clipboard?.writeText(logEl.innerText);
});

async function api(path, opts = {}) {
  log(`<span class="ok">→</span> ${opts.method || 'GET'} ${path}`);
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    log(`<span class="err">✗ ${res.status}</span> ${JSON.stringify(data)}`, 'err');
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  log(`<span class="ok">✓</span> ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// ---------- status ----------
async function refreshStatus() {
  try {
    const s = await api('/api/status');
    state.status = s;
    $('pill-network').textContent = `network: ${s.network}`;
    $('pill-network').classList.add('ok');
    $('pill-epoch').textContent = `epoch: ${s.epoch}`;
    $('pill-epoch').classList.add('ok');
    $('pill-template').textContent = s.templateAddress
      ? `template: ${s.templateAddress.slice(0, 12)}…`
      : 'template: NOT SET';
    $('pill-template').classList.toggle('ok', !!s.templateAddress);
    $('pill-template').title = s.templateAddress || '';
    $('btn-faucet').hidden = false;
    updateDeadlinePreview();
  } catch (e) {
    log(`status failed: ${e.message}`, 'err');
  }
}

// ---------- voting deadline (UTC) ----------
function utcNowIso() {
  return new Date().toISOString();
}

function toUtcIso(datetimeLocalValue) {
  if (!datetimeLocalValue) return null;
  const t = new Date(datetimeLocalValue + ':00Z');
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function setDefaultDeadline() {
  const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  $('in-end-utc').value = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  updateDeadlinePreview();
}

function updateDeadlinePreview() {
  const el = $('end-preview');
  const s = state.status;
  const iso = toUtcIso($('in-end-utc').value);
  if (!iso || !s) {
    el.textContent = 'choose a date and time (UTC)';
    return;
  }
  const target = Date.parse(iso);
  const durationSecs = s.epochDurationSecs || 1200;
  const diffEpochs = Math.max(0, Math.ceil((target - Date.now()) / 1000 / durationSecs));
  const diffDays = ((target - Date.now()) / (24 * 3600 * 1000)).toFixed(1);
  if (target <= Date.now()) {
    el.textContent = 'that time is in the past — pick a future deadline';
    return;
  }
  const epoch = s.epoch + diffEpochs;
  const dateStr = new Date(target).toUTCString().replace('GMT', 'UTC');
  el.textContent = `closes at epoch ${epoch} — ${dateStr} (~${diffDays} days from now)`;
}

$('in-end-utc').addEventListener('input', updateDeadlinePreview);

$('btn-faucet').addEventListener('click', async () => {
  $('btn-faucet').disabled = true;
  try {
    const r = await api('/api/setup', { method: 'POST', body: {} });
    log(`faucet tx: <code>${r.txId}</code> — account ${r.account}`);
  } catch (e) {
    log(`faucet failed: ${e.message}`, 'err');
  } finally {
    $('btn-faucet').disabled = false;
  }
});

// ---------- step 1: candidates ----------
function renderCandidates() {
  const ul = $('candidate-list');
  ul.innerHTML = '';
  state.candidates.forEach((name, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="idx">${i}</span><span class="name"></span>`;
    li.querySelector('.name').textContent = name;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'remove';
    del.addEventListener('click', () => {
      state.candidates.splice(i, 1);
      renderCandidates();
    });
    li.appendChild(del);
    ul.appendChild(li);
  });
}

$('btn-add-candidate').addEventListener('click', () => {
  const name = $('in-candidate').value.trim();
  if (!name) return;
  state.candidates.push(name);
  $('in-candidate').value = '';
  renderCandidates();
});
$('in-candidate').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('btn-add-candidate').click();
  }
});

function updateMethodHint() {
  const m = $('in-method').value;
  if (m === 'fptp') {
    $('in-winners').value = 1;
    $('in-winners').disabled = true;
    $('hint-winners').textContent =
      'FPTP is single-winner — exactly one winner; only each ballot’s first preference counts, no majority required.';
  } else {
    $('in-winners').disabled = false;
    $('hint-winners').textContent = m === 'irv'
      ? 'With one winner the tally is single-winner IRV regardless of method.'
      : 'Sequential IRV fills seats by repeating IRV; STV uses proportional transfer with the Droop quota.';
  }
}

$('in-method').addEventListener('change', updateMethodHint);

// ---------- step 2: voters ----------
function parseVoterText(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function renderVoterCount() {
  const n = state.voters.length;
  $('voter-count').textContent = `${n} voter${n === 1 ? '' : 's'}`;
}

$('in-voters').addEventListener('input', () => {
  state.voters = parseVoterText($('in-voters').value);
  renderVoterCount();
});

// CSV import
const csvDialog = $('csv-dialog');

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { cols.push(cur); cur = ''; }
      else cur += c;
    }
    cols.push(cur);
    rows.push(cols.map((c) => c.trim()));
  }
  return rows;
}

$('btn-csv').addEventListener('click', () => {
  $('csv-text').value = '';
  $('csv-status').textContent = '';
  csvDialog.showModal();
});

$('csv-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('csv-text').value = await file.text();
});

$('csv-apply').addEventListener('click', () => {
  const rows = parseCsv($('csv-text').value);
  const start = rows[0] && !/^otl_esm_/.test(rows[0][0]) ? 1 : 0;
  const addresses = rows.slice(start).map((r) => r[0]).filter(Boolean);
  const seen = new Set(state.voters);
  const added = addresses.filter((a) => !seen.has(a));
  state.voters = state.voters.concat(added);
  $('in-voters').value = state.voters.join('\n');
  renderVoterCount();
  $('csv-status').textContent = `added ${added.length} voter(s) from ${rows.length - start} row(s)`;
  log(`CSV: added ${added.length} voters`);
});

// ---------- step 3: initiate ----------
function renderSummary() {
  const t = $('init-summary');
  t.innerHTML = '';
  const rows = [
    ['Title', state.status?.network || '…'],
    ['Voting method', $('in-method').selectedOptions[0].textContent],
    ['Winners', $('in-winners').value],
    ['Candidates', state.candidates.length ? state.candidates.map((c, i) => `#${i} ${c}`).join('<br>') : '—'],
    ['Voters', `${state.voters.length} address(es)`],
    ['Voting deadline (UTC)', deadlineSummary()],
  ];
  rows[0][1] = $('in-title').value || '(untitled)';
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${k}</td><td>${v}</td>`;
    t.appendChild(tr);
  }
}

function deadlineSummary() {
  const iso = toUtcIso($('in-end-utc').value);
  if (!iso) return '—';
  const s = state.status;
  const target = Date.parse(iso);
  const durationSecs = s?.epochDurationSecs || 1200;
  const diffEpochs = Math.max(1, Math.ceil((target - Date.now()) / 1000 / durationSecs));
  const dateStr = new Date(target).toUTCString().replace('GMT', 'UTC');
  return `${dateStr} → epoch ${(s?.epoch ?? 0) + diffEpochs}`;
}

function validateSetup() {
  if (state.candidates.length < 2) throw new Error('add at least 2 candidates');
  const winners = Number($('in-winners').value);
  if (winners < 1 || winners > state.candidates.length) {
    throw new Error('winners must be between 1 and the number of candidates');
  }
  if ($('in-method').value === 'fptp' && winners !== 1) {
    throw new Error('FPTP is single-winner (numWinners must be 1)');
  }
  if (state.voters.length < 1) throw new Error('add at least one voter address');
  for (const v of state.voters) {
    if (!/^otl_esm_/.test(v)) throw new Error(`invalid voter address: ${v.slice(0, 20)}…`);
  }
  const endUtc = toUtcIso($('in-end-utc').value);
  if (!endUtc) throw new Error('choose a voting deadline (UTC)');
  if (Date.parse(endUtc) <= Date.now()) throw new Error('voting deadline must be in the future');
  return { winners, endUtc };
}

$('btn-initiate').addEventListener('click', async () => {
  let opts;
  try {
    opts = validateSetup();
  } catch (e) {
    log(`validate: ${e.message}`, 'err');
    alert(e.message);
    return;
  }
  $('btn-initiate').disabled = true;
  $('init-progress').hidden = false;
  $('init-progress').textContent = 'submitting — minting stealth ballots, creating component…';
  try {
    const body = {
      title: $('in-title').value.trim(),
      tallyMethod: $('in-method').value,
      numWinners: opts.winners,
      numCandidates: state.candidates.length,
      candidates: state.candidates,
      voters: state.voters,
      endUtc: opts.endUtc,
    };
    const e = await api('/api/elections', { method: 'POST', body });
    log(`election created: <code>${e.componentAddress}</code>`);
    state.currentElection = e;
    $('init-result').hidden = false;
    $('res-component').textContent = e.componentAddress;
    $('res-resource').textContent = e.ballotResource;
    $('res-txid').textContent = e.txId || '—';
    renderBallotTable(e);
    loadElectionOptions();
    openStep('step-monitor');
    await loadElection(e.id);
  } catch (err) {
    $('init-progress').textContent = '';
    $('init-progress').hidden = true;
    $('init-progress').textContent = `failed: ${err.message}`;
    log(`initiate failed: ${err.message}`, 'err');
  } finally {
    $('btn-initiate').disabled = false;
  }
});

function renderBallotTable(e) {
  const t = $('ballot-table');
  t.innerHTML = '<tr><th>#</th><th>Voter address</th><th>Ballot commitment</th><th>Sender nonce</th></tr>';
  e.voters.forEach((v, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i}</td>
      <td><code>${v.address}</code></td>
      <td><code>${v.commitment}</code> <button class="copy" data-copy="${v.commitment}" title="copy">⧉</button></td>
      <td><code>${v.nonce}</code> <button class="copy" data-copy="${v.nonce}" title="copy">⧉</button></td>`;
    t.appendChild(tr);
  });
  t.querySelectorAll('.copy').forEach((b) =>
    b.addEventListener('click', () => navigator.clipboard?.writeText(b.dataset.copy)),
  );
}

$('btn-ballots-csv').addEventListener('click', () => {
  const e = state.currentElection;
  if (!e) return;
  const lines = ['index,address,ballot_commitment,sender_nonce'];
  e.voters.forEach((v, i) => {
    lines.push(`${i},${v.address},${v.commitment},${v.nonce}`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ballots.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- step 4: monitor ----------
async function loadElectionOptions() {
  const list = await api('/api/elections');
  const sel = $('election-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">— none —</option>';
  for (const e of list) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = `${e.title} (${e.voters.length} voters)`;
    sel.appendChild(opt);
  }
  if (current && list.some((e) => e.id === current)) sel.value = current;
}

$('btn-refresh-list').addEventListener('click', loadElectionOptions);

$('election-select').addEventListener('change', async () => {
  const id = $('election-select').value;
  if (!id) {
    state.currentElection = null;
    $('monitor').hidden = true;
    $('monitor-empty').hidden = false;
    return;
  }
  await loadElection(id);
});

async function loadElection(id) {
  try {
    const e = await api(`/api/elections/${id}`);
    state.currentElection = e;
    $('monitor').hidden = false;
    $('monitor-empty').hidden = true;
    renderMonitor(e);
    if ($('in-autopoll').checked) startPolling(e.id);
  } catch (err) {
    log(`load election failed: ${err.message}`, 'err');
  }
}

function renderMonitor(e) {
  const st = e.state || {};
  const status = e.status === 'ended' ? 'ended' : st.error ? 'error' : 'open';
  $('m-status').textContent = status;
  $('m-status').style.color = status === 'ended' ? 'var(--accent)' : status === 'error' ? 'var(--err)' : 'var(--fg)';
  $('m-epoch').textContent = e.epoch;
  $('m-deadline').textContent = e.expiresAtUtc
    ? new Date(e.expiresAtUtc).toUTCString().replace('GMT', 'UTC')
    : String(e.expiresAtEpoch);
  $('m-cast').textContent = st.ballotCount ?? '—';
  $('m-voters').textContent = st.voterCount ?? '—';
  $('m-vault').textContent = st.vaultBalance ?? '—';
  $('m-error').hidden = !st.error;
  if (st.error) $('m-error').textContent = 'state error: ' + st.error;

  const expired = e.epoch > e.expiresAtEpoch;
  $('btn-end').hidden = e.status === 'ended' || !expired;
  $('btn-end-expired').hidden = e.status === 'ended' || !expired;
  $('btn-end').disabled = e.status === 'ended';

  if (st.result) renderResult(st.result, e.resultSchema);
  else if (e.endResult) renderResult(e.endResult, e.resultSchema);
}

// The indexer decodes template return values into minicbor-shaped JS values:
// enums as [variant, payload], indexed structs as arrays, optionals as the bare
// value (or absent), and indexed maps as {"@cbor":"map","entries":[[k,v],...]}.
// Normalize all of that into a plain shape for rendering.
function normCounts(counts) {
  if (!counts) return {};
  const out = {};
  if (counts['@cbor'] === 'map' && Array.isArray(counts.entries)) {
    for (const [k, v] of counts.entries) out[String(k)] = Number(v ?? 0);
  } else if (typeof counts === 'object') {
    for (const [k, v] of Object.entries(counts)) out[k] = Number(v ?? 0);
  }
  return out;
}

function normOpt(v) {
  if (Array.isArray(v)) return v.length ? v[0] : null;
  return v ?? null;
}

function normRound(round) {
  if (!Array.isArray(round)) return null;
  return { counts: normCounts(round[0]), eliminated: round[1] == null ? null : Number(round[1]) };
}

function normalizeResult(result, schema = 'v2') {
  if (!result) return null;
  if (typeof result === 'object' && !Array.isArray(result)) {
    // { Irv: {...} }-style shape (not currently produced by the indexer, kept for robustness)
    const kind = Object.keys(result)[0];
    return { kind, raw: result[kind], winner: result[kind]?.winner ?? null,
             rounds: result[kind]?.rounds ?? [], winners: result[kind]?.winners ?? [],
             seats: result[kind]?.seats ?? [] };
  }
  if (!Array.isArray(result)) return null;
  const variant = result[0];
  let payload = result[1];
  if (Array.isArray(payload) && payload.length === 1 && Array.isArray(payload[0])) {
    payload = payload[0];
  }
  // Variant indices depend on the template the component was created with:
  //   legacy (pre-FPTP): Irv=0, SequentialIrv=1, Stv=2
  //   v2 (FPTP):         Irv=0, Fptp=1, SequentialIrv=2, Stv=3
  if (variant === 0) {
    return {
      kind: 'Irv',
      winner: normOpt(payload?.[0]),
      rounds: (payload?.[1] ?? []).map(normRound).filter(Boolean),
    };
  }
  if (schema === 'legacy') {
    if (variant === 1) {
      return {
        kind: 'SequentialIrv',
        winners: (payload?.[0] ?? []).map(Number),
        seats: (payload?.[1] ?? []).map((seat) => ({
          winner: normOpt(seat?.[0]),
          irv_rounds: (seat?.[1] ?? []).map(normRound).filter(Boolean),
        })),
      };
    }
    if (variant === 2) {
      return {
        kind: 'Stv',
        winners: (payload?.[0] ?? []).map(Number),
        rounds: (payload?.[1] ?? []).map((round) => ({
          counts: normCounts(round?.[0]),
          elected: (round?.[1] ?? []).map(Number),
          eliminated: round?.[2] == null ? null : Number(round[2]),
          quota: round?.[3] == null ? null : Number(round[3]),
        })),
      };
    }
    return null;
  }
  if (variant === 1) {
    return {
      kind: 'Fptp',
      winner: normOpt(payload?.[0]),
      counts: normCounts(payload?.[1]),
    };
  }
  if (variant === 2) {
    return {
      kind: 'SequentialIrv',
      winners: (payload?.[0] ?? []).map(Number),
      seats: (payload?.[1] ?? []).map((seat) => ({
        winner: normOpt(seat?.[0]),
        irv_rounds: (seat?.[1] ?? []).map(normRound).filter(Boolean),
      })),
    };
  }
  if (variant === 3) {
    return {
      kind: 'Stv',
      winners: (payload?.[0] ?? []).map(Number),
      rounds: (payload?.[1] ?? []).map((round) => ({
        counts: normCounts(round?.[0]),
        elected: (round?.[1] ?? []).map(Number),
        eliminated: round?.[2] == null ? null : Number(round[2]),
        quota: round?.[3] == null ? null : Number(round[3]),
      })),
    };
  }
  return null;
}

function candidateName(id) {
  const c = state.currentElection?.candidates;
  return c && Number(id) < c.length ? c[Number(id)] : `Candidate ${id}`;
}

function renderResult(result, schema = 'v2') {
  const el = $('m-results');
  $('m-raw-pre').textContent = JSON.stringify(result, null, 2);

  const r = normalizeResult(result, schema);
  let html = '';
  if (!r) {
    html = '<p class="hint">Unrecognised result shape — see raw JSON below.</p>';
  } else if (r.kind === 'Fptp') {
    html = `<h4>Winner</h4><p class="winner">${r.winner != null ? candidateName(r.winner) : 'no winner'}</p>`;
    html += '<h4>First-preference counts</h4>' + fptpCountsTable(r.counts, r.winner);
  } else if (r.kind === 'Irv') {
    html = `<h4>Winner</h4><p class="winner">${r.winner != null ? candidateName(r.winner) : 'no winner'}</p>`;
    html += '<h4>Rounds</h4>' + roundsTable(r.rounds, r.winner != null);
  } else if (r.kind === 'SequentialIrv') {
    html = `<h4>Winners</h4><p class="winner">${r.winners.length ? r.winners.map(candidateName).join(', ') : 'none'}</p>`;
    r.seats.forEach((seat, i) => {
      html += `<h4>Seat ${i + 1}${seat.winner != null ? ' — winner ' + candidateName(seat.winner) : ''}</h4>`;
      html += roundsTable(seat.irv_rounds, seat.winner != null);
    });
  } else if (r.kind === 'Stv') {
    html = `<h4>Winners (elected in order)</h4><p class="winner">${r.winners.length ? r.winners.map(candidateName).join(', ') : 'none'}</p>`;
    html += stvRoundsTable(r.rounds);
  }
  el.innerHTML = html;
}

function fptpCountsTable(counts, winner) {
  const order = Object.keys(counts).map(Number).sort((a, b) => a - b);
  let html = '<table class="round-table"><tr><th>Candidate</th><th>First-preference votes</th><th></th></tr>';
  for (const c of order) {
    const isWinner = winner != null && c === winner;
    html += `<tr><td>${candidateName(c)}</td><td>${counts[c] ?? 0}</td><td class="${isWinner ? 'winner' : ''}">${isWinner ? 'winner' : ''}</td></tr>`;
  }
  return html + '</table>';
}

function roundsTable(rounds, hasWinner = true) {
  if (!rounds.length) return '<p class="hint">no rounds</p>';
  const cands = new Set();
  for (const r of rounds) Object.keys(normCounts(r.counts)).forEach((c) => cands.add(Number(c)));
  const order = [...cands].sort((a, b) => a - b);
  let html = '<table class="round-table"><tr><th>Round</th>';
  for (const c of order) html += `<th>${candidateName(c)}</th>`;
  html += '<th>Action</th></tr>';
  rounds.forEach((r, i) => {
    const counts = normCounts(r.counts);
    html += `<tr><td>${i + 1}</td>`;
    for (const c of order) {
      html += `<td>${counts[c] ?? '·'}</td>`;
    }
    const final = r.eliminated == null;
    const action = final
      ? hasWinner ? 'winner' : 'no winner'
      : `eliminated ${candidateName(r.eliminated)}`;
    const cls = final ? (hasWinner ? 'winner' : '') : 'elim';
    html += `<td class="${cls}">${action}</td></tr>`;
  });
  return html + '</table>';
}

function stvRoundsTable(rounds) {
  if (!rounds.length) return '<p class="hint">no rounds</p>';
  const cands = new Set();
  for (const r of rounds) Object.keys(normCounts(r.counts)).forEach((c) => cands.add(Number(c)));
  const order = [...cands].sort((a, b) => a - b);
  let html = '<table class="round-table"><tr><th>Round</th>';
  for (const c of order) html += `<th>${candidateName(c)}</th>`;
  html += '<th>Action</th></tr>';
  rounds.forEach((r, i) => {
    const counts = normCounts(r.counts);
    html += `<tr><td>${i + 1}</td>`;
    for (const c of order) html += `<td>${counts[c] ?? '·'}</td>`;
    const acts = [];
    if (r.elected?.length) acts.push(`elected ${r.elected.map(candidateName).join(', ')}`);
    if (r.eliminated != null) acts.push(`eliminated ${candidateName(r.eliminated)}`);
    if (!acts.length) acts.push('—');
    html += `<td>${acts.join('; ')}</td></tr>`;
  });
  return html + '</table>';
}

function irvHtml(val) {
  const winner = val.winner != null ? `Candidate ${val.winner}` : 'no winner';
  return `<h4>Winner</h4><p class="winner">${winner}</p><h4>Rounds</h4>${roundsTable(val.rounds || [])}`;
}

function startPolling(id) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (!state.currentElection || state.currentElection.id !== id) return;
    try {
      const e = await api(`/api/elections/${id}`);
      state.currentElection = e;
      renderMonitor(e);
      if (e.status === 'ended') clearInterval(state.pollTimer);
    } catch {
      /* keep polling */
    }
  }, 5000);
}

$('btn-refresh').addEventListener('click', () => {
  if (state.currentElection) loadElection(state.currentElection.id);
});

$('in-autopoll').addEventListener('change', () => {
  if ($('in-autopoll').checked && state.currentElection) startPolling(state.currentElection.id);
  else clearInterval(state.pollTimer);
});

$('btn-end').addEventListener('click', () => endVoteAction('end'));
$('btn-end-expired').addEventListener('click', () => endVoteAction('end-expired'));

async function endVoteAction(kind) {
  const e = state.currentElection;
  if (!e) return;
  if (!confirm(kind === 'end' ? 'End the vote now and compute the final tally?' : 'Finalize the expired election with the ballots cast so far?')) return;
  $('m-progress').hidden = false;
  $('m-progress').textContent = 'ending vote…';
  try {
    const r = await api(`/api/elections/${e.id}/${kind}`, { method: 'POST', body: {} });
    log(`vote ended: <code>${e.componentAddress}</code>`);
    await loadElection(e.id);
  } catch (err) {
    log(`end failed: ${err.message}`, 'err');
  } finally {
    $('m-progress').hidden = true;
  }
}

// ---------- step highlighting ----------
function openStep(id) {
  document.querySelectorAll('.step').forEach((s) => s.classList.remove('current'));
  const el = $(id);
  el.open = true;
  el.classList.add('current');
}

document.querySelectorAll('.step summary').forEach((s) => {
  s.addEventListener('click', () => {
    document.querySelectorAll('.step').forEach((x) => x.classList.remove('current'));
    s.closest('.step').classList.add('current');
  });
});

// ---------- init ----------
updateMethodHint();
setDefaultDeadline();
refreshStatus();
setInterval(refreshStatus, 30000);
renderCandidates();
loadElectionOptions();