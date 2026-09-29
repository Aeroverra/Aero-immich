import {
  createVideoBookmark,
  deleteVideoBookmark,
  getVideoBookmarks,
  updateVideoBookmark,
  type VideoBookmarkResponseDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';
import { formatVideoPosition } from '$lib/utils/people-utils';

const byTime = (a: VideoBookmarkResponseDto, b: VideoBookmarkResponseDto) => a.time - b.time;

/** Bookmarks of the video open in the viewer, shared by the player (markers, shortcuts) and the info panel */
class VideoBookmarkManager {
  assetId = $state<string>();
  bookmarks = $state<VideoBookmarkResponseDto[]>([]);
  #player: { assetId: string; getPosition: () => number } | undefined;

  /** Lets the info panel bookmark the current position of the player showing the video. Returns the detach function. */
  attachPlayer(assetId: string, getPosition: () => number) {
    const player = { assetId, getPosition };
    this.#player = player;
    return () => {
      if (this.#player === player) {
        this.#player = undefined;
      }
    };
  }

  async addAtCurrentPosition(assetId: string) {
    const player = this.#player;
    if (player?.assetId !== assetId) {
      return;
    }
    return this.add(assetId, player.getPosition());
  }

  async load(assetId: string) {
    if (this.assetId === assetId) {
      return;
    }

    this.assetId = assetId;
    this.bookmarks = [];
    try {
      const bookmarks = await getVideoBookmarks({ assetId });
      if (this.assetId === assetId) {
        this.bookmarks = bookmarks.sort(byTime);
      }
    } catch (error) {
      const translate = await getFormatter();
      handleError(error, translate('errors.unable_to_load_video_bookmarks'), { notify: false });
    }
  }

  clear() {
    this.assetId = undefined;
    this.bookmarks = [];
  }

  async add(assetId: string, time: number) {
    const translate = await getFormatter();
    try {
      const bookmark = await createVideoBookmark({
        videoBookmarkCreateDto: { assetId, time: Math.max(0, Math.round(time)) },
      });
      if (this.assetId === assetId) {
        this.bookmarks = [...this.bookmarks, bookmark].sort(byTime);
      }
      toastManager.primary(translate('video_bookmark_added', { values: { time: formatVideoPosition(bookmark.time) } }));
      return bookmark;
    } catch (error) {
      handleError(error, translate('errors.unable_to_add_video_bookmark'));
    }
  }

  async rename(id: string, label: string) {
    const current = this.bookmarks.find((bookmark) => bookmark.id === id);
    if (!current || current.label === label.trim()) {
      return;
    }

    try {
      const bookmark = await updateVideoBookmark({ id, videoBookmarkUpdateDto: { label } });
      this.bookmarks = this.bookmarks.map((item) => (item.id === id ? bookmark : item));
    } catch (error) {
      const translate = await getFormatter();
      handleError(error, translate('errors.unable_to_update_video_bookmark'));
    }
  }

  async remove(id: string) {
    try {
      await deleteVideoBookmark({ id });
      this.bookmarks = this.bookmarks.filter((bookmark) => bookmark.id !== id);
    } catch (error) {
      const translate = await getFormatter();
      handleError(error, translate('errors.unable_to_delete_video_bookmark'));
    }
  }

  /** The first bookmark after the position (in milliseconds), with a small margin so a repeated press moves on */
  next(time: number) {
    return this.bookmarks.find((bookmark) => bookmark.time > time + 500);
  }

  /** The last bookmark before the position, skipping the one just passed so a repeated press moves back */
  previous(time: number) {
    return this.bookmarks.findLast((bookmark) => bookmark.time < time - 1500);
  }
}

export const videoBookmarkManager = new VideoBookmarkManager();
