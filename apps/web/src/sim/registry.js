/** @type {Map<string, import("./types.js").SimEngineFactory>} */
const engines = new Map();
/** @param {string} id
 * @param {import("./types.js").SimEngineFactory} factory */
export function registerEngine(id, factory) {
  engines.set(id, factory);
}
/** @param {string} id */
export function createEngine(id) {
  const factory = engines.get(id);
  if (!factory) throw new Error(`No simulator engine "${id}" is registered`);
  return factory();
}
export const hasEngine = (/** @type {string} */ id) => engines.has(id);

/**
 * Profiles installed on this machine (tools/sim/install-*.sh writes public/sim/profiles.json). An empty
 * list simply means no simulator has been installed; the page then offers nothing.
 * @returns {Promise<import("./types.js").SimProfile[]>}
 */
export async function loadProfiles(fetcher = fetch) {
  try {
    const r = await fetcher("/sim/profiles.json", { cache: "no-cache" });
    if (!r.ok) return [];
    const list = await r.json();
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && hasEngine(p.engine)) : [];
  } catch {
    return [];
  }
}
