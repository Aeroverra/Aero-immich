import { invalidateAll } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { privateModeManager } from '$lib/managers/private-mode-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

const authStatus = (overrides: Partial<Awaited<ReturnType<typeof sdkMock.getAuthStatus>>> = {}) => ({
  isElevated: false,
  password: true,
  pinCode: true,
  privateMode: false,
  ...overrides,
});

describe('PrivateModeManager', () => {
  const onPrivateModeChange = vi.fn();
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build());
    privateModeManager.reset();
    unsubscribe = eventManager.on({ PrivateModeChange: onPrivateModeChange });
  });

  afterEach(() => {
    unsubscribe();
  });

  describe('load', () => {
    it('does nothing when not authenticated', async () => {
      authManager.reset();

      await privateModeManager.load();

      expect(sdkMock.getAuthStatus).not.toHaveBeenCalled();
      expect(privateModeManager.enabled).toBe(false);
    });

    it('reads the session status', async () => {
      sdkMock.getAuthStatus.mockResolvedValue(
        authStatus({ privateMode: true, privateModeExpiresAt: '2030-01-01T00:00:00.000Z', pinCode: true }),
      );

      await privateModeManager.load();

      expect(privateModeManager.enabled).toBe(true);
      expect(privateModeManager.expiresAt).toBe('2030-01-01T00:00:00.000Z');
      expect(privateModeManager.hasPinCode).toBe(true);
    });

    it('emits PrivateModeChange and invalidates loaded pages when the state flips', async () => {
      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ privateMode: true }));

      await privateModeManager.load();

      expect(onPrivateModeChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(invalidateAll).toHaveBeenCalledOnce();
    });

    it('does not emit when the state is unchanged', async () => {
      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ privateMode: false, pinCode: false }));

      await privateModeManager.load();
      await privateModeManager.load();

      expect(onPrivateModeChange).not.toHaveBeenCalled();
      expect(invalidateAll).not.toHaveBeenCalled();
      expect(privateModeManager.hasPinCode).toBe(false);
    });

    it('swallows status errors', async () => {
      sdkMock.getAuthStatus.mockRejectedValue(new Error('offline'));

      await expect(privateModeManager.load()).resolves.toBeUndefined();
      expect(privateModeManager.enabled).toBe(false);
    });
  });

  describe('enable', () => {
    it('sends the pin code and reloads the status', async () => {
      sdkMock.enablePrivateMode.mockResolvedValue(undefined as never);
      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ privateMode: true }));

      await privateModeManager.enable('123456');

      expect(sdkMock.enablePrivateMode).toHaveBeenCalledWith({ sessionUnlockDto: { pinCode: '123456' } });
      expect(sdkMock.getAuthStatus).toHaveBeenCalledOnce();
      expect(privateModeManager.enabled).toBe(true);
      expect(onPrivateModeChange).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('propagates a wrong pin code error without changing state', async () => {
      sdkMock.enablePrivateMode.mockRejectedValue(new Error('wrong pin'));

      await expect(privateModeManager.enable('000000')).rejects.toThrow('wrong pin');

      expect(sdkMock.getAuthStatus).not.toHaveBeenCalled();
      expect(privateModeManager.enabled).toBe(false);
      expect(onPrivateModeChange).not.toHaveBeenCalled();
    });
  });

  describe('disable', () => {
    it('turns the mode off and emits the change', async () => {
      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ privateMode: true }));
      await privateModeManager.load();
      onPrivateModeChange.mockClear();

      sdkMock.disablePrivateMode.mockResolvedValue(undefined as never);
      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ privateMode: false }));

      await privateModeManager.disable();

      expect(sdkMock.disablePrivateMode).toHaveBeenCalledOnce();
      expect(privateModeManager.enabled).toBe(false);
      expect(privateModeManager.expiresAt).toBeUndefined();
      expect(onPrivateModeChange).toHaveBeenCalledExactlyOnceWith(false);
    });
  });

  describe('events', () => {
    it('refreshes the status when the session is locked', async () => {
      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ privateMode: false }));

      eventManager.emit('SessionLocked');
      await vi.waitFor(() => expect(sdkMock.getAuthStatus).toHaveBeenCalledOnce());
    });

    it('clears the pin code flag when the pin code is reset', async () => {
      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ pinCode: true }));
      await privateModeManager.load();
      expect(privateModeManager.hasPinCode).toBe(true);

      eventManager.emit('UserPinCodeReset');

      expect(privateModeManager.hasPinCode).toBe(false);
    });

    it('resets on logout', async () => {
      sdkMock.getAuthStatus.mockResolvedValue(authStatus({ privateMode: true }));
      await privateModeManager.load();

      eventManager.emit('AuthLogout');

      expect(privateModeManager.enabled).toBe(false);
      expect(privateModeManager.hasPinCode).toBe(false);
    });
  });
});
