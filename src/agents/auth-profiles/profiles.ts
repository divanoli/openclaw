import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { normalizeProviderId } from "../model-selection.js";
import {
  ensureAuthProfileStore,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";

export async function setAuthProfileOrder(params: {
  agentDir?: string;
  provider: string;
  order?: string[] | null;
}): Promise<AuthProfileStore | null> {
  const providerKey = normalizeProviderId(params.provider);
  const sanitized =
    params.order && Array.isArray(params.order)
      ? params.order.map((entry) => String(entry).trim()).filter(Boolean)
      : [];

  const deduped: string[] = [];
  for (const entry of sanitized) {
    if (!deduped.includes(entry)) {
      deduped.push(entry);
    }
  }

  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      store.order = store.order ?? {};
      if (deduped.length === 0) {
        if (!store.order[providerKey]) {
          return false;
        }
        delete store.order[providerKey];
        if (Object.keys(store.order).length === 0) {
          store.order = undefined;
        }
        return true;
      }
      store.order[providerKey] = deduped;
      return true;
    },
  });
}

export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): void {
  const credential =
    params.credential.type === "api_key"
      ? {
          ...params.credential,
          ...(typeof params.credential.key === "string"
            ? { key: normalizeSecretInput(params.credential.key) }
            : {}),
        }
      : params.credential.type === "token"
        ? { ...params.credential, token: normalizeSecretInput(params.credential.token) }
        : params.credential;
  const store = ensureAuthProfileStore(params.agentDir);
  store.profiles[params.profileId] = credential;
  saveAuthProfileStore(store, params.agentDir);
}

export function listProfilesForProvider(store: AuthProfileStore, provider: string): string[] {
  const providerKey = normalizeProviderId(provider);
  return Object.entries(store.profiles)
    .filter(([, cred]) => normalizeProviderId(cred.provider) === providerKey)
    .map(([id]) => id);
}

// ─── Secret CRUD ────────────────────────────────────────────────

const SECRET_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const MAX_SECRET_VALUE_LENGTH = 16_384; // 16KB soft limit

export function validateSecretKey(key: string): string | null {
  if (!key) {
    return "Secret key cannot be empty";
  }
  if (!SECRET_KEY_PATTERN.test(key)) {
    return "Secret key must be UPPER_SNAKE_CASE (e.g., MY_API_KEY)";
  }
  if (key.startsWith("__")) {
    return "Secret keys starting with __ are reserved";
  }
  return null;
}

export async function upsertSecretValue(params: {
  key: string;
  value: string;
  agentDir?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const keyError = validateSecretKey(params.key);
  if (keyError) {
    return { ok: false, error: keyError };
  }

  const normalized = normalizeSecretInput(params.value);
  if (!normalized) {
    return { ok: false, error: "Secret value cannot be empty" };
  }
  if (normalized.length > MAX_SECRET_VALUE_LENGTH) {
    return { ok: false, error: `Secret value exceeds ${MAX_SECRET_VALUE_LENGTH} byte limit` };
  }

  const result = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      store.secrets = store.secrets ?? {};
      store.secrets[params.key] = normalized;
      return true;
    },
  });
  return result ? { ok: true } : { ok: false, error: "Failed to acquire store lock" };
}

export function getSecretValue(params: { key: string; agentDir?: string }): string | undefined {
  const store = ensureAuthProfileStore(params.agentDir);
  return store.secrets?.[params.key];
}

export function listSecretKeys(params?: { agentDir?: string }): string[] {
  const store = ensureAuthProfileStore(params?.agentDir);
  return Object.keys(store.secrets ?? {}).toSorted();
}

export async function deleteSecretValue(params: {
  key: string;
  agentDir?: string;
}): Promise<{ ok: boolean; existed: boolean }> {
  let existed = false;
  const result = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      if (!store.secrets?.[params.key]) {
        return false;
      }
      existed = true;
      delete store.secrets[params.key];
      if (Object.keys(store.secrets).length === 0) {
        store.secrets = undefined;
      }
      return true;
    },
  });
  return result ? { ok: true, existed } : { ok: false, existed: false };
}

// ─── Auth Profile Helpers ───────────────────────────────────────

export async function markAuthProfileGood(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, provider, profileId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile || profile.provider !== provider) {
        return false;
      }
      freshStore.lastGood = { ...freshStore.lastGood, [provider]: profileId };
      return true;
    },
  });
  if (updated) {
    store.lastGood = updated.lastGood;
    return;
  }
  const profile = store.profiles[profileId];
  if (!profile || profile.provider !== provider) {
    return;
  }
  store.lastGood = { ...store.lastGood, [provider]: profileId };
  saveAuthProfileStore(store, agentDir);
}
