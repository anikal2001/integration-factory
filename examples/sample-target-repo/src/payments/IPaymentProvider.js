/**
 * The contract every payment provider in acme-billing implements.
 *
 * @typedef {object} Charge
 * @property {string} customerId
 * @property {number} amountMinor  Amount in the currency's minor unit (cents).
 * @property {string} currency     ISO 4217 code.
 * @property {string} idempotencyKey
 *
 * @typedef {object} ChargeResult
 * @property {string} providerChargeId
 * @property {'pending'|'succeeded'|'failed'} status
 *
 * @typedef {object} IPaymentProvider
 * @property {string} name                                     Stable provider id (kebab-case).
 * @property {(charge: Charge) => Promise<ChargeResult>} createCharge
 * @property {(providerChargeId: string, amountMinor?: number) => Promise<ChargeResult>} refund
 * @property {(providerChargeId: string) => Promise<ChargeResult['status']>} getStatus
 * @property {(headers: Record<string,string>, rawBody: string) => Promise<boolean>} verifyWebhook
 */

export const REQUIRED_METHODS = ['createCharge', 'refund', 'getStatus', 'verifyWebhook'];
