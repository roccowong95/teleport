/** Pairing links may never redirect credentials to another origin. */
export function validateEndpoint(endpoint, origin) {
  const url = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('invalid_endpoint');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('insecure_endpoint');
  if (url.origin !== new URL(origin).origin) throw new Error('different_origin');
  return url.origin;
}
export function canSend({ connected, ready, approved, paused, pending, bytes }) {
  return connected && ready && approved && !paused && !pending && bytes > 0 && bytes <= 8192;
}
export function retryDelay(attempt, random = Math.random()) { return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(random * 500); }
/** Accept action support only from an already authenticated/decrypted ready payload. */
export function supportsPressEnter(payload) {
 return payload?.kind === 'ready' && payload.capabilities !== null && typeof payload.capabilities === 'object' && !Array.isArray(payload.capabilities) && Object.hasOwn(payload.capabilities, 'pressEnter') && payload.capabilities.pressEnter === true;
}
