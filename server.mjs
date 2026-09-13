// Confidential RCV web server.
// Serves the static front end and a small JSON API for the election lifecycle.
// The initiator's wallet keys live in config.env (gitignored).
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { generateOotleSecretKey } from '@tari-project/ootle-wasm';
import {
  currentEpoch,
  endVote,
  initiateElection,
  makeContext,
  readElectionState,
  setupAccount,
} from './lib/chain.mjs';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT || 80);
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.env');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'elections.json');

// --- config ---
function loadConfig() {
  const cfg = {};
  if (existsSync(CONFIG_FILE)) {
    for (const line of readFileSync(CONFIG_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) cfg[m[1]] = m[2];
    }
  }
  if (!cfg.OWNER_KEY_HEX || !cfg.VIEW_KEY_HEX) {
    const k = generateOotleSecretKey();
    cfg.OWNER_KEY_HEX = Buffer.from(k.owner_key).toString('hex');
    cfg.VIEW_KEY_HEX = Buffer.from(k.view_key).toString('hex');
    writeFileSync(
      CONFIG_FILE,
      `# generated on first run — keep private\nNETWORK=${cfg.NETWORK || 'esmeralda'}\nOOTLE_INDEXER_URL=${cfg.OOTLE_INDEXER_URL || ''}\nTEMPLATE_ADDRESS=${cfg.TEMPLATE_ADDRESS || ''}\nOWNER_KEY_HEX=${cfg.OWNER_KEY_HEX}\nVIEW_KEY_HEX=${cfg.VIEW_KEY_HEX}\nPORT=${PORT}\nDATA_FILE=${DATA_FILE}\n`,
    );
  }
  if (!cfg.TEMPLATE_ADDRESS) {
    console.error('[rcv] TEMPLATE_ADDRESS not set in config.env — publish the template and set it');
  }
  return cfg;
}

const cfg = loadConfig();
const ctx = makeContext(cfg);

// Approximate epoch length in seconds. Esmeralda epochs are ~20-30 min; the value is
// configurable via EPOCH_DURATION_SECS and only used to translate between wall-clock
// time and epoch numbers (the on-chain deadline is always the epoch).
const EPOCH_DURATION_SECS = Number(cfg.EPOCH_DURATION_SECS || 1200);

function epochToUtc(epoch, currentEpoch) {
  const secs = (epoch - currentEpoch) * EPOCH_DURATION_SECS;
  return new Date(Date.now() + secs * 1000).toISOString();
}

function utcToEpochDelta(utcIso, currentEpoch) {
  const target = Date.parse(utcIso);
  if (Number.isNaN(target)) throw new Error('invalid endUtc date');
  const diffSecs = (target - Date.now()) / 1000;
  return Math.ceil(diffSecs / EPOCH_DURATION_SECS);
}

// --- persistence ---
function loadElections() {
  if (!existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8')).elections ?? [];
  } catch {
    return [];
  }
}

function saveElections(list) {
  mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify({ elections: list }, null, 2));
}

let elections = loadElections();

function publicElection(e) {
  return {
    id: e.id,
    title: e.title,
    createdAt: e.createdAt,
    componentAddress: e.componentAddress,
    ballotResource: e.ballotResource,
    templateAddress: e.templateAddress,
    tallyMethod: e.tallyMethod,
    numWinners: e.numWinners,
    numCandidates: e.numCandidates,
    candidates: e.candidates,
    voters: e.voters,
    expiresAtEpoch: e.expiresAtEpoch,
    expiresAtUtc: e.expiresAtUtc ?? null,
    resultSchema: e.resultSchema ?? 'legacy',
    status: e.status,
    txId: e.txId,
  };
}

// --- http ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 2_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, rel) {
  try {
    const data = await readFile(path.join(PUBLIC_DIR, rel));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(rel)] || 'text/plain',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // static
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html')) return serveStatic(req, res, 'index.html');
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/app.js') return serveStatic(req, res, 'app.js');
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/style.css') return serveStatic(req, res, 'style.css');

    // status
    if (req.method === 'GET' && p === '/api/status') {
      const epoch = await currentEpoch(ctx);
      return sendJson(res, 200, {
        network: cfg.NETWORK,
        indexerUrl: ctx.provider.client.getTransport?.()?.url ?? 'unknown',
        epoch,
        templateAddress: cfg.TEMPLATE_ADDRESS || null,
        walletAccount: ctx.account,
        walletAddress: ctx.signer.address,
        epochDurationSecs: EPOCH_DURATION_SECS,
        elections: elections.length,
      });
    }

    // setup (create account + faucet)
    if (req.method === 'POST' && p === '/api/setup') {
      const res2 = await setupAccount(ctx);
      return sendJson(res, 200, { txId: res2?.transaction_id ?? null, account: ctx.account });
    }

    // create + initiate election
    if (req.method === 'POST' && p === '/api/elections') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const title = String(body.title || 'Untitled election').slice(0, 200);
      const tallyMethod = ['stv', 'sequential-irv', 'fptp'].includes(body.tallyMethod) ? body.tallyMethod : 'irv';
      const numWinners = Math.max(1, Math.min(100, Math.floor(Number(body.numWinners) || 1)));
      const numCandidates = Math.max(1, Math.min(50, Math.floor(Number(body.numCandidates) || 0)));
      const candidates = Array.isArray(body.candidates) ? body.candidates.map(String).slice(0, 50) : [];
      const voterAddresses = (Array.isArray(body.voters) ? body.voters : [])
        .map((v) => String(v).trim())
        .filter((v) => /^otl_esm_/.test(v));
      const epoch = await currentEpoch(ctx);
      let expiresInEpochs;
      if (body.endUtc) {
        expiresInEpochs = Math.max(1, Math.min(100_000, utcToEpochDelta(body.endUtc, epoch)));
      } else {
        expiresInEpochs = Math.max(1, Math.min(100_000, Math.floor(Number(body.expiresInEpochs) || 100)));
      }
      const expiresAtEpoch = epoch + expiresInEpochs;

      if (!cfg.TEMPLATE_ADDRESS) throw new Error('TEMPLATE_ADDRESS not configured');
      if (numCandidates < 2) throw new Error('at least 2 candidates required');
      if (numWinners > numCandidates) throw new Error('numWinners cannot exceed candidates');
      if (tallyMethod === 'fptp' && numWinners !== 1) throw new Error('FPTP is single-winner (numWinners must be 1)');
      if (voterAddresses.length < 1) throw new Error('at least one voter address required');
      if (voterAddresses.length !== (Array.isArray(body.voters) ? body.voters.length : 0)) {
        throw new Error('invalid voter addresses (must be otl_esm_... ootle addresses)');
      }

      const initiated = await initiateElection(ctx, cfg, {
        voterAddresses,
        numCandidates,
        numWinners,
        tallyMethod,
        expiresAtEpoch,
      });

      const record = {
        id: randomUUID(),
        title,
        createdAt: new Date().toISOString(),
        componentAddress: initiated.componentAddress,
        ballotResource: initiated.ballotResource,
        templateAddress: cfg.TEMPLATE_ADDRESS,
        tallyMethod,
        numWinners,
        numCandidates,
        candidates,
        voters: voterAddresses.map((a, i) => ({
          address: a,
          commitment: initiated.ballots[i].commitment,
          nonce: initiated.ballots[i].nonce,
        })),
        expiresAtEpoch,
        expiresInEpochs,
        expiresAtUtc: epochToUtc(expiresAtEpoch, epoch),
        resultSchema: 'v2',
        status: 'open',
        txId: initiated.txId,
        events: initiated.events,
      };
      elections.push(record);
      saveElections(elections);
      return sendJson(res, 200, publicElection(record));
    }

    // list elections
    if (req.method === 'GET' && p === '/api/elections') {
      return sendJson(res, 200, elections.map(publicElection));
    }

    // single election + live state
    const oneMatch = p.match(/^\/api\/elections\/([^/]+)$/);
    if (oneMatch && req.method === 'GET') {
      const e = elections.find((x) => x.id === oneMatch[1]);
      if (!e) return sendJson(res, 404, { error: 'not found' });
      const epoch = await currentEpoch(ctx);
      const fresh = { ...publicElection(e), expiresAtUtc: epochToUtc(e.expiresAtEpoch, epoch) };
      let state = null;
      try {
        state = await readElectionState(ctx, e.componentAddress);
      } catch (err) {
        state = { error: String(err.message || err) };
      }
      return sendJson(res, 200, { ...fresh, epoch, state });
    }

    // end vote
    const endMatch = p.match(/^\/api\/elections\/([^/]+)\/(end|end-expired)$/);
    if (endMatch && req.method === 'POST') {
      const e = elections.find((x) => x.id === endMatch[1]);
      if (!e) return sendJson(res, 404, { error: 'not found' });
      const method = endMatch[2] === 'end-expired' ? 'end_vote_expired' : 'end_vote';
      const outcome = await endVote(ctx, e.componentAddress, method);
      e.status = 'ended';
      e.endResult = outcome.result;
      e.endEvents = outcome.events;
      e.endedAt = new Date().toISOString();
      saveElections(elections);
      return sendJson(res, 200, { ...publicElection(e), outcome });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[rcv] error:', err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[rcv] confidential-rcv-web listening on :${PORT}`);
  console.log(`[rcv] initiator account: ${ctx.account}`);
  console.log(`[rcv] template: ${cfg.TEMPLATE_ADDRESS || '(not configured)'}`);
});