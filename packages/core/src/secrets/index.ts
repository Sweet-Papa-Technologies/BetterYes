import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { isKeychainAvailable, keychainGet, keychainSet, keychainDelete } from './keychain.js';

/**
 * Secret resolver with strict precedence and NO silent fall-through to insecure defaults:
 *
 *   1. process.env[NAME]              (highest — explicit, ephemeral)
 *   2. .env file at the repo root     (loaded once)
 *   3. macOS Keychain (service=foreman)
 *   4. not found  → throw a clear, actionable error
 *
 * This lets the operator use the Keychain on macOS while everyone else (and CI/Docker)
 * uses .env or real env vars — "easier methods for other folks" — with the same code path.
 */

let dotenvLoaded = false;

function loadDotenvOnce(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  // Look for .env upward from cwd (repo root). Quiet if absent.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export interface ResolvedSecret {
  value: string;
  source: 'env' | 'dotenv' | 'keychain';
}

/** Resolve a secret, returning where it came from. Returns null if absent everywhere. */
export function resolveSecret(name: string): ResolvedSecret | null {
  // 1. real process env (set before dotenv runs)
  const fromEnv = process.env[name];

  loadDotenvOnce();
  // After dotenv, process.env may now contain the value. Distinguish source: dotenv only
  // fills keys that were previously unset, so if it was set before load it's "env".
  const afterDotenv = process.env[name];

  if (fromEnv !== undefined && fromEnv !== '') {
    return { value: fromEnv, source: 'env' };
  }
  if (afterDotenv !== undefined && afterDotenv !== '') {
    return { value: afterDotenv, source: 'dotenv' };
  }

  // 3. keychain
  const fromKeychain = keychainGet(name);
  if (fromKeychain !== null && fromKeychain !== '') {
    return { value: fromKeychain, source: 'keychain' };
  }
  return null;
}

/** Resolve a required secret or throw with guidance. */
export function requireSecret(name: string): string {
  const r = resolveSecret(name);
  if (r) return r.value;
  const how = isKeychainAvailable()
    ? `set it with:  pnpm foreman secret set ${name}\n  or add ${name}=… to your .env file`
    : `add ${name}=… to your .env file (Keychain storage is macOS-only)`;
  throw new Error(`Missing required secret "${name}". To fix, ${how}.`);
}

/** Optional secret — returns undefined instead of throwing. */
export function optionalSecret(name: string): string | undefined {
  return resolveSecret(name)?.value;
}

/** Store a secret. On macOS → keychain; elsewhere → instruct the user to use .env. */
export function setSecret(name: string, value: string): 'keychain' | 'unsupported' {
  if (isKeychainAvailable()) {
    keychainSet(name, value);
    return 'keychain';
  }
  return 'unsupported';
}

export function deleteSecret(name: string): boolean {
  return keychainDelete(name);
}

export { isKeychainAvailable };
