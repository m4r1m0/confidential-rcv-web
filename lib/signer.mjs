// A Signer implementation backed by a raw ootle secret key (owner + view keys),
// built on the ootle-wasm primitives. Used for account-signed transactions
// (initiate, end vote, dry-run reads) and stealth spend authorizations.
import {
  generateOotleAddress,
  hashUnsignedTransaction,
  ootlePublicKeyFromSecretKey,
  publicKeyFromSecretKey,
  schnorrSign,
} from '@tari-project/ootle-wasm';
import { buildTransactionSignature, serializeUnsignedTx } from '@tari-project/ootle';

export class SecretKeySigner {
  constructor(ownerKey, viewKey, network) {
    this.ownerKey = new Uint8Array(ownerKey);
    this.viewKey = new Uint8Array(viewKey);
    this.network = network;
    const pk = ootlePublicKeyFromSecretKey(this.ownerKey, this.viewKey);
    this.ownerPublicKey = new Uint8Array(pk.owner_key);
    this.viewPublicKey = new Uint8Array(pk.view_key);
    this.address = generateOotleAddress(
      this.ownerPublicKey,
      this.viewPublicKey,
      network,
    );
  }

  async getAddress() {
    return this.address;
  }

  async getPublicKey() {
    return this.ownerPublicKey;
  }

  async getViewSecret() {
    return this.viewKey;
  }

  async signTransaction(unsignedTx, sealPublicKey) {
    const msg = hashUnsignedTransaction(
      serializeUnsignedTx(unsignedTx),
      new Uint8Array(sealPublicKey),
    );
    const sig = schnorrSign(this.ownerKey, msg);
    return [
      buildTransactionSignature(this.ownerPublicKey, {
        public_nonce: sig.public_nonce,
        signature: sig.signature,
      }),
    ];
  }

  async addStealthSignature(unsignedJson, publicNonce, sealPublicKey, ctx) {
    const { crypto } = ctx;
    const oneTimeSecret = await crypto.stealthDhSecret(
      this.network,
      this.ownerKey,
      new Uint8Array(publicNonce),
    );
    const msg = hashUnsignedTransaction(
      unsignedJson,
      new Uint8Array(sealPublicKey),
    );
    const sig = schnorrSign(oneTimeSecret, msg);
    const oneTimePublicKey = publicKeyFromSecretKey(oneTimeSecret);
    return buildTransactionSignature(oneTimePublicKey, {
      public_nonce: sig.public_nonce,
      signature: sig.signature,
    });
  }
}