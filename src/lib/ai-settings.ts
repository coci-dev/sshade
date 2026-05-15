/**
 * Multi-provider AI settings.
 *
 * Split storage:
 * - **Metadata** (active provider, per-provider model + baseURL) lives in
 *   localStorage (`v3`, no secrets).
 * - **API keys** live in the OS credential manager via the keyring bridge.
 *   At startup `initAiSecrets()` loads them into an in-memory cache so the
 *   synchronous `getActiveConfig()` (called on every render) stays sync.
 *
 * Legacy `v1`/`v2` blobs stored the key as base64 in localStorage — those
 * are migrated into the keyring and removed on first run.
 */

import { PROVIDERS, type ProviderId } from "./providers";
import { secretDelete, secretGet, secretSet } from "./secret-store";

const META_KEY = "sshade.ai.settings.v3";
const LEGACY_V2 = "sshade.ai.settings.v2";
const LEGACY_V1 = "sshade.ai.settings.v1";

export interface ProviderConfig {
  /** Filled from the keyring cache; never written to localStorage. */
  apiKey: string;
  model: string;
  baseURL?: string;
}

export interface AiSettings {
  active: ProviderId;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
}

interface StoredMeta {
  active: ProviderId;
  providers: Partial<Record<ProviderId, { model: string; baseURL?: string }>>;
}

/** In-memory API-key cache, keyed by provider. Populated by initAiSecrets. */
const keyCache = new Map<ProviderId, string>();

function accountFor(id: ProviderId): string {
  return `ai.${id}`;
}

function safeAtob(s: string): string {
  try {
    return atob(s);
  } catch {
    return "";
  }
}

function readMeta(): StoredMeta | null {
  const raw = localStorage.getItem(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredMeta;
  } catch {
    return null;
  }
}

function writeMeta(s: AiSettings): void {
  const meta: StoredMeta = { active: s.active, providers: {} };
  for (const [id, cfg] of Object.entries(s.providers)) {
    if (!cfg) continue;
    meta.providers[id as ProviderId] = {
      model: cfg.model,
      baseURL: cfg.baseURL,
    };
  }
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

/**
 * Run once at startup. Migrates legacy localStorage keys into the keyring,
 * then loads all keys into the in-memory cache.
 */
export async function initAiSecrets(): Promise<void> {
  await migrateLegacy();

  const meta = readMeta();
  if (!meta) return;
  for (const id of Object.keys(meta.providers) as ProviderId[]) {
    try {
      const v = await secretGet(accountFor(id));
      if (v) keyCache.set(id, v);
    } catch (e) {
      console.error("[sshade] keyring read failed for", id, e);
    }
  }
}

async function migrateLegacy(): Promise<void> {
  if (localStorage.getItem(META_KEY)) {
    localStorage.removeItem(LEGACY_V2);
    localStorage.removeItem(LEGACY_V1);
    return;
  }

  const v2 = localStorage.getItem(LEGACY_V2);
  if (v2) {
    try {
      const parsed = JSON.parse(v2) as {
        active?: ProviderId;
        providers?: Partial<
          Record<ProviderId, { apiKey?: string; model: string; baseURL?: string }>
        >;
      };
      const settings: AiSettings = {
        active: parsed.active ?? "anthropic",
        providers: {},
      };
      for (const [id, cfg] of Object.entries(parsed.providers ?? {})) {
        if (!cfg) continue;
        const pid = id as ProviderId;
        const key = cfg.apiKey ? safeAtob(cfg.apiKey) : "";
        if (key) {
          await secretSet(accountFor(pid), key);
          keyCache.set(pid, key);
        }
        settings.providers[pid] = {
          apiKey: key,
          model: cfg.model,
          baseURL: cfg.baseURL,
        };
      }
      writeMeta(settings);
      localStorage.removeItem(LEGACY_V2);
      localStorage.removeItem(LEGACY_V1);
      return;
    } catch (e) {
      console.error("[sshade] v2→v3 migration failed", e);
    }
  }

  const v1 = localStorage.getItem(LEGACY_V1);
  if (v1) {
    try {
      const old = JSON.parse(v1) as { apiKey?: string; model?: string };
      const key = old.apiKey ? safeAtob(old.apiKey) : "";
      const settings: AiSettings = {
        active: "anthropic",
        providers: {
          anthropic: {
            apiKey: key,
            model: old.model || PROVIDERS.anthropic.defaultModel,
          },
        },
      };
      if (key) {
        await secretSet(accountFor("anthropic"), key);
        keyCache.set("anthropic", key);
      }
      writeMeta(settings);
      localStorage.removeItem(LEGACY_V1);
    } catch (e) {
      console.error("[sshade] v1→v3 migration failed", e);
    }
  }
}

export function loadAiSettings(): AiSettings {
  const meta = readMeta();
  if (!meta) return { active: "anthropic", providers: {} };
  const providers: AiSettings["providers"] = {};
  for (const [id, cfg] of Object.entries(meta.providers)) {
    if (!cfg) continue;
    const pid = id as ProviderId;
    providers[pid] = {
      apiKey: keyCache.get(pid) ?? "",
      model: cfg.model,
      baseURL: cfg.baseURL,
    };
  }
  return { active: meta.active ?? "anthropic", providers };
}

/** Persists metadata to localStorage and API keys to the keyring. */
export async function saveAiSettings(settings: AiSettings): Promise<void> {
  writeMeta(settings);
  for (const [id, cfg] of Object.entries(settings.providers)) {
    if (!cfg) continue;
    const pid = id as ProviderId;
    const key = cfg.apiKey ?? "";
    if (key) {
      keyCache.set(pid, key);
      try {
        await secretSet(accountFor(pid), key);
      } catch (e) {
        console.error("[sshade] keyring write failed for", pid, e);
      }
    } else {
      keyCache.delete(pid);
      try {
        await secretDelete(accountFor(pid));
      } catch {
        /* nothing stored — fine */
      }
    }
  }
}

export function getActiveConfig(): {
  id: ProviderId;
  config: ProviderConfig;
} | null {
  const settings = loadAiSettings();
  const cfg = settings.providers[settings.active];
  const meta = PROVIDERS[settings.active];
  if (!cfg) return null;
  if (meta.needsKey && !cfg.apiKey) return null;
  if (meta.needsBaseURL && !(cfg.baseURL ?? meta.defaultBaseURL)) return null;
  return { id: settings.active, config: cfg };
}

export function hasUsableProvider(): boolean {
  return getActiveConfig() !== null;
}
