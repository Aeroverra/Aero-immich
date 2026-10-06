import { PersonSuggestionKind } from 'src/enum';

/**
 * How the person suggestions job finds pairs worth asking about. Similarities are cosine similarities of face
 * embeddings. On a family library (buffalo_l) the averages of two clusters that split one person were 0.35 to 0.82
 * alike and those of different people -0.1 to 0.3; the mean of a face's five best matches in a person was right about
 * nine times in ten from 0.52 and wrong one time in seven between 0.45 and 0.50.
 */
export const PERSON_SUGGESTION = {
  /** faces whose embedding is shorter than this share of the median are left out (backs of heads, upside-down) */
  minNormShare: 0.7,
  /** faces whose box is smaller than this share of the picture are left out, they are too small to judge */
  minFaceSize: 0.025,
  /** pairs whose averages are less alike than this are not looked at closer */
  shortlist: 0.15,
  /** faces of an unnamed person compared one by one, spread over time (each is a vector index search, about 15 ms) */
  facesPerPerson: 8,
  /** nearest faces looked at for each compared face */
  neighbors: 32,
  /** best face matches averaged per compared face */
  topK: 5,
  /** taken off the score when the target is already in every one of the candidate's pictures */
  sharedPenalty: 0.2,
  /** a second named person is asked about too when it scores this close to the best one (look-alikes) */
  runnerUpMargin: 0.1,
  /** questions kept per user, the most valuable ones */
  maxPending: 1000,
  /** "not sure" answers are asked again after this many days */
  skippedDays: 7,
  /** recency halves the value of a question about every this many years */
  recencyYears: 3,
} as const;

/** The mean of the `k` best similarities; when fewer were found, the rest count as `fill` (no better than the worst seen) */
export const getTopMean = (similarities: number[], k: number, fill: number) => {
  if (k <= 0) {
    return 0;
  }

  const best = similarities.toSorted((a, b) => b - a).slice(0, k);
  while (best.length < k) {
    best.push(fill);
  }

  return best.reduce((sum, value) => sum + value, 0) / k;
};

export type NeighborFace = { personGroupId: string; assetId: string; similarity: number };

/**
 * How alike a candidate is to a target, judged face by face: for each compared face of the candidate, the mean of its
 * best matches among the target's faces (up to `topK`, fewer when the target has fewer faces), averaged over the
 * compared faces. `neighbors` holds the nearest faces found for each compared face, best first.
 */
export const getFaceMatchScore = (
  neighbors: NeighborFace[][],
  targetPersonGroupId: string,
  targetFaces: number,
  topK: number = PERSON_SUGGESTION.topK,
) => {
  if (neighbors.length === 0) {
    return 0;
  }

  const k = Math.max(1, Math.min(topK, targetFaces));
  let total = 0;
  for (const nearest of neighbors) {
    const similarities = nearest
      .filter((neighbor) => neighbor.personGroupId === targetPersonGroupId)
      .map((neighbor) => neighbor.similarity);
    // a target face that is not among the nearest is at most as alike as the last face that is
    const worst = nearest.length > 0 ? Math.min(...nearest.map((neighbor) => neighbor.similarity)) : 0;
    total += getTopMean(similarities, k, Math.max(0, worst));
  }

  return total / neighbors.length;
};

/** The score of a pair: face-to-face matches and the likeness of the averages count the same */
export const getSuggestionScore = ({
  faceMatch,
  centroid,
  sharedAssetShare,
}: {
  faceMatch: number;
  centroid: number;
  sharedAssetShare: number;
}) => (faceMatch + centroid) / 2 - PERSON_SUGGESTION.sharedPenalty * sharedAssetShare;

/**
 * How much answering is worth: the photos the answer names (or brings together), how many different days they are
 * from (someone who keeps coming back matters more than a face in one crowd), and how recent they are; weighed by how
 * likely the answer is yes.
 */
export const getSuggestionPriority = ({
  kind,
  assets,
  days,
  latest,
  score,
  now = new Date(),
}: {
  kind: PersonSuggestionKind;
  assets: number;
  days: number;
  latest: Date | null;
  score: number;
  now?: Date;
}) => {
  const years = latest ? Math.max(0, (now.getTime() - latest.getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : 10;
  const recency = Math.pow(0.5, years / PERSON_SUGGESTION.recencyYears);
  const value = Math.log1p(Math.max(0, assets)) + 0.5 * Math.log1p(Math.max(0, days)) + recency;
  // bringing two unnamed people together names nobody yet
  const weight = kind === PersonSuggestionKind.Unnamed ? 0.75 : 1;
  return value * weight * Math.max(0, score);
};

/** Of the targets a candidate may be, the ones worth asking about: the best, and a close runner-up (look-alikes) */
export const pickTargets = <T extends { score: number }>(
  targets: T[],
  margin: number = PERSON_SUGGESTION.runnerUpMargin,
) => {
  const sorted = targets.toSorted((a, b) => b.score - a.score);
  const [best, second] = sorted;
  if (!best) {
    return [];
  }

  return second && best.score - second.score <= margin ? [best, second] : [best];
};
