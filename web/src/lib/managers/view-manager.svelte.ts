import {
  getActiveCustomView,
  getCustomViews,
  setActiveCustomView,
  ViewAccess,
  type CustomViewActiveResponseDto,
  type CustomViewResponseDto,
} from '@immich/sdk';
import { browser } from '$app/environment';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';

const isSupported = () => {
  try {
    return !!featureFlagsManager.value.customViews;
  } catch {
    return false;
  }
};

/**
 * The custom views of the user and the one the session switched to. The server applies the view to every response,
 * so switching only has to reload what is on screen, exactly like a private mode toggle does.
 */
class ViewManager {
  views = $state<CustomViewResponseDto[]>([]);
  active = $state<CustomViewActiveResponseDto>({ viewId: null, view: null, expiresAt: null });
  #loaded = false;

  constructor() {
    eventManager.on({
      AuthLogin: () => void this.load(),
      AuthLogout: () => this.reset(),
      // private mode lists private views, and relocking it returns the session to the default view
      PrivateModeChange: () => void this.load(),
      SessionLocked: () => void this.load(),
    });

    if (browser) {
      addEventListener('focus', () => void this.load());
    }
  }

  get defaultView() {
    return this.views.find((view) => view.isDefault);
  }

  /** the views the switcher offers besides the default */
  get otherViews() {
    return this.views.filter((view) => !view.isDefault);
  }

  async load() {
    if (!authManager.authenticated || authManager.isSharedLink || !isSupported()) {
      return;
    }

    try {
      const [views, active] = await Promise.all([getCustomViews({}), getActiveCustomView()]);
      const changed = this.#loaded && active.viewId !== this.active.viewId;
      this.views = views;
      this.active = active;
      this.#loaded = true;

      // the view timed out or was deleted somewhere else: reload what is on screen for the default view
      if (changed) {
        privateModeManager.invalidate();
      }
    } catch {
      // noop
    }
  }

  isLocked(view: CustomViewResponseDto) {
    return view.access === ViewAccess.Locked;
  }

  /** Switch the session; a locked view needs the PIN on every switch, the default view (null) never does */
  async switch(viewId: string | null, pinCode?: string) {
    this.active = await setActiveCustomView({ customViewActiveUpdateDto: { viewId, pinCode } });
    this.#loaded = true;
    privateModeManager.invalidate();
  }

  reset() {
    this.views = [];
    this.active = { viewId: null, view: null, expiresAt: null };
    this.#loaded = false;
  }
}

export const viewManager = new ViewManager();
