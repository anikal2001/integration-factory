import { REQUIRED_METHODS } from './IPaymentProvider.js';

/** Abstract base: subclasses must override every method in REQUIRED_METHODS. */
export class BaseProvider {
  name = 'base';

  async createCharge() {
    throw new Error(`${this.constructor.name}.createCharge not implemented`);
  }

  async refund() {
    throw new Error(`${this.constructor.name}.refund not implemented`);
  }

  async getStatus() {
    throw new Error(`${this.constructor.name}.getStatus not implemented`);
  }

  async verifyWebhook() {
    throw new Error(`${this.constructor.name}.verifyWebhook not implemented`);
  }

  /** True when every required method is overridden on the subclass prototype. */
  static implementsContract(ctor) {
    return REQUIRED_METHODS.every((method) => Object.prototype.hasOwnProperty.call(ctor.prototype, method));
  }
}
