/**
 * TEST-ONLY identity authority injection seam.
 *
 * Production modules and future CLI activation code must never import this module. The formal
 * entrypoint always creates its own system adapter and exposes no injection parameter.
 */
export {
  captureExactCurrentIdentityAuthorityControlled as captureExactCurrentIdentityAuthorityWithAdapter,
  type IdentityProbeAdapter,
} from './identity.js';
