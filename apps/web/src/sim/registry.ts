import type { SimEngine, SimEngineFactory, SimProfile } from "./types";

const engines = new Map<string, SimEngineFactory>();
export function registerEngine(id: string, factory: SimEngineFactory) {
  engines.set(id, factory);
}
export function createEngine(id: string): SimEngine {
  const factory = engines.get(id);
  if (!factory) throw new Error(`No simulator engine "${id}" is registered`);
  return factory();
}
export const hasEngine = (id: string) => engines.has(id);

/**
 * Profiles installed on this machine (tools/sim/install-*.sh writes public/sim/profiles.json). An empty
 * list simply means no simulator has been installed; the page then offers nothing.
 */
export async function loadProfiles(fetcher: typeof fetch = fetch): Promise<SimProfile[]> {
  try {
    const r = await fetcher("/sim/profiles.json", { cache: "no-cache" });
    if (!r.ok) return [];
    const list = (await r.json()) as SimProfile[];
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && hasEngine(p.engine)) : [];
  } catch {
    return [];
  }
}
