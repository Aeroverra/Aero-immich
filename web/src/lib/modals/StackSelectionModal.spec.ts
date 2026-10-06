import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import StackSelectionModal from './StackSelectionModal.svelte';

describe('StackSelectionModal component', () => {
  const onClose = vi.fn();

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

  it('explains how many stacks the selection holds', async () => {
    render(StackSelectionModal, { props: { stackCount: 2, onClose } });

    expect(await screen.findByText('Include stacked items?')).toBeInTheDocument();
    expect(screen.getByText(/Your selection includes 2 stacks\./)).toBeInTheDocument();
  });

  it('keeps the top items only', async () => {
    render(StackSelectionModal, { props: { stackCount: 1, onClose } });

    await userEvent.click(await screen.findByRole('button', { name: 'Top items only' }));

    expect(onClose).toHaveBeenCalledExactlyOnceWith({ includeStacked: false, remember: false });
  });

  it('includes the stacked items and remembers the choice', async () => {
    render(StackSelectionModal, { props: { stackCount: 1, onClose } });

    await userEvent.click(await screen.findByLabelText('Remember my choice'));
    await userEvent.click(screen.getByRole('button', { name: 'Include stacked items' }));

    expect(onClose).toHaveBeenCalledExactlyOnceWith({ includeStacked: true, remember: true });
  });

  it('cancels when closed', async () => {
    render(StackSelectionModal, { props: { stackCount: 1, onClose } });

    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledExactlyOnceWith();
  });
});
