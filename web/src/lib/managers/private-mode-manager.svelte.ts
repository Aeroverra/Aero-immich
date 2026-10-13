import { disablePrivateMode, enablePrivateMode, getAuthStatus } from '@immich/sdk';
import { browser } from '$app/environment';
import { invalidateAll } from '$app/navigation';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

class PrivateModeManager {
  enabled = $state(false);
  expiresAt = $state<string | undefined>();
  hasPinCode = $state(false);
  #initialized = false;

  constructor() {
    eventManager.on({
      AuthLogin: () => void this.load(),
      AuthLogout: () => this.reset(),
      SessionLocked: () => void this.load(),
      UserPinCodeReset: () => (this.hasPinCode = false),
    });

    if (browser) {
      addEventListener('focus', () => void this.load());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          void this.load();
        }
      });
    }
  }

  async load() {
    if (!authManager.authenticated || authManager.isSharedLink) {
      return;
    }

    try {
      const { privateMode, privateModeExpiresAt, pinCode } = await getAuthStatus();
      this.#apply(privateMode, privateModeExpiresAt, pinCode);
    } catch {
      // noop
    } finally {
      this.#initialized = true;
    }
  }

  async enable(pinCode: string) {
    await enablePrivateMode({ sessionUnlockDto: { pinCode } });
    this.#initialized = true;
    await this.load();
  }

  async disable() {
    await disablePrivateMode();
    this.#initialized = true;
    await this.load();
  }

  /**
   * The server changed the private flag of assets behind this client's back (the flag spread to stack members
   * or turned an album private): everything derived from it reloads exactly as it does on a toggle.
   */
  invalidate() {
    if (!this.#initialized) {
      return;
    }

    eventManager.emit('PrivateModeChange', this.enabled);
    void invalidateAll();
  }

  reset() {
    this.enabled = false;
    this.expiresAt = undefined;
    this.hasPinCode = false;
    this.#initialized = false;
  }

  #apply(enabled: boolean, expiresAt: string | undefined, hasPinCode: boolean) {
    const changed = this.enabled !== enabled;

    this.enabled = enabled;
    this.expiresAt = expiresAt;
    this.hasPinCode = hasPinCode;

    // the very first load runs inside the root layout load; invalidating there would deadlock the app
    if (changed && this.#initialized) {
      eventManager.emit('PrivateModeChange', enabled);
      void invalidateAll();
    }
  }
}

export const privateModeManager = new PrivateModeManager();
