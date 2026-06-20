import { spawnSync } from 'node:child_process';
import os from 'node:os';

/**
 * macOS Keychain wrapper (the `security` CLI). Secrets are stored as generic passwords
 * under a single service name so they're easy to list/audit:
 *
 *   security add-generic-password -s foreman -a <NAME> -w <VALUE> -U
 *   security find-generic-password -s foreman -a <NAME> -w
 *   security delete-generic-password -s foreman -a <NAME>
 */

export const KEYCHAIN_SERVICE = 'foreman';

export function isKeychainAvailable(): boolean {
  return os.platform() === 'darwin';
}

export function keychainGet(name: string): string | null {
  if (!isKeychainAvailable()) return null;
  const r = spawnSync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return null;
  // `-w` prints just the password followed by a newline.
  return r.stdout.replace(/\n$/, '');
}

export function keychainSet(name: string, value: string): void {
  if (!isKeychainAvailable()) {
    throw new Error(
      `Keychain is only available on macOS. On this platform, set ${name} in your .env file instead.`,
    );
  }
  // `-U` updates the item if it already exists. We pass the value via -w on argv; the
  // `security` tool does not echo it, and our process args are local-only.
  const r = spawnSync(
    'security',
    ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w', value, '-U'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`Failed to store ${name} in keychain: ${r.stderr.trim()}`);
  }
}

export function keychainDelete(name: string): boolean {
  if (!isKeychainAvailable()) return false;
  const r = spawnSync(
    'security',
    ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name],
    { encoding: 'utf8' },
  );
  return r.status === 0;
}
