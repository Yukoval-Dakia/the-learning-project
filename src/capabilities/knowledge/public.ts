// Public server contract for consumers outside the knowledge capability.
// Keep this surface narrow: callers depend on the capability contract, not its
// private server layout.
export { batchResolveEffectiveDomains } from './server/domain';
