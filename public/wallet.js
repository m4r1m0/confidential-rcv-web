// Shared window.tari bridge helpers, used by both the initiator console (app.js)
// and the voting page (vote.js). Loaded as a plain script before either page.
//
// The wallet's create -> approve -> submit flow: create returns a requestId
// immediately (so a page reload mid-approval can poll by id and carry on), then
// the page polls until the request leaves "pending", and submits if needed.
window.RcvWallet = (function () {
  // A wallet stuck on "pending" (user walked away, approval screen lost) should not
  // leave the page spinning forever.
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  const POLL_INTERVAL_MS = 1500;

  async function submitTransactionRequest(params) {
    const { requestId } = await window.tari.request({
      method: 'tari_createTransactionRequest',
      params,
    });
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let record;
    for (;;) {
      record = await window.tari.request({
        method: 'tari_getTransactionRequest',
        params: { requestId },
      });
      if (record.status !== 'pending') break;
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for the wallet to approve the transaction.');
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (record.status === 'rejected') throw new Error('Rejected in the wallet.');
    if (record.status === 'failed') throw new Error(record.error || 'The wallet reported an error.');
    return (
      record.status === 'submitted'
        ? record.result
        : await window.tari.request({
            method: 'tari_submitTransactionRequest',
            params: { requestId },
          })
    );
  }

  return { submitTransactionRequest };
})();