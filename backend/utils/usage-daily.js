/**
 * Stub for the upstream PeteZahGames usage counter.
 *
 * music.js imports bumpUsage() to record daily API hits against their metrics
 * store. Xenon has no such store and does not need one, so this is a no-op
 * that keeps the import satisfied.
 */
export function bumpUsage() {}
export default { bumpUsage };
