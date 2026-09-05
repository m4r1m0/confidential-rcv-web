// Minimal `Provider` implementation over the indexer REST client.
// The ootle JS SDK defines the Provider interface but ships no concrete class,
// so we adapt the IndexerClient to it (see @tari-project/ootle docs).
import { IndexerClient } from '@tari-project/indexer-client';

export class IndexerProvider {
  constructor(url, network) {
    this.client = IndexerClient.usingFetchTransport(url);
    this._network = network;
  }

  network() {
    return this._network;
  }

  async getCurrentEpoch() {
    const info = await this.client.networkInfo();
    return info.epoch ?? info.current_epoch;
  }

  async getSubstate(substateId, version = null) {
    const res = await this.client.substatesGet(substateId, {
      version,
      local_search_only: false,
    });
    return res;
  }

  async getStealthUtxo(resourceAddress, commitment) {
    const hex = Buffer.from(commitment).toString('hex');
    const id = `utxo_${resourceAddress.replace('resource_', '')}_${hex}`;
    try {
      return await this.getSubstate(id);
    } catch {
      return null;
    }
  }

  async fetchSubstates(requests) {
    const res = await this.client.fetchSubstates({
      requests: requests.map((id) => (typeof id === 'string' ? id : id.substate_id)),
      cached_only: false,
    });
    return res.substates;
  }

  async getTemplateDefinition(templateAddress) {
    const res = await this.client.templatesGet(templateAddress);
    return res;
  }

  async submitTransaction(envelope) {
    const res = await this.client.submitTransaction({ transaction: envelope });
    return { transaction_id: res.transaction_id };
  }

  async getTransactionResult(transactionId) {
    return this.client.getTransactionResult(transactionId);
  }

  async resolveInputs(inputs) {
    return inputs;
  }

  async listRecentTransactions(params) {
    return this.client.listRecentTransactions(params);
  }
}