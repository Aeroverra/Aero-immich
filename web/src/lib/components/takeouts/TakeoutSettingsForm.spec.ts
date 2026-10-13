import { screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import TakeoutSettingsForm from '$lib/components/takeouts/TakeoutSettingsForm.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { takeoutRunFactory } from '@test-data/factories/takeout-factory';

describe('TakeoutSettingsForm component', () => {
  const settings = (customTags: string[]) => ({ ...takeoutRunFactory.build().settings, customTags });

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    // the home time zone combobox
    vi.stubGlobal('visualViewport', getVisualViewportMock());
  });

  it('lists {email} among the variables of the custom tags', () => {
    renderWithTooltips(TakeoutSettingsForm, { settings: settings([]) });

    expect(screen.getByText('{date} · {user} · {email} · {start}')).toBeInTheDocument();
  });

  it('resets the custom tags to the export date and the whole Google account email', async () => {
    // two Google accounts with the same name before the @ were both tagged "aeroverra" by {user}
    const user = userEvent.setup();
    renderWithTooltips(TakeoutSettingsForm, { settings: settings(['Mine']) });
    expect(screen.getByDisplayValue('Mine')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset to default' }));

    expect(screen.getByDisplayValue('Source/Google Photos/{date} {email}')).toBeInTheDocument();
  });
});
