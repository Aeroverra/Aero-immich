import { CounterRow, TakeoutCounters } from 'src/takeout/types';

export function emptyCounters(): TakeoutCounters {
  return {
    scanned: {
      files: 0,
      images: 0,
      videos: 0,
      assetJsons: 0,
      albumJsons: 0,
      unknownJsons: 0,
      useless: 0,
      unsupported: 0,
      banned: 0,
      sidecars: 0,
    },
    matched: { fastTrack: 0, normal: 0, forgottenDuplicates: 0, edited: 0, missingMetadata: 0 },
    discarded: {
      localDuplicates: 0,
      duplicatedInDirectory: 0,
      filteredPartner: 0,
      filteredTrashed: 0,
      filteredArchived: 0,
      filteredDateRange: 0,
      notSelected: 0,
      rotateOnlyDropped: 0,
      failedVideos: 0,
      previouslyDeleted: 0,
      unreadable: 0,
      missingFromArchive: 0,
    },
    result: {
      toUpload: 0,
      uploaded: 0,
      serverDuplicates: 0,
      betterOnServer: 0,
      alreadyProcessed: 0,
      largerUploaded: 0,
      stacked: 0,
      albumsCreated: 0,
      albumAdds: 0,
      tagged: 0,
      metadataSaved: 0,
      rotationsQueued: 0,
      rotationsApplied: 0,
      zoneAssumed: 0,
      datesFromGoogle: 0,
      errors: 0,
    },
    bytes: { total: 0, done: 0 },
  };
}

// Actions of a media file that ends up as (or on) an asset.
const IMPORTED_ACTIONS = new Set(['upload', 'serverDuplicate', 'betterOnServer']);

// Derives every counter from grouped report rows (section 2.9). B never computes counters itself.
export function countersFromRows(rows: CounterRow[], bytes: { total: number; done: number }): TakeoutCounters {
  const c = emptyCounters();
  c.bytes = { ...bytes };

  for (const row of rows) {
    const n = row.count;
    switch (row.fileKind) {
      case 'image': {
        c.scanned.images += n;
        c.scanned.files += n;
        break;
      }
      case 'video': {
        c.scanned.videos += n;
        c.scanned.files += n;
        break;
      }
      case 'sidecar': {
        c.scanned.sidecars += n;
        break;
      }
      // no default
    }

    switch (row.action) {
      case 'assetJson': {
        c.scanned.assetJsons += n;
        break;
      }
      case 'assetJsonUnused': {
        c.scanned.assetJsons += n;
        break;
      }
      case 'albumJson': {
        c.scanned.albumJsons += n;
        break;
      }
      case 'unknownJson': {
        c.scanned.unknownJsons += n;
        break;
      }
      case 'immichGoJson': {
        c.scanned.unknownJsons += n;
        break;
      }
      case 'useless': {
        c.scanned.useless += n;
        break;
      }
      case 'unsupported': {
        c.scanned.unsupported += n;
        break;
      }
      case 'banned': {
        c.scanned.banned += n;
        break;
      }
      case 'localDuplicate': {
        c.discarded.localDuplicates += n;
        break;
      }
      case 'duplicatedInDirectory': {
        c.discarded.duplicatedInDirectory += n;
        break;
      }
      case 'filteredPartner': {
        c.discarded.filteredPartner += n;
        break;
      }
      case 'filteredTrashed': {
        c.discarded.filteredTrashed += n;
        break;
      }
      case 'filteredArchived': {
        c.discarded.filteredArchived += n;
        break;
      }
      case 'filteredDateRange': {
        c.discarded.filteredDateRange += n;
        break;
      }
      case 'notSelected': {
        c.discarded.notSelected += n;
        break;
      }
      case 'rotateOnlyDropped': {
        c.discarded.rotateOnlyDropped += n;
        break;
      }
      case 'failedVideo': {
        c.discarded.failedVideos += n;
        break;
      }
      case 'missingMetadata': {
        c.matched.missingMetadata += n;
        break;
      }
      case 'previouslyDeletedSkipped': {
        c.discarded.previouslyDeleted += n;
        break;
      }
      case 'partUnreadable': {
        c.discarded.unreadable += n;
        break;
      }
      case 'missingFromArchive': {
        c.discarded.missingFromArchive += n;
        break;
      }
      case 'upload': {
        c.result.toUpload += n;
        if (row.status === 'created' || row.status === 'done') {
          c.result.uploaded += n;
        }
        if (row.reason === 'server had a smaller version') {
          c.result.largerUploaded += n;
        }
        break;
      }
      case 'serverDuplicate': {
        c.result.serverDuplicates += n;
        break;
      }
      case 'betterOnServer': {
        c.result.betterOnServer += n;
        break;
      }
      case 'alreadyProcessed': {
        c.result.alreadyProcessed += n;
        break;
      }
      // no default
    }

    // A media file without Google JSON that is imported anyway (includeUnmatched) has no Google date: it is dated from
    // the file alone, so it counts as missing metadata like the skipped ones instead of vanishing from the report.
    if (
      row.matcher === null &&
      (row.fileKind === 'image' || row.fileKind === 'video') &&
      IMPORTED_ACTIONS.has(row.action)
    ) {
      c.matched.missingMetadata += n;
    }

    switch (row.matcher) {
      case 'fastTrack': {
        c.matched.fastTrack += n;
        break;
      }
      case 'normal': {
        c.matched.normal += n;
        break;
      }
      case 'forgottenDuplicates': {
        c.matched.forgottenDuplicates += n;
        break;
      }
      case 'edited': {
        c.matched.edited += n;
        break;
      }
      // no default
    }

    if (row.rotationState === 'pending') {
      c.result.rotationsQueued += n;
    } else if (row.rotationState === 'applied') {
      c.result.rotationsApplied += n;
    }
    if (row.status === 'error') {
      c.result.errors += n;
    }

    for (const fallback of row.fallbacks) {
      switch (fallback) {
        case 'zoneAssumed': {
          c.result.zoneAssumed += n;

          break;
        }
        case 'stacked': {
          c.result.stacked += n;

          break;
        }
        case 'albumAdded': {
          c.result.albumAdds += n;

          break;
        }
        case 'dateFromGoogle': {
          c.result.datesFromGoogle += n;

          break;
        }
        default: {
          if (fallback.startsWith('albumCreated:')) {
            c.result.albumsCreated += n;
          } else if (fallback === 'tagged') {
            c.result.tagged += n;
          } else if (fallback === 'metadataSaved') {
            c.result.metadataSaved += n;
          }
        }
      }
    }
  }

  return c;
}
