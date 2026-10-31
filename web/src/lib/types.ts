import type { QueueResponseDto } from '@immich/sdk';
import type { ActionItem } from '@immich/ui';
import type { DateTime } from 'luxon';
import type { SvelteSet } from 'svelte/reactivity';
import { MediaType } from '$lib/constants';

export type LatLng = { lng: number; lat: number };

export type QueueSnapshot = { timestamp: number; snapshot?: QueueResponseDto[] };

export type HeaderButtonActionItem = ActionItem & { data?: { title?: string } };

export enum UploadState {
  PENDING,
  STARTED,
  DONE,
  ERROR,
  DUPLICATED,
}

export type UploadAsset = {
  id: string;
  file: File;
  assetId?: string;
  isTrashed?: boolean;
  albumId?: string;
  progress?: number;
  state?: UploadState;
  startDate?: number;
  eta?: number;
  speed?: number;
  error?: unknown;
  message?: string;
};

export enum OnboardingRole {
  SERVER = 'server',
  USER = 'user',
}

export type SearchCameraFilter = {
  make?: string;
  model?: string;
  lensModel?: string;
};

export type SearchDateFilter = {
  takenBefore?: DateTime;
  takenAfter?: DateTime;
  /** upload date: the Google Photos upload time for Google Photos imports, else when the asset reached Immich */
  uploadedBefore?: DateTime;
  uploadedAfter?: DateTime;
};

export type SearchDisplayFilters = {
  isNotInAlbum: boolean;
  isArchive: boolean;
  isFavorite: boolean;
};

export type SearchLocationFilter = {
  country?: string;
  state?: string;
  city?: string;
};

export type SearchFilter = {
  query: string;
  ocr?: string;
  queryType: 'smart' | 'metadata' | 'description' | 'fullPath' | 'ocr';
  personIds: SvelteSet<string>;
  /** with people picked: true = nobody else in the asset, false = someone else too; faces without a name count */
  onlyPersonIds?: boolean;
  /** true = assets with a face, false = without any (the picked people and other face options do not apply) */
  hasPeople?: boolean;
  /** true = someone named in the asset, false = nobody named, faces or not (the picked people do not apply) */
  hasNamedFaces?: boolean;
  /** true = a face nobody has named, false = no such face */
  hasUnnamedFaces?: boolean;
  tagIds: SvelteSet<string> | null;
  /** assets with any of these tags (or their child tags) are left out */
  excludeTagIds: SvelteSet<string>;
  /** only assets in all of these albums */
  albumIds: SvelteSet<string>;
  /** assets in any of these albums are left out */
  excludeAlbumIds: SvelteSet<string>;
  location: SearchLocationFilter;
  queryAssetId?: string;
  camera: SearchCameraFilter;
  date: SearchDateFilter;
  display: SearchDisplayFilters;
  mediaType: MediaType;
  /** video length bounds in milliseconds; either one keeps the search to videos */
  minDuration?: number;
  maxDuration?: number;
  rating?: number | null;
  /** true = only private assets, false = exclude private assets, undefined = all (only meaningful while private mode is on) */
  isPrivate?: boolean;
};

export type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object';

export type JSONSchemaProperty = {
  type: JSONSchemaType;
  title?: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default?: any;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  precision?: number;
  array?: boolean;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  uiHint?: {
    type?: 'AlbumId' | 'AssetId' | 'PersonId' | 'TagId';
    order?: number;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SchemaConfig = any;
