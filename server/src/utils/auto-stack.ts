import { AssetType, AssetVisibility } from 'src/enum';

/**
 * Automatic stacks group near-identical photos taken seconds apart with the same camera, the way a phone gallery
 * collapses a burst of shots. Everything in this file is pure so the grouping and the choice of the cover photo can
 * be tested without a database.
 */

/** how long a new upload waits before its neighbourhood is evaluated, so the rest of a burst can arrive */
export const AUTO_STACK_UPLOAD_DELAY = 30_000;

export type AutoStackOptions = {
  /** Largest time between two consecutive photos of a stack */
  maxGapSeconds: number;
  /** Largest time between the first and the last photo of a stack */
  maxSpanSeconds: number;
  /** Most photos in one stack */
  maxAssets: number;
  /** Largest smart search (CLIP) cosine distance between any two photos of a stack */
  maxDistance: number;
  /** Largest movement of the biggest face between two photos, as a fraction of the frame */
  maxFaceShift: number;
  /** Largest relative change of the width of the biggest face */
  maxFaceSizeChange: number;
  /** Largest difference in head yaw of the biggest face, in degrees */
  maxYawChange: number;
  /** Largest difference in the smile score (0-1) of the biggest face; a change of expression is a different shot */
  maxSmileChange: number;
};

export type AutoStackFace = {
  personGroupId: string | null;
  imageWidth: number;
  imageHeight: number;
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
  /** false or null when no landmarks could be read for the face */
  detected?: boolean | null;
  eyeBlinkLeft?: number | null;
  eyeBlinkRight?: number | null;
  smile?: number | null;
  yaw?: number | null;
  sharpness?: number | null;
};

export type AutoStackAsset = {
  id: string;
  /** capture time, `asset.fileCreatedAt` */
  capturedAt: Date;
  originalFileName: string;
  make: string | null;
  model: string | null;
  type: AssetType;
  visibility: AssetVisibility;
  isFavorite: boolean;
  /** normalized smart search embedding, see `parseEmbedding` */
  embedding: Float32Array | null;
  faces: AutoStackFace[];
  /** image sharpness (variance of the Laplacian), larger is sharper */
  sharpness?: number | null;
  /** fraction of pixels that are clipped to black or white */
  exposureClipped?: number | null;
  /**
   * The job must not move this asset: it is in a stack the job does not own (manual or edited by the user)
   * or the user took it out of an automatic stack before.
   */
  isLocked: boolean;
};

export type AutoStackGroup = {
  /** the primary asset (top pick) first, the rest in capture order */
  assetIds: string[];
};

export type AutoStackExistingStack = {
  id: string;
  primaryAssetId: string;
  assetIds: string[];
};

export type AutoStackPlan = {
  create: AutoStackGroup[];
  delete: string[];
  update: Array<{ id: string; primaryAssetId: string }>;
};

export enum AutoStackSkipReason {
  NotImage = 'not-image',
  Visibility = 'visibility',
  UnknownCamera = 'unknown-camera',
  Screenshot = 'screenshot',
  MessagingApp = 'messaging-app',
  NoEmbedding = 'no-embedding',
  Locked = 'locked',
}

export enum AutoStackSplitReason {
  TimeGap = 'time-gap',
  Span = 'span',
  MaxAssets = 'max-assets',
  Visibility = 'visibility',
  LooksDifferent = 'looks-different',
  PeopleChanged = 'people-changed',
  FaceMoved = 'face-moved',
  FaceSizeChanged = 'face-size-changed',
  HeadTurned = 'head-turned',
  ExpressionChanged = 'expression-changed',
}

const SCREENSHOT_PATTERN = /^screenshot/i;
/** files saved from messaging apps carry no burst information even when the camera metadata survived */
const MESSAGING_APP_PATTERN = /snapchat|^IMG-\d{8}-WA|messenger|FB_IMG|received_/i;

/** a face count may fluctuate in group photos, so a different count only splits small groups */
const MAX_FACES_FOR_COUNT_SPLIT = 4;

const EYES_CLOSED_BLINK = 0.5;
const CLOSED_EYES_PENALTY = 1;
const FAVORITE_BONUS = 10;
const FRONTAL_MAX_YAW = 45;
const DEFAULT_EYES_OPEN = 0.5;
const DEFAULT_SMILE = 0.3;
const DEFAULT_FRONTAL = 0.5;

export const parseEmbedding = (embedding: string | number[] | null | undefined): Float32Array | null => {
  if (!embedding) {
    return null;
  }

  const values = Float32Array.from(typeof embedding === 'string' ? (JSON.parse(embedding) as number[]) : embedding);
  let norm = 0;
  for (const value of values) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) {
    return null;
  }

  for (let i = 0; i < values.length; i++) {
    values[i] /= norm;
  }

  return values;
};

/** cosine distance of two normalized embeddings, the same value as pgvector's `<=>` */
export const getCosineDistance = (a: Float32Array, b: Float32Array) => {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
  }
  return 1 - dot;
};

export const getCameraKey = ({ make, model }: Pick<AutoStackAsset, 'make' | 'model'>) =>
  make && model ? `${make}|${model}` : null;

export const getAutoStackSkipReason = (asset: AutoStackAsset): AutoStackSkipReason | null => {
  if (asset.type !== AssetType.Image) {
    return AutoStackSkipReason.NotImage;
  }

  if (asset.visibility !== AssetVisibility.Timeline && asset.visibility !== AssetVisibility.Archive) {
    return AutoStackSkipReason.Visibility;
  }

  if (!getCameraKey(asset)) {
    return AutoStackSkipReason.UnknownCamera;
  }

  if (SCREENSHOT_PATTERN.test(asset.originalFileName)) {
    return AutoStackSkipReason.Screenshot;
  }

  if (MESSAGING_APP_PATTERN.test(asset.originalFileName)) {
    return AutoStackSkipReason.MessagingApp;
  }

  if (!asset.embedding) {
    return AutoStackSkipReason.NoEmbedding;
  }

  if (asset.isLocked) {
    return AutoStackSkipReason.Locked;
  }

  return null;
};

type FaceGeometry = { centerX: number; centerY: number; width: number; area: number };

const getFaceGeometry = (face: AutoStackFace): FaceGeometry => {
  const imageWidth = face.imageWidth || 1;
  const imageHeight = face.imageHeight || 1;
  const width = (face.boundingBoxX2 - face.boundingBoxX1) / imageWidth;
  const height = (face.boundingBoxY2 - face.boundingBoxY1) / imageHeight;
  return {
    centerX: (face.boundingBoxX1 + face.boundingBoxX2) / 2 / imageWidth,
    centerY: (face.boundingBoxY1 + face.boundingBoxY2) / 2 / imageHeight,
    width,
    area: width * height,
  };
};

const getLargestFace = (faces: AutoStackFace[]) => {
  let largest: { face: AutoStackFace; geometry: FaceGeometry } | undefined;
  for (const face of faces) {
    const geometry = getFaceGeometry(face);
    if (!largest || geometry.area > largest.geometry.area) {
      largest = { face, geometry };
    }
  }
  return largest;
};

const getPeople = (faces: AutoStackFace[]) =>
  new Set(faces.map(({ personGroupId }) => personGroupId).filter((id): id is string => !!id));

const isSameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((value) => b.has(value));

const hasLandmarks = (face: AutoStackFace) => face.detected === true;

/**
 * Why two photos cannot be in the same stack, or null when they can. The check is symmetric and is run against every
 * member of a stack (complete linkage), so a stack never drifts from its first photo to a different shot.
 */
export const getAutoStackPairSplitReason = (
  a: AutoStackAsset,
  b: AutoStackAsset,
  options: AutoStackOptions,
): AutoStackSplitReason | null => {
  if (a.visibility !== b.visibility) {
    return AutoStackSplitReason.Visibility;
  }

  if (!a.embedding || !b.embedding || getCosineDistance(a.embedding, b.embedding) > options.maxDistance) {
    return AutoStackSplitReason.LooksDifferent;
  }

  if (a.faces.length !== b.faces.length && Math.max(a.faces.length, b.faces.length) <= MAX_FACES_FOR_COUNT_SPLIT) {
    return AutoStackSplitReason.PeopleChanged;
  }

  if (!isSameSet(getPeople(a.faces), getPeople(b.faces))) {
    return AutoStackSplitReason.PeopleChanged;
  }

  const faceA = getLargestFace(a.faces);
  const faceB = getLargestFace(b.faces);
  if (faceA && faceB) {
    const shift = Math.hypot(
      faceA.geometry.centerX - faceB.geometry.centerX,
      faceA.geometry.centerY - faceB.geometry.centerY,
    );
    if (shift > options.maxFaceShift) {
      return AutoStackSplitReason.FaceMoved;
    }

    const maxWidth = Math.max(faceA.geometry.width, faceB.geometry.width);
    if (maxWidth > 0 && Math.abs(faceA.geometry.width - faceB.geometry.width) / maxWidth > options.maxFaceSizeChange) {
      return AutoStackSplitReason.FaceSizeChanged;
    }

    if (
      hasLandmarks(faceA.face) &&
      hasLandmarks(faceB.face) &&
      typeof faceA.face.yaw === 'number' &&
      typeof faceB.face.yaw === 'number' &&
      Math.abs(faceA.face.yaw - faceB.face.yaw) > options.maxYawChange
    ) {
      return AutoStackSplitReason.HeadTurned;
    }

    // blinks never split: a frame with closed eyes stays in the stack so the top pick can pass over it
    if (
      hasLandmarks(faceA.face) &&
      hasLandmarks(faceB.face) &&
      typeof faceA.face.smile === 'number' &&
      typeof faceB.face.smile === 'number' &&
      Math.abs(faceA.face.smile - faceB.face.smile) > options.maxSmileChange
    ) {
      return AutoStackSplitReason.ExpressionChanged;
    }
  }

  return null;
};

const compareCapture = (a: AutoStackAsset, b: AutoStackAsset) =>
  a.capturedAt.getTime() - b.capturedAt.getTime() ||
  a.originalFileName.localeCompare(b.originalFileName) ||
  a.id.localeCompare(b.id);

/**
 * Groups photos into automatic stacks. Photos are walked in capture order per camera; a photo joins the open stack
 * when it follows the previous photo closely, stays inside the span and cap, and is compatible with every member.
 * Skipped photos (videos, screenshots, locked assets, ...) end the open stack. Only groups of two or more are returned,
 * with the top pick first.
 */
export const groupAutoStackAssets = (assets: AutoStackAsset[], options: AutoStackOptions): AutoStackGroup[] => {
  const byCamera = new Map<string, AutoStackAsset[]>();
  for (const asset of assets) {
    const key = getCameraKey(asset);
    if (!key) {
      continue;
    }
    const list = byCamera.get(key) ?? [];
    list.push(asset);
    byCamera.set(key, list);
  }

  const groups: AutoStackAsset[][] = [];
  const maxGap = options.maxGapSeconds * 1000;
  const maxSpan = options.maxSpanSeconds * 1000;

  for (const key of byCamera.keys().toArray().sort()) {
    const list = byCamera.get(key)!.sort(compareCapture);
    let current: AutoStackAsset[] = [];
    const close = () => {
      if (current.length >= 2) {
        groups.push(current);
      }
      current = [];
    };

    for (const asset of list) {
      if (getAutoStackSkipReason(asset)) {
        close();
        continue;
      }

      if (current.length === 0) {
        current = [asset];
        continue;
      }

      const first = current[0];
      const last = current.at(-1)!;
      let reason: AutoStackSplitReason | null = null;
      if (asset.capturedAt.getTime() - last.capturedAt.getTime() > maxGap) {
        reason = AutoStackSplitReason.TimeGap;
      } else if (asset.capturedAt.getTime() - first.capturedAt.getTime() > maxSpan) {
        reason = AutoStackSplitReason.Span;
      } else if (current.length >= options.maxAssets) {
        reason = AutoStackSplitReason.MaxAssets;
      } else {
        for (const member of current) {
          reason = getAutoStackPairSplitReason(asset, member, options);
          if (reason) {
            break;
          }
        }
      }

      if (reason) {
        close();
        current = [asset];
      } else {
        current.push(asset);
      }
    }

    close();
  }

  return groups.map((group) => {
    const primaryId = pickAutoStackPrimary(group);
    return { assetIds: [primaryId, ...group.map(({ id }) => id).filter((id) => id !== primaryId)] };
  });
};

const normalize = (values: Array<number | null>) => {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (present.length === 0) {
    return values.map(() => 0.5);
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min;
  return values.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0;
    }
    return range > 1e-9 ? (value - min) / range : 0.5;
  });
};

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

const getExposure = ({ exposureClipped }: AutoStackAsset) =>
  typeof exposureClipped === 'number' ? 1 - exposureClipped : null;

/**
 * Scores every photo of a stack; the highest score becomes the cover.
 *
 * With faces in every photo: 0.35 eyes open + 0.15 smile + 0.20 face sharpness + 0.10 frontal + 0.10 sharpness
 * + 0.05 exposure + 0.05 face size, minus 1 when any face blinks. Without faces: 0.6 sharpness + 0.25 exposure
 * + 0.15 closeness to the middle photo. Sharpness, exposure and face size are normalized within the stack.
 * Favorites always win.
 */
export const scoreAutoStackAssets = (assets: AutoStackAsset[]): Map<string, number> => {
  const ordered = [...assets].sort(compareCapture);
  const sharpness = normalize(ordered.map((asset) => asset.sharpness ?? null));
  const exposure = normalize(ordered.map((asset) => getExposure(asset)));
  const scores = new Map<string, number>();

  if (ordered.every(({ faces }) => faces.length > 0)) {
    const faceSharpness = normalize(
      ordered.map(({ faces }) => {
        const values = faces
          .map((face) => face.sharpness)
          .filter((value): value is number => typeof value === 'number');
        return values.length > 0 ? mean(values) : null;
      }),
    );
    const faceSize = normalize(
      ordered.map(({ faces }) => Math.max(...faces.map((face) => getFaceGeometry(face).width))),
    );

    for (const [index, asset] of ordered.entries()) {
      const read = asset.faces.filter((face) => hasLandmarks(face));
      const blinks = read.map((face) => Math.max(face.eyeBlinkLeft ?? 0, face.eyeBlinkRight ?? 0));
      const maxBlink = blinks.length > 0 ? Math.max(...blinks) : null;
      const eyesOpen = maxBlink === null ? DEFAULT_EYES_OPEN : 1 - maxBlink;
      const smiles = read.map((face) => face.smile).filter((value): value is number => typeof value === 'number');
      const smile = smiles.length > 0 ? mean(smiles) : DEFAULT_SMILE;
      const yaws = read.map((face) => face.yaw).filter((value): value is number => typeof value === 'number');
      const frontal =
        yaws.length > 0 ? 1 - Math.min(1, mean(yaws.map((yaw) => Math.abs(yaw))) / FRONTAL_MAX_YAW) : DEFAULT_FRONTAL;
      const closedEyes = maxBlink !== null && maxBlink > EYES_CLOSED_BLINK;

      const score =
        0.35 * eyesOpen +
        0.15 * smile +
        0.2 * faceSharpness[index] +
        0.1 * frontal +
        0.1 * sharpness[index] +
        0.05 * exposure[index] +
        0.05 * faceSize[index] -
        (closedEyes ? CLOSED_EYES_PENALTY : 0);
      scores.set(asset.id, score + (asset.isFavorite ? FAVORITE_BONUS : 0));
    }
  } else {
    const middle = (ordered.length - 1) / 2;
    for (const [index, asset] of ordered.entries()) {
      const centered = 1 - Math.abs(index - middle) / Math.max(middle, 1);
      const score = 0.6 * sharpness[index] + 0.25 * exposure[index] + 0.15 * centered;
      scores.set(asset.id, score + (asset.isFavorite ? FAVORITE_BONUS : 0));
    }
  }

  return scores;
};

/** the id of the photo that should be the cover of a stack; ties go to the earliest photo */
export const pickAutoStackPrimary = (assets: AutoStackAsset[]): string => {
  const scores = scoreAutoStackAssets(assets);
  let best: AutoStackAsset | undefined;
  for (const asset of [...assets].sort(compareCapture)) {
    if (!best || scores.get(asset.id)! > scores.get(best.id)! + 1e-9) {
      best = asset;
    }
  }
  return best!.id;
};

const toMemberKey = (ids: string[]) => [...ids].sort().join(',');

/**
 * Compares freshly computed groups with the automatic stacks the job already owns in the same neighbourhood.
 * An identical member set keeps its stack (the cover follows the top pick), anything else is replaced.
 */
export const planAutoStackChanges = (groups: AutoStackGroup[], existing: AutoStackExistingStack[]): AutoStackPlan => {
  const plan: AutoStackPlan = { create: [], delete: [], update: [] };
  const existingByKey = new Map(existing.map((stack) => [toMemberKey(stack.assetIds), stack]));
  const kept = new Set<string>();

  for (const group of groups) {
    const stack = existingByKey.get(toMemberKey(group.assetIds));
    if (!stack || kept.has(stack.id)) {
      plan.create.push(group);
      continue;
    }

    kept.add(stack.id);
    if (stack.primaryAssetId !== group.assetIds[0]) {
      plan.update.push({ id: stack.id, primaryAssetId: group.assetIds[0] });
    }
  }

  for (const stack of existing) {
    if (!kept.has(stack.id)) {
      plan.delete.push(stack.id);
    }
  }

  return plan;
};
