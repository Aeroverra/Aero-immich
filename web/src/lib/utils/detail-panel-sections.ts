export enum DetailPanelSection {
  Description = 'description',
  Rating = 'rating',
  Bookmarks = 'bookmarks',
  People = 'people',
  Details = 'details',
  Map = 'map',
  SharedBy = 'shared-by',
  Albums = 'albums',
  Metadata = 'metadata',
  Tags = 'tags',
}

/** The order the asset viewer info panel has always used. */
export const defaultDetailPanelSections: DetailPanelSection[] = [
  DetailPanelSection.Description,
  DetailPanelSection.Rating,
  DetailPanelSection.Bookmarks,
  DetailPanelSection.People,
  DetailPanelSection.Details,
  DetailPanelSection.Map,
  DetailPanelSection.SharedBy,
  DetailPanelSection.Albums,
  DetailPanelSection.Metadata,
  DetailPanelSection.Tags,
];

export interface DetailPanelSettings {
  /** section ids in the order the user picked, empty for the default order */
  order: string[];
  /** section ids the user hid */
  hidden: string[];
}

export const defaultDetailPanelSettings: DetailPanelSettings = { order: [], hidden: [] };

const isSection = (id: string): id is DetailPanelSection => (defaultDetailPanelSections as string[]).includes(id);

/** The hidden sections of saved settings, ignoring anything that is not a list of ids. */
export const getHiddenDetailPanelSections = (saved: unknown): Set<string> =>
  new Set(Array.isArray(saved) ? saved.map(String) : []);

/**
 * Resolves a saved order against the known sections. Ids that are no longer known are skipped, and sections
 * the saved order does not mention yet (added after it was saved) go in right after the section that comes
 * before them in the default order, so a new section never disappears.
 */
export const getDetailPanelSectionOrder = (saved: unknown): DetailPanelSection[] => {
  const known = Array.isArray(saved) ? saved.filter((id): id is DetailPanelSection => isSection(String(id))) : [];
  const order = [...new Set(known)];

  for (const [index, section] of defaultDetailPanelSections.entries()) {
    if (order.includes(section)) {
      continue;
    }

    const previous = defaultDetailPanelSections.slice(0, index).findLast((id) => order.includes(id));
    order.splice(previous ? order.indexOf(previous) + 1 : 0, 0, section);
  }

  return order;
};

/** Moves a section to a new index, keeping the rest of the order. */
export const moveDetailPanelSection = (
  order: DetailPanelSection[],
  section: DetailPanelSection,
  index: number,
): DetailPanelSection[] => {
  const from = order.indexOf(section);
  const to = Math.max(0, Math.min(order.length - 1, index));
  if (from === -1 || from === to) {
    return order;
  }

  const result = order.filter((id) => id !== section);
  result.splice(to, 0, section);
  return result;
};

/** Stores the order the user picked; the default order is stored as an empty list so later sections slot in. */
export const toDetailPanelSettings = (order: DetailPanelSection[], hidden: Iterable<string>): DetailPanelSettings => {
  const isDefault = order.every((section, index) => section === defaultDetailPanelSections[index]);
  return { order: isDefault ? [] : [...order], hidden: [...new Set(hidden)] };
};
