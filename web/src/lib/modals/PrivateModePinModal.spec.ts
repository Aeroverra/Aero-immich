import { render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import PrivateModePinModal from './PrivateModePinModal.svelte';

describe('PrivateModePinModal component', () => {
  const onClose = vi.fn();

  const authStatus = (overrides: Partial<Awaited<ReturnType<typeof sdkMock.getAuthStatus>>> = {}) => ({
    isElevated: false,
    password: true,
    pinCode: true,
    privateMode: false,
    ...overrides,
  });

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();
  });

  afterAll(async () => {
    await waitFor(() => {
      expect(document.body.style.pointerEvents).not.toBe('none');
    });
  });

  it('shows the enter form when the user has a pin code', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(authStatus({ pinCode: true }));

    render(PrivateModePinModal, { props: { onClose } });

    expect(
      await screen.findByText('Enter your PIN code to show private photos and videos in this session.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('New PIN code')).not.toBeInTheDocument();
    expect(sdkMock.getAuthStatus).toHaveBeenCalledOnce();
  });

  it('focuses the pin field so the code can be typed right away', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(authStatus({ pinCode: true }));

    render(PrivateModePinModal, { props: { onClose } });

    await screen.findByText('Enter your PIN code to show private photos and videos in this session.');
    await waitFor(() => expect(document.activeElement?.tagName).toBe('INPUT'));
  });

  it('shows the create form only when the server says there is no pin code', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(authStatus({ pinCode: false }));

    render(PrivateModePinModal, { props: { onClose } });

    expect(
      await screen.findByText('You do not have a PIN code yet. Create one to turn on private mode.'),
    ).toBeInTheDocument();
    expect(screen.getByText('New PIN code')).toBeInTheDocument();
    expect(screen.queryByText('locked folder', { exact: false })).not.toBeInTheDocument();
  });

  it('shows neither form while the status is still loading', async () => {
    sdkMock.getAuthStatus.mockReturnValue(new Promise(() => {}));

    render(PrivateModePinModal, { props: { onClose } });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('New PIN code')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Enter your PIN code to show private photos and videos in this session.'),
    ).not.toBeInTheDocument();
  });

  it('closes when the status cannot be loaded', async () => {
    sdkMock.getAuthStatus.mockRejectedValue(new Error('offline'));

    render(PrivateModePinModal, { props: { onClose } });

    await waitFor(() => expect(onClose).toHaveBeenCalledExactlyOnceWith());
    expect(screen.queryByText('New PIN code')).not.toBeInTheDocument();
  });
});
