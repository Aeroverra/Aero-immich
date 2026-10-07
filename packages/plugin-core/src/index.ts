import { wrapper } from '@immich/plugin-sdk';
import { AssetVisibility } from '@immich/sdk';
import type { Manifest } from '../dist/index.d.ts';

type MatchValueConfig = {
  pattern?: string;
  matchType?: 'contains' | 'exact' | 'regex' | 'startsWith' | 'empty';
  caseSensitive?: boolean;
  inverse?: boolean;
};

const isEmptyValue = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

const matchValue = (value: string | null | undefined, config: MatchValueConfig): boolean => {
  const { pattern = '', matchType = 'contains', caseSensitive = false } = config;

  if (matchType === 'empty') {
    return isEmptyValue(value);
  }

  if (value === null || value === undefined) {
    return false;
  }

  if (matchType === 'regex') {
    // the pattern is not lowercased: that would turn escapes like \D, \S or \W into \d, \s and \w
    return new RegExp(pattern, caseSensitive ? '' : 'i').test(value);
  }

  const searchName = caseSensitive ? value : value.toLowerCase();
  const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();

  switch (matchType) {
    case 'contains': {
      return searchName.includes(searchPattern);
    }

    case 'exact': {
      return searchName === searchPattern;
    }

    case 'startsWith': {
      return searchName.startsWith(searchPattern);
    }

    default: {
      return false;
    }
  }
};

const matchValueResult = (value: string | null | undefined, config: MatchValueConfig) => ({
  workflow: { continue: matchValue(value, config) !== !!config.inverse },
});

const parseAspectRatio = (value: string | undefined) => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/i.exec(value ?? '');
  if (!match) {
    return;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : undefined;
};

type Handlers = Parameters<typeof wrapper<Manifest>>[0];

type FilterGroupStep = { method?: string; config?: Record<string, unknown> | null };

const PLUGIN_NAME = 'immich-plugin-core';

/** the methods a filter group can hold: the filters of this plugin, including other groups */
const groupFilterNames = new Set<string>([
  'assetFileFilter',
  'assetLocationFilter',
  'assetExifFilter',
  'assetOcrFilter',
  'assetDimensionFilter',
  'assetDateFilter',
  'assetMissingTimeZoneFilter',
  'assetTagFilter',
  'assetTypeFilter',
  'assetFilterGroup',
] satisfies Array<keyof Handlers>);

const handlers: Handlers = {
  assetAddTags: ({ config, data, functions }) => {
    if (config.tags.length === 0) {
      if (!config.tagName) {
        return {};
      }

      // creates the tag (and its parents) the first time, then the step keeps using its id
      const [tag] = functions.upsertTags({ tags: [config.tagName] });
      if (!tag) {
        return {};
      }

      config.tags.push(tag.id);
    }

    functions.bulkTagAssets({ assetIds: [data.asset.id], tagIds: config.tags });
    return {};
  },

  assetAddToAlbums: ({ config, data, functions }) => {
    const assetId = data.asset.id;

    if (config.albumIds.length === 0) {
      if (!config.albumName) {
        return {};
      }

      const [existing] = functions.searchAlbums({ name: config.albumName });
      if (!existing) {
        const created = functions.createAlbum({ albumName: config.albumName, assetIds: [assetId] });
        config.albumIds.push(created.id);
        return {};
      }

      config.albumIds.push(existing.id);
    }

    if (config.albumIds.length === 1) {
      functions.addAssetsToAlbum(config.albumIds[0], [assetId]);
      return {};
    }

    functions.addAssetsToAlbums({ albumIds: config.albumIds, assetIds: [assetId] });
    return {};
  },

  assetArchive: ({ config, data }) => {
    if (!config.inverse && data.asset.visibility !== AssetVisibility.Archive) {
      return { changes: { asset: { visibility: AssetVisibility.Archive } } };
    }

    if (config.inverse && data.asset.visibility === AssetVisibility.Archive) {
      return { changes: { asset: { visibility: AssetVisibility.Timeline } } };
    }

    return {};
  },

  assetFavorite: ({ config, data }) => {
    const target = config.inverse ? false : true;
    if (target !== data.asset.isFavorite) {
      return {
        changes: {
          asset: { isFavorite: target },
        },
      };
    }
  },

  assetFileFilter: ({ data, config }) =>
    matchValueResult(config.usePath ? data.asset.originalPath : data.asset.originalFileName, config),

  assetLocationFilter: ({ config, data }) => {
    if (
      (config.region?.country && config.region.country !== data.asset.exifInfo?.country) ||
      (config.region?.state && config.region.state !== data.asset.exifInfo?.state) ||
      (config.region?.city && config.region.city !== data.asset.exifInfo?.city)
    ) {
      return { workflow: { continue: false } };
    }

    const configLat = config.coordinate?.latitude;
    const configLon = config.coordinate?.longitude;

    if (configLat === undefined || configLon === undefined) {
      return { workflow: { continue: true } };
    }

    const assetLat = data.asset.exifInfo?.latitude;
    const assetLon = data.asset.exifInfo?.longitude;

    if (assetLat === undefined || assetLat === null || assetLon === undefined || assetLon === null) {
      return { workflow: { continue: false } };
    }

    const earthDiameter = 12742;
    const deg = Math.PI / 180;
    const delta = Math.asin(
      Math.sqrt(
        Math.pow(Math.sin((assetLat * deg - configLat * deg) / 2), 2) +
          Math.cos(assetLat * deg) *
            Math.cos(configLat * deg) *
            Math.pow(Math.sin((assetLon * deg - configLon * deg) / 2), 2),
      ),
    );

    return { workflow: { continue: earthDiameter * delta <= (config.coordinate?.radius ?? 0) } };
  },

  assetExifFilter: ({ config, data }) => {
    const value = data.asset.exifInfo?.[config.property];
    return matchValueResult(value === null || value === undefined ? value : String(value), config);
  },

  assetOcrFilter: ({ config, data }) => {
    const minY = config.minY ?? 0;
    const maxY = config.maxY ?? 1;
    const lines = (data.asset.ocr ?? [])
      .filter((line) => {
        // where the top edge of the text is, from 0 (top of the image) to 1 (bottom)
        const top = Math.min(line.y1, line.y2, line.y3, line.y4);
        return top >= minY && top <= maxY;
      })
      .map(({ text }) => text);

    let matched: boolean;
    switch (config.matchType ?? 'contains') {
      case 'exact':
      case 'startsWith': {
        matched = lines.some((line) => matchValue(line.trim(), config));
        break;
      }

      case 'empty': {
        matched = lines.every((line) => isEmptyValue(line));
        break;
      }

      default: {
        matched = lines.length > 0 && matchValue(lines.join('\n'), config);
      }
    }

    return { workflow: { continue: matched !== !!config.inverse } };
  },

  assetDimensionFilter: ({ config, data }) => {
    const width = data.asset.width ?? data.asset.exifInfo?.exifImageWidth;
    const height = data.asset.height ?? data.asset.exifInfo?.exifImageHeight;

    let matched = !!width && !!height;
    if (matched && width && height) {
      const orientation = config.orientation ?? 'any';
      if (orientation === 'portrait') {
        matched = height > width;
      } else if (orientation === 'landscape') {
        matched = width > height;
      } else if (orientation === 'square') {
        matched = width === height;
      }

      const ratio = parseAspectRatio(config.aspectRatio);
      if (matched && ratio) {
        const tolerance = (config.tolerance ?? 1) / 100;
        matched = Math.abs(width / height / ratio - 1) <= tolerance;
      }
    }

    return { workflow: { continue: matched !== !!config.inverse } };
  },

  assetFilterGroup: (payload) => {
    const filters = (payload.config.filters ?? []) as FilterGroupStep[];
    const passes = ({ method = '', config }: FilterGroupStep) => {
      const [pluginName, methodName] = method.split('#');
      if (pluginName !== PLUGIN_NAME || !groupFilterNames.has(methodName)) {
        throw new Error(`A filter group can only hold filters of ${PLUGIN_NAME}, not "${method}"`);
      }

      const handler = handlers[methodName as keyof Handlers] as (
        input: typeof payload,
      ) => ReturnType<Handlers['assetFilterGroup']>;
      const response = handler({ ...payload, config: (config ?? {}) as typeof payload.config });
      return response?.workflow?.continue !== false;
    };

    // like a workflow without filters, a group without filters lets every asset through
    let matched = true;
    if (filters.length > 0) {
      switch (payload.config.mode ?? 'any') {
        case 'all': {
          matched = filters.every((filter) => passes(filter));
          break;
        }

        case 'none': {
          matched = !filters.some((filter) => passes(filter));
          break;
        }

        default: {
          matched = filters.some((filter) => passes(filter));
        }
      }
    }

    return { workflow: { continue: matched } };
  },

  assetDateFilter: ({ config, data }) => {
    const assetDate = new Date(data.asset.localDateTime);
    let startDate = new Date(config.startDate.year, config.startDate.month - 1, config.startDate.day);
    let endDate = new Date(config.endDate.year, config.endDate.month - 1, config.endDate.day + 1);

    if (config.recurring) {
      startDate.setFullYear(assetDate.getFullYear());
      endDate.setFullYear(assetDate.getFullYear());

      if (endDate < startDate) {
        if (assetDate > endDate) {
          endDate.setFullYear(endDate.getFullYear() + 1);
        } else {
          startDate.setFullYear(startDate.getFullYear() - 1);
        }
      }
    }

    return { workflow: { continue: assetDate >= startDate && assetDate < endDate } };
  },

  assetLock: ({ config, data }) => {
    if (!config.inverse && data.asset.visibility !== AssetVisibility.Locked) {
      return { changes: { asset: { visibility: AssetVisibility.Locked } } };
    }

    if (config.inverse && data.asset.visibility === AssetVisibility.Locked) {
      return { changes: { asset: { visibility: AssetVisibility.Timeline } } };
    }

    return {};
  },

  assetMissingTimeZoneFilter: ({ config, data }) => {
    const hasTimeZone = !!data.asset?.exifInfo?.timeZone;
    const needsTimeZone = config.inverse ? true : false;
    return { workflow: { continue: hasTimeZone === needsTimeZone } };
  },

  assetTagFilter: ({ config, data }) => {
    const assetTags = data.asset.tags.map((tag) => tag.id);

    for (const tag of config.tags) {
      if (assetTags.includes(tag)) {
        if (config.matching === 'any') {
          break;
        } else if (config.matching === 'none') {
          return { workflow: { continue: false } };
        }
      } else if (config.matching === 'all') {
        return { workflow: { continue: false } };
      }
    }

    return { workflow: { continue: true } };
  },

  assetTypeFilter: ({ config, data }) => {
    return { workflow: { continue: config.allowedTypes.includes(data.asset.type) } };
  },

  assetVisibility: ({ config }) => ({
    changes: { asset: { visibility: config.visibility as AssetVisibility } },
  }),

  webhook: ({ config, data, functions, type, trigger }) => {
    const headers: Record<string, string> = {};

    if (config.headerName && config.headerValue) {
      headers[config.headerName] = config.headerValue;
    }

    headers['Content-Type'] = 'application/json';

    functions.httpRequest(config.url, {
      method: config.method ?? 'POST',
      body: JSON.stringify({
        type,
        trigger,
        data,
      }),
      headers,
    });

    return {};
  },
};

const methods = wrapper<Manifest>(handlers);

const {
  assetAddTags,
  assetAddToAlbums,
  assetArchive,
  assetFavorite,
  assetFileFilter,
  assetLocationFilter,
  assetExifFilter,
  assetOcrFilter,
  assetDimensionFilter,
  assetFilterGroup,
  assetDateFilter,
  assetLock,
  assetMissingTimeZoneFilter,
  assetTagFilter,
  assetTypeFilter,
  assetVisibility,
  webhook,

  // should be empty. ensures that every field is destructured
  ...rest
} = methods;

export {
  assetAddTags,
  assetAddToAlbums,
  assetArchive,
  assetFavorite,
  assetFileFilter,
  assetLocationFilter,
  assetExifFilter,
  assetOcrFilter,
  assetDimensionFilter,
  assetFilterGroup,
  assetDateFilter,
  assetLock,
  assetMissingTimeZoneFilter,
  assetTagFilter,
  assetTypeFilter,
  assetVisibility,
  webhook,
};

'All methods must be destructured and exported' satisfies string & typeof rest;
