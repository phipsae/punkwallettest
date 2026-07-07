// Platform-appropriate storage for sensitive blobs. Native iOS uses the
// Keychain via the SecureStorage Capacitor plugin
// (ios/App/App/SecureStoragePlugin.swift); the web build falls back to
// localStorage. On native, plugin errors PROPAGATE - never silently fall
// back to localStorage there, or secrets would quietly land in the WebView.

import { Capacitor, registerPlugin } from "@capacitor/core";

interface SecureStoragePluginType {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const SecureStorage = registerPlugin<SecureStoragePluginType>("SecureStorage");

export function isNativeSecureStorage(): boolean {
  return Capacitor.isNativePlatform();
}

export async function secureGet(key: string): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    const { value } = await SecureStorage.get({ key });
    return value ?? null;
  }
  if (typeof window === "undefined") return null;
  return localStorage.getItem(key);
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await SecureStorage.set({ key, value });
    return;
  }
  localStorage.setItem(key, value);
}

export async function secureRemove(key: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await SecureStorage.remove({ key });
    return;
  }
  localStorage.removeItem(key);
}
