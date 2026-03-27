import { getVersion } from '@tauri-apps/api/app';

import packageJson from '../../package.json';
import { isTauri } from './tauri';

export const PACKAGE_VERSION: string = packageJson.version;

/**
 * Version shown in About and UI: Tauri bundle version when running in the app,
 * otherwise the version from package.json (dev / web).
 */
export async function getAppVersion(): Promise<string> {
  if (isTauri()) {
    try {
      return await getVersion();
    } catch {
      return PACKAGE_VERSION;
    }
  }
  return PACKAGE_VERSION;
}
