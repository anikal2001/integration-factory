import { StubPayProvider } from './providers/StubPayProvider.js';

/** Every provider id the service knows. Add new ids here (registration step 1). */
export const PROVIDER_IDS = ['stub-pay'];

/** id → provider class. Add new providers here (registration step 2). */
export const PROVIDERS = {
  'stub-pay': StubPayProvider,
};

export function createProvider(id) {
  const Provider = PROVIDERS[id];
  if (!Provider) throw new Error(`unknown payment provider "${id}"`);
  return new Provider();
}
