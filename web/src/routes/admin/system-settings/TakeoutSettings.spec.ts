import type { AdminConfigDto } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import TakeoutSettings from './TakeoutSettings.svelte';

const { saved, config } = vi.hoisted(() => ({
  saved: vi.fn(),
  config: { takeout: { readers: 3, throttleMBps: null, readaheadDepth: 4 } } as unknown as AdminConfigDto,
}));

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));

vi.mock('$lib/managers/system-config-manager.svelte', () => ({
  systemConfigManager: {
    value: config,
    defaultValue: config,
    cloneValue: () => structuredClone(config),
    cloneDefaultValue: () => structuredClone(config),
  },
}));

vi.mock('$lib/services/system-config.service', () => ({
  handleSystemConfigSave: saved,
}));

describe('TakeoutSettings component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('edits the three read settings and saves them as the takeout section', async () => {
    render(TakeoutSettings);

    expect(screen.getByText('Parts read in parallel')).toBeInTheDocument();
    expect(screen.getByText('Read limit (MB/s)')).toBeInTheDocument();
    expect(screen.getByText('Readahead')).toBeInTheDocument();
    // the settings inputs are labelled by name, in this order
    const [readers, limit, readahead] = screen.getAllByRole('spinbutton');
    expect(readers).toHaveValue(3);
    expect(limit).toHaveValue(null);
    expect(readahead).toHaveValue(4);

    await userEvent.clear(readers);
    await userEvent.type(readers, '1');
    await userEvent.type(limit, '40');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saved).toHaveBeenCalledExactlyOnceWith({ takeout: { readers: 1, throttleMBps: 40, readaheadDepth: 4 } });
  });
});
