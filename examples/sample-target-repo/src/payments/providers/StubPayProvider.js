import { BaseProvider } from '../BaseProvider.js';

/** A reference provider so the scaffold has a sibling to imitate. */
export class StubPayProvider extends BaseProvider {
  name = 'stub-pay';

  async createCharge(charge) {
    return { providerChargeId: `stub_${charge.idempotencyKey}`, status: 'succeeded' };
  }

  async refund(providerChargeId) {
    return { providerChargeId, status: 'succeeded' };
  }

  async getStatus() {
    return 'succeeded';
  }

  async verifyWebhook() {
    return true;
  }
}
