import { disablePrivateMode, enablePrivateMode, getAuthStatus } from '@immich/sdk';
import { browser } from '$app/environment';
import { invalidateAll } from '$app/navigation';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

class PrivateModeManager {
  enabled = $state(false);
  expiresAt = $state<string | undefined>();
  hasPinCode = $state(false);

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
    }
  }

  async enable(pinCode: string) {
    await enablePrivateMode({ sessionUnlockDto: { pinCode } });
    await this.load();
  }

  async disable() {
    await disablePrivateMode();
    await this.load();
  }

  reset() {
    this.enabled = false;
    this.expiresAt = undefined;
    this.hasPinCode = false;
  }

  #apply(enabled: boolean, expiresAt: string | undefined, hasPinCode: boolean) {
    const changed = this.enabled !== enabled;

    this.enabled = enabled;
    this.expiresAt = expiresAt;
    this.hasPinCode = hasPinCode;

    if (changed) {
      eventManager.emit('PrivateModeChange', enabled);
      void invalidateAll();
    }
  }
}

export const privateModeManager = new PrivateModeManager();
