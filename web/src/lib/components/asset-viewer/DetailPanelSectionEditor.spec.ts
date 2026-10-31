import '@testing-library/jest-dom';
import { fireEvent, screen } from '@testing-library/svelte';
import DetailPanelSectionEditor from '$lib/components/asset-viewer/DetailPanelSectionEditor.svelte';
import { DetailPanelSection, defaultDetailPanelSections } from '$lib/utils/detail-panel-sections';
import { renderWithTooltips } from '$tests/helpers';

// i18n is not loaded here: translated parts come back as their keys
const setup = (hidden: string[] = []) => {
  const onChange = vi.fn();
  const onReset = vi.fn();
  const onDone = vi.fn();
  renderWithTooltips(DetailPanelSectionEditor, {
    order: defaultDetailPanelSections,
    hidden: new Set(hidden),
    onChange,
    onReset,
    onDone,
  });
  const row = (section: DetailPanelSection) => screen.getByTestId(`detail-panel-section-${section}`);
  const buttons = (section: DetailPanelSection) => row(section).querySelectorAll('button');
  return { onChange, onReset, onDone, row, buttons };
};

describe('DetailPanelSectionEditor component', () => {
  it('lists every section in order', () => {
    setup();

    const rows = screen.getAllByTestId(/^detail-panel-section-(?!editor)/);
    expect(rows.map((row) => row.dataset.testid)).toEqual(
      defaultDetailPanelSections.map((section) => `detail-panel-section-${section}`),
    );
  });

  it('moves a section up and down with the arrows', async () => {
    const { onChange, buttons } = setup();

    await fireEvent.click(buttons(DetailPanelSection.Tags)[1]);
    const up = onChange.mock.calls[0][0] as DetailPanelSection[];
    expect(up.at(-1)).toBe(DetailPanelSection.Metadata);
    expect(up.at(-2)).toBe(DetailPanelSection.Tags);

    await fireEvent.click(buttons(DetailPanelSection.Description)[2]);
    const down = onChange.mock.calls[1][0] as DetailPanelSection[];
    expect(down.slice(0, 2)).toEqual([DetailPanelSection.Rating, DetailPanelSection.Description]);
  });

  it('disables moving past the ends', () => {
    const { buttons } = setup();

    expect(buttons(DetailPanelSection.Description)[1]).toBeDisabled();
    expect(buttons(DetailPanelSection.Tags)[2]).toBeDisabled();
  });

  it('moves a section with drag and drop', async () => {
    const { onChange, row } = setup();

    await fireEvent.dragStart(row(DetailPanelSection.Tags));
    await fireEvent.dragOver(row(DetailPanelSection.Description));
    await fireEvent.drop(row(DetailPanelSection.Description));

    const order = onChange.mock.calls[0][0] as DetailPanelSection[];
    expect(order.slice(0, 2)).toEqual([DetailPanelSection.Tags, DetailPanelSection.Description]);
  });

  it('hides and shows sections', async () => {
    const { onChange, buttons } = setup([DetailPanelSection.Map]);

    await fireEvent.click(buttons(DetailPanelSection.People)[0]);
    expect(onChange.mock.calls[0][1]).toEqual([DetailPanelSection.Map, DetailPanelSection.People]);

    await fireEvent.click(buttons(DetailPanelSection.Map)[0]);
    expect(onChange.mock.calls[1][1]).toEqual([]);
  });

  it('resets and finishes', async () => {
    const { onReset, onDone } = setup();

    await fireEvent.click(screen.getByText('reset_to_default'));
    await fireEvent.click(screen.getByText('done'));

    expect(onReset).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
  });
});
