import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns, ViewFilter } from 'src/database';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';
import { SyncAck } from 'src/types';
import { anyUuid, dummyViewFilter, isViewUnrestricted, viewAssetPredicate } from 'src/utils/database';

export type SyncBackfillOptions = {
  nowId: string;
  afterUpdateId?: string;
  beforeUpdateId: string;
  includePrivate?: boolean;
  /** the default view a client without the views flag is limited to; null or undefined sends everything */
  view?: ViewFilter | null;
  /** the receiving user, whose default view decides which albums are withheld */
  userId?: string;
};

const dummyBackfillOptions = {
  nowId: DummyValue.UUID,
  beforeUpdateId: DummyValue.UUID,
  afterUpdateId: DummyValue.UUID,
};

export type SyncCreatedAfterOptions = {
  nowId: string;
  userId: string;
  afterCreateId?: string;
};

const dummyCreateAfterOptions = {
  nowId: DummyValue.UUID,
  userId: DummyValue.UUID,
  afterCreateId: DummyValue.UUID,
};

export type SyncQueryOptions = {
  nowId: string;
  userId: string;
  ack?: SyncAck;
  includePrivate?: boolean;
  /** the default view a client without the views flag is limited to; null or undefined sends everything */
  view?: ViewFilter | null;
};

const dummyQueryOptions = {
  nowId: DummyValue.UUID,
  userId: DummyValue.UUID,
  ack: {
    updateId: DummyValue.UUID,
  },
};

export type AlbumViewStateRow = {
  albumId: string;
  albumThumbnailAssetId: string | null;
  /** whether the album holds any asset album listings count, before the view is applied */
  hasAssets: boolean;
  /** whether any of those assets passes the view */
  hasVisibleAssets: boolean;
  /**
   * the cover under the view: the album cover when the view shows it (or when the album has none), else the newest
   * asset the view shows
   */
  visibleThumbnailAssetId: string | null;
  stateAlbumId: string | null;
  stateIsHidden: boolean | null;
  stateThumbnailAssetId: string | null;
};

export type AlbumViewStateChanges = {
  /** state rows to write, with the cover clients limited to the default view receive */
  upserts: Array<{ albumId: string; isHidden: boolean; thumbnailAssetId: string | null }>;
  /** albums whose state row goes, because they look the same as for everyone else again */
  deletes: string[];
  /** albums sent again: hidden or shown under the default view, or given another cover */
  touched: string[];
  /** albums shown again, whose users and asset links are sent again too (the clients dropped them with the album) */
  shown: string[];
};

@Injectable()
export class SyncRepository {
  album: AlbumSync;
  albumViewState: AlbumViewStateSync;
  albumAsset: AlbumAssetSync;
  albumAssetExif: AlbumAssetExifSync;
  albumToAsset: AlbumToAssetSync;
  albumUser: AlbumUserSync;
  asset: AssetSync;
  assetExif: AssetExifSync;
  assetEdit: AssetEditSync;
  assetFace: AssetFaceSync;
  assetMetadata: AssetMetadataSync;
  assetOcr: AssetOcrSync;
  authUser: AuthUserSync;
  memory: MemorySync;
  memoryToAsset: MemoryToAssetSync;
  partner: PartnerSync;
  partnerAsset: PartnerAssetsSync;
  partnerAssetExif: PartnerAssetExifsSync;
  partnerStack: PartnerStackSync;
  person: PersonSync;
  personGroup: PersonGroupSync;
  stack: StackSync;
  tag: TagSync;
  tagAsset: TagAssetSync;
  user: UserSync;
  userMetadata: UserMetadataSync;
  view: ViewSync;
  viewTag: ViewTagSync;

  constructor(@InjectKysely() private db: Kysely<DB>) {
    this.album = new AlbumSync(this.db);
    this.albumViewState = new AlbumViewStateSync(this.db);
    this.albumAsset = new AlbumAssetSync(this.db);
    this.albumAssetExif = new AlbumAssetExifSync(this.db);
    this.albumToAsset = new AlbumToAssetSync(this.db);
    this.albumUser = new AlbumUserSync(this.db);
    this.asset = new AssetSync(this.db);
    this.assetExif = new AssetExifSync(this.db);
    this.assetEdit = new AssetEditSync(this.db);
    this.assetFace = new AssetFaceSync(this.db);
    this.assetMetadata = new AssetMetadataSync(this.db);
    this.assetOcr = new AssetOcrSync(this.db);
    this.authUser = new AuthUserSync(this.db);
    this.memory = new MemorySync(this.db);
    this.memoryToAsset = new MemoryToAssetSync(this.db);
    this.partner = new PartnerSync(this.db);
    this.partnerAsset = new PartnerAssetsSync(this.db);
    this.partnerAssetExif = new PartnerAssetExifsSync(this.db);
    this.partnerStack = new PartnerStackSync(this.db);
    this.person = new PersonSync(this.db);
    this.personGroup = new PersonGroupSync(this.db);
    this.stack = new StackSync(this.db);
    this.tag = new TagSync(this.db);
    this.tagAsset = new TagAssetSync(this.db);
    this.user = new UserSync(this.db);
    this.userMetadata = new UserMetadataSync(this.db);
    this.view = new ViewSync(this.db);
    this.viewTag = new ViewTagSync(this.db);
  }
}

/** rows whose asset is not private; used to keep private metadata out of streams that did not opt in */
const privateAssetPredicate = (assetIdRef: string) => (eb: ExpressionBuilder<DB, any>) =>
  eb(eb.ref(assetIdRef), 'in', eb.selectFrom('asset').select('asset.id').where('asset.isPrivate', '=', false));

/** rows whose album is not private; a client that did not opt in was told the album was deleted */
const privateAlbumPredicate = (albumIdRef: string) => (eb: ExpressionBuilder<DB, any>) =>
  eb(eb.ref(albumIdRef), 'in', eb.selectFrom('album').select('album.id').where('album.isPrivate', '=', false));

type ViewOptions = { view?: ViewFilter | null };

/** whether the asset referenced by `assetIdRef` passes the default view the client is limited to */
const viewAssetExists = (eb: ExpressionBuilder<DB, any>, view: ViewFilter, assetIdRef: string) =>
  eb.exists(
    eb
      .selectFrom('asset as view_asset')
      .whereRef('view_asset.id', '=', eb.ref(assetIdRef))
      .where((eb) =>
        viewAssetPredicate(eb, view, { assetIdRef: 'view_asset.id', isPrivateRef: 'view_asset.isPrivate' }),
      ),
  );

/** rows of assets that pass the default view; used where the stream leaves rows out instead of withholding them */
const viewAssetFilter =
  ({ view }: ViewOptions, assetIdRef: string) =>
  (eb: ExpressionBuilder<DB, any>) =>
    isViewUnrestricted(view) ? eb.lit(true) : viewAssetExists(eb, view!, assetIdRef);

/** true when the client is limited to the default view and the view hides the asset of the row */
const isViewHidden = (eb: ExpressionBuilder<DB, any>, { view }: ViewOptions, assetIdRef: string) =>
  isViewUnrestricted(view)
    ? eb.lit(false).$castTo<boolean>()
    : eb.not(viewAssetExists(eb, view!, assetIdRef)).$castTo<boolean>();

/**
 * true when the client is limited to the default view and that view hides the album as a whole for the receiving user
 * (see album_view_state)
 */
const isAlbumViewHidden = (
  eb: ExpressionBuilder<DB, any>,
  { view, userId }: ViewOptions & { userId?: string },
  albumIdRef: string,
) =>
  isViewUnrestricted(view) || !userId
    ? eb.lit(false).$castTo<boolean>()
    : eb
        .exists(
          eb
            .selectFrom('album_view_state')
            .whereRef('album_view_state.albumId', '=', eb.ref(albumIdRef))
            .where('album_view_state.userId', '=', userId)
            .where('album_view_state.isHidden', '=', true),
        )
        .$castTo<boolean>();

/** rows of albums the default view does not hide; used where the stream leaves rows out instead of withholding them */
const albumViewFilter =
  (options: ViewOptions & { userId?: string }, albumIdRef: string) => (eb: ExpressionBuilder<DB, any>) =>
    eb.not(isAlbumViewHidden(eb, options, albumIdRef));

/** a memory is private as a whole while it holds any private asset */
const isMemoryPrivate = (eb: ExpressionBuilder<DB, any>, memoryIdRef: string) =>
  eb
    .exists(
      eb
        .selectFrom('memory_asset')
        .innerJoin('asset', 'asset.id', 'memory_asset.assetId')
        .select('memory_asset.assetId')
        .whereRef('memory_asset.memoriesId', '=', eb.ref(memoryIdRef))
        .where('asset.isPrivate', '=', true),
    )
    .$castTo<boolean>();

/** the visible faces of a person on assets of the given privacy, mirroring the people list */
const visiblePersonFaces = (eb: ExpressionBuilder<DB, 'person'>, isPrivate?: boolean) =>
  eb
    .selectFrom('asset_face')
    .innerJoin('asset', 'asset.id', 'asset_face.assetId')
    .select('asset_face.id')
    .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
    .whereRef('asset.ownerId', '=', 'person.ownerId')
    .where('asset_face.deletedAt', 'is', null)
    .where('asset_face.isVisible', '=', true)
    .where('asset.deletedAt', 'is', null)
    .$if(isPrivate !== undefined, (qb) => qb.where('asset.isPrivate', '=', isPrivate!));

export class BaseSync {
  constructor(protected db: Kysely<DB>) {}

  protected backfillQuery<T extends keyof DB>(t: T, { nowId, beforeUpdateId, afterUpdateId }: SyncBackfillOptions) {
    const { table, ref } = this.db.dynamic;
    const updateIdRef = ref(`${t}.updateId`);

    return this.db
      .selectFrom(table(t).as(t))
      .where(updateIdRef, '<', nowId)
      .where(updateIdRef, '<=', beforeUpdateId)
      .$if(!!afterUpdateId, (qb) => qb.where(updateIdRef, '>', afterUpdateId!))
      .orderBy(updateIdRef, 'asc');
  }

  protected auditQuery<T extends keyof DB>(t: T, { nowId, ack }: SyncQueryOptions) {
    const { table, ref } = this.db.dynamic;
    const idRef = ref(`${t}.id`);

    return this.db
      .selectFrom(table(t).as(t))
      .where(idRef, '<', nowId)
      .$if(!!ack, (qb) => qb.where(idRef, '>', ack!.updateId))
      .orderBy(idRef, 'asc');
  }

  protected auditCleanup<T extends keyof DB>(t: T, days: number) {
    const { table, ref } = this.db.dynamic;

    return this.db
      .deleteFrom(table(t).as(t))
      .where(ref(`${t}.deletedAt`), '<', sql.raw(`now() - interval '${days} days'`))
      .execute();
  }

  protected upsertQuery<T extends keyof DB>(t: T, { nowId, ack }: SyncQueryOptions) {
    const { table, ref } = this.db.dynamic;
    const updateIdRef = ref(`${t}.updateId`);

    return this.db
      .selectFrom(table(t).as(t))
      .where(updateIdRef, '<', nowId)
      .$if(!!ack, (qb) => qb.where(updateIdRef, '>', ack!.updateId))
      .orderBy(updateIdRef, 'asc');
  }
}

class AlbumSync extends BaseSync {
  @GenerateSql({ params: [dummyCreateAfterOptions] })
  getCreatedAfter({ nowId, userId, afterCreateId }: SyncCreatedAfterOptions) {
    return this.db
      .selectFrom('album_user')
      .select(['albumId as id', 'createId'])
      .where('userId', '=', userId)
      .$if(!!afterCreateId, (qb) => qb.where('createId', '>=', afterCreateId!))
      .where('createId', '<', nowId)
      .orderBy('createId', 'asc')
      .execute();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('album_audit', options)
      .select(['id', 'albumId'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('album_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album', options)
      .distinctOn(['album.id', 'album.updateId'])
      .leftJoin('album_user as album_users', 'album.id', 'album_users.albumId')
      .where('album_users.userId', '=', userId)
      .select([
        'album.id',
        'album.albumName as name',
        'album.description',
        'album.createdAt',
        'album.updatedAt',
        'album.albumThumbnailAssetId as thumbnailAssetId',
        'album.isActivityEnabled',
        'album.order',
        'album.isPrivate',
        'album.updateId',
      ])
      .$if(!isViewUnrestricted(options.view), (qb) =>
        qb
          .leftJoin('album_view_state', (join) =>
            join.onRef('album_view_state.albumId', '=', 'album.id').on('album_view_state.userId', '=', userId),
          )
          // a client limited to the default view gets a cover that view shows (see album_view_state)
          .select('album_view_state.albumId as viewStateAlbumId')
          .select('album_view_state.thumbnailAssetId as viewThumbnailAssetId'),
      )
      .select((eb) => isAlbumViewHidden(eb, options, 'album.id').as('isViewHidden'))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getAlbumUsers(albumId: string) {
    return this.db.selectFrom('album_user').select(['userId', 'role']).where('albumId', '=', albumId).execute();
  }
}

class AlbumAssetSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string, userId: string) {
    return this.backfillQuery('album_asset', options)
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select(columns.syncAlbumAsset)
      .select((eb) =>
        eb
          .case()
          .when('asset.ownerId', '=', userId)
          .then(eb.ref('asset.isFavorite'))
          .else(eb.val(false))
          .end()
          .as('isFavorite'),
      )
      .select('album_asset.updateId')
      .where('album_asset.albumId', '=', albumId)
      .$if(!options.includePrivate, (qb) => qb.where('asset.isPrivate', '=', false))
      .$if(!options.includePrivate, (qb) => qb.where(privateAlbumPredicate('album_asset.albumId')))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where((eb) => viewAssetPredicate(eb, options.view!)))
      .$if(!isViewUnrestricted(options.view), (qb) =>
        qb.where(albumViewFilter({ ...options, userId }, 'album_asset.albumId')),
      )
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions, { updateId: DummyValue.UUID }], stream: true })
  getUpdates(options: SyncQueryOptions, albumToAssetAck: SyncAck) {
    const userId = options.userId;
    return this.upsertQuery('asset', options)
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .select(columns.syncAlbumAsset)
      .select((eb) =>
        eb
          .case()
          .when('asset.ownerId', '=', userId)
          .then(eb.ref('asset.isFavorite'))
          .else(eb.val(false))
          .end()
          .as('isFavorite'),
      )
      .select('asset.updateId')
      .select('album.isPrivate as isAlbumPrivate')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .select((eb) => isAlbumViewHidden(eb, options, 'album.id').as('isAlbumViewHidden'))
      .where('album_asset.updateId', '<=', albumToAssetAck.updateId) // Ensure we only send updates for assets that the client already knows about
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getCreates(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_asset', options)
      .select('album_asset.updateId')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .select(columns.syncAlbumAsset)
      .select((eb) =>
        eb
          .case()
          .when('asset.ownerId', '=', userId)
          .then(eb.ref('asset.isFavorite'))
          .else(eb.val(false))
          .end()
          .as('isFavorite'),
      )
      .select('album.isPrivate as isAlbumPrivate')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .select((eb) => isAlbumViewHidden(eb, options, 'album.id').as('isAlbumViewHidden'))
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .stream();
  }
}

class AlbumAssetExifSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string) {
    return this.backfillQuery('album_asset', options)
      .innerJoin('asset_exif', 'asset_exif.assetId', 'album_asset.assetId')
      .select(columns.syncAssetExif)
      .select('album_asset.updateId')
      .where('album_asset.albumId', '=', albumId)
      .$if(!options.includePrivate, (qb) => qb.where(privateAssetPredicate('album_asset.assetId')))
      .$if(!options.includePrivate, (qb) => qb.where(privateAlbumPredicate('album_asset.albumId')))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where(viewAssetFilter(options, 'album_asset.assetId')))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where(albumViewFilter(options, 'album_asset.albumId')))
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions, { updateId: DummyValue.UUID }], stream: true })
  getUpdates(options: SyncQueryOptions, albumToAssetAck: SyncAck) {
    const userId = options.userId;
    return this.upsertQuery('asset_exif', options)
      .innerJoin('album_asset', 'album_asset.assetId', 'asset_exif.assetId')
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .select('album.isPrivate as isAlbumPrivate')
      .select((eb) => isAlbumViewHidden(eb, options, 'album.id').as('isAlbumViewHidden'))
      .where('album_asset.updateId', '<=', albumToAssetAck.updateId) // Ensure we only send exif updates for assets that the client already knows about
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .$if(!options.includePrivate, (qb) => qb.where(privateAssetPredicate('asset_exif.assetId')))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where(viewAssetFilter(options, 'asset_exif.assetId')))
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getCreates(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_asset', options)
      .select('album_asset.updateId')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'album_asset.assetId')
      .select(columns.syncAssetExif)
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .select('album.isPrivate as isAlbumPrivate')
      .select((eb) => isAlbumViewHidden(eb, options, 'album.id').as('isAlbumViewHidden'))
      .leftJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .$if(!options.includePrivate, (qb) => qb.where(privateAssetPredicate('album_asset.assetId')))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where(viewAssetFilter(options, 'album_asset.assetId')))
      .stream();
  }
}

class AlbumToAssetSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string) {
    return this.backfillQuery('album_asset', options)
      .select(['album_asset.assetId as assetId', 'album_asset.albumId as albumId', 'album_asset.updateId'])
      .where('album_asset.albumId', '=', albumId)
      .$if(!options.includePrivate, (qb) => qb.where(privateAlbumPredicate('album_asset.albumId')))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where(viewAssetFilter(options, 'album_asset.assetId')))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where(albumViewFilter(options, 'album_asset.albumId')))
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.auditQuery('album_asset_audit', options)
      .select(['id', 'assetId', 'albumId'])
      .where((eb) =>
        eb(
          'albumId',
          'in',
          eb.selectFrom('album_user').select(['album_user.albumId as id']).where('album_user.userId', '=', userId),
        ),
      )
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('album_asset_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_asset', options)
      .select(['album_asset.assetId as assetId', 'album_asset.albumId as albumId', 'album_asset.updateId'])
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .select('album.isPrivate as isAlbumPrivate')
      .select((eb) => isViewHidden(eb, options, 'album_asset.assetId').as('isViewHidden'))
      .select((eb) => isAlbumViewHidden(eb, options, 'album_asset.albumId').as('isAlbumViewHidden'))
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .stream();
  }
}

class AlbumUserSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string) {
    return this.backfillQuery('album_user', options)
      .select(columns.syncAlbumUser)
      .select('album_user.updateId')
      .where('albumId', '=', albumId)
      .$if(!options.includePrivate, (qb) => qb.where(privateAlbumPredicate('album_user.albumId')))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where(albumViewFilter(options, 'album_user.albumId')))
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.auditQuery('album_user_audit', options)
      .select(['id', 'userId', 'albumId'])
      .where((eb) =>
        eb(
          'albumId',
          'in',
          eb.selectFrom('album_user').select(['album_user.albumId as id']).where('album_user.userId', '=', userId),
        ),
      )
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('album_user_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_user', options)
      .select(columns.syncAlbumUser)
      .select('album_user.updateId')
      .innerJoin('album', 'album.id', 'album_user.albumId')
      .select('album.isPrivate as isAlbumPrivate')
      .select((eb) => isAlbumViewHidden(eb, options, 'album_user.albumId').as('isAlbumViewHidden'))
      .where((eb) =>
        eb(
          'album_user.albumId',
          'in',
          eb
            .selectFrom('album_user as albumUsers')
            .select(['albumUsers.albumId as id'])
            .where('albumUsers.userId', '=', userId),
        ),
      )
      .stream();
  }
}

class AssetSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('asset_audit', options)
      .select(['id', 'assetId'])
      .where('ownerId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset', options)
      .select(columns.syncAsset)
      .select('asset.updateId')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .where('ownerId', '=', options.userId)
      .stream();
  }
}

class AuthUserSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('user', options)
      .select(columns.syncUser)
      .select(['isAdmin', 'pinCode', 'oauthId', 'storageLabel', 'quotaSizeInBytes', 'quotaUsageInBytes'])
      .where('id', '=', options.userId)
      .stream();
  }
}

class PersonSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('person_audit', options)
      .select(['id', 'personGroupId as personId'])
      .where('ownerId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('person_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return (
      this.upsertQuery('person', options)
        .select([
          'personGroupId as id',
          'createdAt',
          'updatedAt',
          'ownerId',
          'name',
          'birthDate',
          'isHidden',
          'isFavorite',
          'color',
          'updateId',
          'faceAssetId',
        ])
        // same rule as the people list: a person is private when every visible face sits on a private asset
        .select((eb) =>
          eb
            .and([eb.exists(visiblePersonFaces(eb, true)), eb.not(eb.exists(visiblePersonFaces(eb, false)))])
            .$castTo<boolean>()
            .as('isPrivate'),
        )
        // and hidden for a client limited to the default view when none of its visible faces passes the view
        .select((eb) =>
          (isViewUnrestricted(options.view)
            ? eb.lit(false).$castTo<boolean>()
            : eb
                .and([
                  eb.exists(visiblePersonFaces(eb)),
                  eb.not(eb.exists(visiblePersonFaces(eb).where((eb) => viewAssetPredicate(eb, options.view!)))),
                ])
                .$castTo<boolean>()
          ).as('isViewHidden'),
        )
        .where('ownerId', '=', options.userId)
        .stream()
    );
  }
}

class PersonGroupSync extends BaseSync {
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('person_group_audit', daysAgo);
  }
}

class AssetFaceSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('asset_face_audit', options)
      .select(['asset_face_audit.id', 'assetFaceId'])
      .leftJoin('asset', 'asset.id', 'asset_face_audit.assetId')
      .where('asset.ownerId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_face_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset_face', options)
      .select([
        'asset_face.id',
        'assetId',
        'personGroupId as personId',
        'imageWidth',
        'imageHeight',
        'boundingBoxX1',
        'boundingBoxY1',
        'boundingBoxX2',
        'boundingBoxY2',
        'sourceType',
        'isVisible',
        'asset_face.deletedAt',
        'asset_face.updateId',
      ])
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .select('asset.isPrivate as isAssetPrivate')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .where('asset.ownerId', '=', options.userId)
      .stream();
  }
}

class AssetExifSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset_exif', options)
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .where('assetId', 'in', (eb) =>
        eb
          .selectFrom('asset')
          .select('id')
          .where('ownerId', '=', options.userId)
          .$if(!options.includePrivate, (qb) => qb.where('isPrivate', '=', false))
          .$if(!isViewUnrestricted(options.view), (qb) => qb.where((eb) => viewAssetPredicate(eb, options.view!))),
      )
      .stream();
  }
}

class AssetEditSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('asset_edit_audit', options)
      .select(['asset_edit_audit.id', 'editId'])
      .innerJoin('asset', 'asset.id', 'asset_edit_audit.assetId')
      .where('asset.ownerId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_edit_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset_edit', options)
      .select([...columns.syncAssetEdit, 'asset_edit.updateId'])
      .innerJoin('asset', 'asset.id', 'asset_edit.assetId')
      .select('asset.isPrivate as isAssetPrivate')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .where('asset.ownerId', '=', options.userId)
      .stream();
  }
}

class MemorySync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('memory_audit', options)
      .select(['id', 'memoryId'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('memory_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('memory', options)
      .select([
        'id',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'ownerId',
        'type',
        'data',
        'isSaved',
        'memoryAt',
        'seenAt',
        'showAt',
        'hideAt',
      ])
      .select('updateId')
      .select((eb) => isMemoryPrivate(eb, 'memory.id').as('isPrivate'))
      .where('ownerId', '=', options.userId)
      .stream();
  }
}

class MemoryToAssetSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('memory_asset_audit', options)
      .select(['id', 'memoryId', 'assetId'])
      .where('memoryId', 'in', (eb) => eb.selectFrom('memory').select('id').where('ownerId', '=', options.userId))
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('memory_asset_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('memory_asset', options)
      .select(['memoriesId as memoryId', 'assetId as assetId'])
      .select('updateId')
      .select((eb) => isMemoryPrivate(eb, 'memory_asset.memoriesId').as('isMemoryPrivate'))
      .select((eb) => isViewHidden(eb, options, 'memory_asset.assetId').as('isViewHidden'))
      .where('memoriesId', 'in', (eb) => eb.selectFrom('memory').select('id').where('ownerId', '=', options.userId))
      .stream();
  }
}

class PartnerSync extends BaseSync {
  @GenerateSql({ params: [dummyCreateAfterOptions] })
  getCreatedAfter({ nowId, userId, afterCreateId }: SyncCreatedAfterOptions) {
    return this.db
      .selectFrom('partner')
      .select(['sharedById', 'createId'])
      .where('sharedWithId', '=', userId)
      .$if(!!afterCreateId, (qb) => qb.where('createId', '>=', afterCreateId!))
      .where('createId', '<', nowId)
      .orderBy('partner.createId', 'asc')
      .execute();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.auditQuery('partner_audit', options)
      .select(['id', 'sharedById', 'sharedWithId'])
      .where((eb) => eb.or([eb('sharedById', '=', userId), eb('sharedWithId', '=', userId)]))
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('partner_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('partner', options)
      .select(['sharedById', 'sharedWithId', 'inTimeline', 'updateId'])
      .where((eb) => eb.or([eb('sharedById', '=', userId), eb('sharedWithId', '=', userId)]))
      .stream();
  }
}

class PartnerAssetsSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, partnerId: string) {
    return this.backfillQuery('asset', options)
      .select(columns.syncPartnerAsset)
      .select(sql.val(false).as('isFavorite'))
      .select('asset.updateId')
      .where('ownerId', '=', partnerId)
      .$if(!options.includePrivate, (qb) => qb.where('asset.isPrivate', '=', false))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where((eb) => viewAssetPredicate(eb, options.view!)))
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('asset_audit', options)
      .select(['id', 'assetId'])
      .where('ownerId', 'in', (eb) =>
        eb.selectFrom('partner').select(['sharedById']).where('sharedWithId', '=', options.userId),
      )
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset', options)
      .select(columns.syncPartnerAsset)
      .select(sql.val(false).as('isFavorite'))
      .select('asset.updateId')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .where('ownerId', 'in', (eb) =>
        eb.selectFrom('partner').select(['sharedById']).where('sharedWithId', '=', options.userId),
      )
      .stream();
  }
}

class PartnerAssetExifsSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, partnerId: string) {
    return this.backfillQuery('asset_exif', options)
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .where('asset.ownerId', '=', partnerId)
      .$if(!options.includePrivate, (qb) => qb.where('asset.isPrivate', '=', false))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where((eb) => viewAssetPredicate(eb, options.view!)))
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset_exif', options)
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .where('assetId', 'in', (eb) =>
        eb
          .selectFrom('asset')
          .select('id')
          .where('ownerId', 'in', (eb) =>
            eb.selectFrom('partner').select(['sharedById']).where('sharedWithId', '=', options.userId),
          )
          .$if(!options.includePrivate, (qb) => qb.where('isPrivate', '=', false))
          .$if(!isViewUnrestricted(options.view), (qb) => qb.where((eb) => viewAssetPredicate(eb, options.view!))),
      )
      .stream();
  }
}

class StackSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('stack_audit', options)
      .select(['id', 'stackId'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('stack_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('stack', options)
      .select(columns.syncStack)
      .select('stack.updateId')
      .innerJoin('asset', 'asset.id', 'stack.primaryAssetId')
      .select('asset.isPrivate as isAssetPrivate')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .where('stack.ownerId', '=', options.userId)
      .stream();
  }
}

class PartnerStackSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('stack_audit', options)
      .select(['id', 'stackId'])
      .where('userId', 'in', (eb) =>
        eb.selectFrom('partner').select(['sharedById']).where('sharedWithId', '=', options.userId),
      )
      .stream();
  }

  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, partnerId: string) {
    return this.backfillQuery('stack', options)
      .select(columns.syncStack)
      .select('updateId')
      .where('ownerId', '=', partnerId)
      .$if(!options.includePrivate, (qb) => qb.where(privateAssetPredicate('stack.primaryAssetId')))
      .$if(!isViewUnrestricted(options.view), (qb) => qb.where(viewAssetFilter(options, 'stack.primaryAssetId')))
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('stack', options)
      .select(columns.syncStack)
      .select('stack.updateId')
      .innerJoin('asset', 'asset.id', 'stack.primaryAssetId')
      .select('asset.isPrivate as isAssetPrivate')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .where('stack.ownerId', 'in', (eb) =>
        eb.selectFrom('partner').select(['sharedById']).where('sharedWithId', '=', options.userId),
      )
      .stream();
  }
}

class UserSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('user_audit', options).select(['id', 'userId']).stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('user_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('user', options).select(columns.syncUser).stream();
  }
}

class UserMetadataSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('user_metadata_audit', options)
      .select(['id', 'userId', 'key'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('user_metadata_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('user_metadata', options)
      .select(['userId', 'key', 'value', 'updateId'])
      .where('userId', '=', options.userId)
      .stream();
  }
}

class AssetMetadataSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getDeletes(options: SyncQueryOptions, userId: string) {
    return this.auditQuery('asset_metadata_audit', options)
      .select(['asset_metadata_audit.id', 'assetId', 'key'])
      .leftJoin('asset', 'asset.id', 'asset_metadata_audit.assetId')
      .where('asset.ownerId', '=', userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_metadata_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getUpserts(options: SyncQueryOptions, userId: string) {
    return this.upsertQuery('asset_metadata', options)
      .select(['assetId', 'key', 'value', 'asset_metadata.updateId'])
      .innerJoin('asset', 'asset.id', 'asset_metadata.assetId')
      .select('asset.isPrivate as isAssetPrivate')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .where('asset.ownerId', '=', userId)
      .stream();
  }
}

class AssetOcrSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getDeletes(options: SyncQueryOptions, userId: string) {
    return this.auditQuery('asset_ocr_audit', options)
      .select(['asset_ocr_audit.id', 'asset_ocr_audit.assetId', 'asset_ocr_audit.deletedAt'])
      .leftJoin('asset', 'asset.id', 'asset_ocr_audit.assetId')
      .where('asset.ownerId', '=', userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_ocr_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getUpserts(options: SyncQueryOptions, userId: string) {
    return this.upsertQuery('asset_ocr', options)
      .select(columns.syncAssetOcr)
      .innerJoin('asset', 'asset.id', 'asset_ocr.assetId')
      .select('asset.isPrivate as isAssetPrivate')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .where('asset.ownerId', '=', userId)
      .stream();
  }
}

class TagSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('tag_audit', options).select(['id', 'tagId']).where('userId', '=', options.userId).stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('tag_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    // hidden tags are sent too: the fork app hides their names locally while private mode is locked
    return this.upsertQuery('tag', options)
      .select([
        'tag.id',
        'tag.userId as ownerId',
        'tag.value',
        'tag.parentId',
        'tag.color',
        'tag.isHidden',
        'tag.createdAt',
        'tag.updatedAt',
        'tag.updateId',
      ])
      .where('tag.userId', '=', options.userId)
      .stream();
  }
}

class TagAssetSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('tag_asset_audit', options)
      .select(['id', 'tagId', 'assetId'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('tag_asset_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('tag_asset', options)
      .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
      .innerJoin('asset', 'asset.id', 'tag_asset.assetId')
      .select(['tag_asset.tagId', 'tag_asset.assetId', 'tag_asset.updateId'])
      .select('asset.isPrivate as isAssetPrivate')
      .select((eb) => isViewHidden(eb, options, 'asset.id').as('isViewHidden'))
      .where('tag.userId', '=', options.userId)
      .stream();
  }
}

class ViewSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('view_audit', options)
      .select(['id', 'viewId'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('view_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('view', options)
      .select([
        'view.id',
        'view.ownerId',
        'view.name',
        'view.order',
        'view.isDefault',
        'view.access',
        'view.includeAll',
        'view.includeUntagged',
        'view.privateAssets',
        'view.createdAt',
        'view.updatedAt',
        'view.updateId',
      ])
      .where('view.ownerId', '=', options.userId)
      .stream();
  }
}

class ViewTagSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('view_tag_audit', options)
      .select(['id', 'viewId', 'tagId'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('view_tag_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('view_tag', options)
      .innerJoin('view', 'view.id', 'view_tag.viewId')
      .select(['view_tag.viewId', 'view_tag.tagId', 'view_tag.mode', 'view_tag.updateId'])
      .where('view.ownerId', '=', options.userId)
      .stream();
  }
}

/** the assets of an album that album listings count, as the album endpoints do while private mode is locked */
const albumViewAssets = (eb: ExpressionBuilder<DB, 'album'>) =>
  eb
    .selectFrom('album_asset')
    .innerJoin('asset', 'asset.id', 'album_asset.assetId')
    .select('asset.id')
    .whereRef('album_asset.albumId', '=', 'album.id')
    .where('asset.deletedAt', 'is', null)
    .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)])
    .where('asset.isPrivate', '=', false);

/**
 * Keeps album_view_state up to date for the users whose sync clients only receive the default view. Only albums that
 * changed since the last run are evaluated: their own row, their users, their asset links (tag changes and default
 * view rule changes touch these) or their assets moved past the checkpoint.
 */
class AlbumViewStateSync {
  constructor(private db: Kysely<DB>) {}

  /** where the next run starts: a few minutes back, so rows of transactions that committed late are seen too */
  @GenerateSql()
  getNextCheckpoint() {
    return this.db
      .selectNoFrom((eb) => [
        eb.fn<string>('immich_uuid_v7', [sql.raw<Date>("now() - interval '5 minutes'")]).as('updateId'),
      ])
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getCheckpoint(userId: string) {
    return this.db
      .selectFrom('album_view_state_checkpoint')
      .select('updateId')
      .where('userId', '=', userId)
      .executeTakeFirst();
  }

  /** the albums of the user that changed after `afterUpdateId` (all of them without it), with their state */
  @GenerateSql({ params: [DummyValue.UUID, dummyViewFilter, DummyValue.UUID] })
  getChanged(userId: string, view: ViewFilter, afterUpdateId?: string): Promise<AlbumViewStateRow[]> {
    return this.db
      .selectFrom('album')
      .innerJoin('album_user', (join) =>
        join.onRef('album_user.albumId', '=', 'album.id').on('album_user.userId', '=', userId),
      )
      .leftJoin('album_view_state', (join) =>
        join.onRef('album_view_state.albumId', '=', 'album.id').on('album_view_state.userId', '=', userId),
      )
      .select([
        'album.id as albumId',
        'album.albumThumbnailAssetId',
        'album_view_state.albumId as stateAlbumId',
        'album_view_state.isHidden as stateIsHidden',
        'album_view_state.thumbnailAssetId as stateThumbnailAssetId',
      ])
      .select((eb) => eb.exists(albumViewAssets(eb)).as('hasAssets'))
      .select((eb) => eb.exists(albumViewAssets(eb).where((eb) => viewAssetPredicate(eb, view))).as('hasVisibleAssets'))
      .select((eb) =>
        eb
          .case()
          .when('album.albumThumbnailAssetId', 'is', null)
          .then(eb.lit(null))
          .when(
            eb.exists(
              albumViewAssets(eb)
                .whereRef('asset.id', '=', 'album.albumThumbnailAssetId')
                .where((eb) => viewAssetPredicate(eb, view)),
            ),
          )
          .then(eb.ref('album.albumThumbnailAssetId'))
          // the same replacement cover the album endpoints pick
          .else(
            albumViewAssets(eb)
              .where((eb) => viewAssetPredicate(eb, view))
              .orderBy('asset.fileCreatedAt', 'desc')
              .limit(1),
          )
          .end()
          .as('visibleThumbnailAssetId'),
      )
      .$if(!!afterUpdateId, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('album.updateId', '>', afterUpdateId!),
            eb('album_user.updateId', '>', afterUpdateId!),
            eb(
              'album.id',
              'in',
              eb
                .selectFrom('album_asset')
                .select('album_asset.albumId')
                .where('album_asset.updateId', '>', afterUpdateId!),
            ),
            eb(
              'album.id',
              'in',
              eb
                .selectFrom('album_asset_audit')
                .select('album_asset_audit.albumId')
                .where('album_asset_audit.id', '>', afterUpdateId!),
            ),
            eb(
              'album.id',
              'in',
              eb
                .selectFrom('asset')
                .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
                .select('album_asset.albumId')
                .where('asset.updateId', '>', afterUpdateId!),
            ),
          ]),
        ),
      )
      .$castTo<AlbumViewStateRow>()
      .execute();
  }

  /** every state row of the user, for when no default view restricts the user anymore */
  @GenerateSql({ params: [DummyValue.UUID] })
  getAll(userId: string): Promise<AlbumViewStateRow[]> {
    return this.db
      .selectFrom('album_view_state')
      .innerJoin('album', 'album.id', 'album_view_state.albumId')
      .select([
        'album.id as albumId',
        'album.albumThumbnailAssetId',
        'album_view_state.albumId as stateAlbumId',
        'album_view_state.isHidden as stateIsHidden',
        'album_view_state.thumbnailAssetId as stateThumbnailAssetId',
      ])
      .select((eb) => [
        eb.lit(true).as('hasAssets'),
        eb.lit(true).as('hasVisibleAssets'),
        eb.ref('album.albumThumbnailAssetId').as('visibleThumbnailAssetId'),
      ])
      .where('album_view_state.userId', '=', userId)
      .$castTo<AlbumViewStateRow>()
      .execute();
  }

  /**
   * Writes the new state and hands out fresh updateIds for the albums whose state changed. Their updatedAt stays as it
   * is (preserve_updated_at), so apps that sort albums by modification do not move them. Albums shown again also get
   * their users and asset links touched, because the clients dropped those together with the album.
   */
  async update(userId: string, changes: AlbumViewStateChanges, checkpoint: string | null) {
    await this.db.transaction().execute(async (tx) => {
      if (changes.deletes.length > 0) {
        await tx
          .deleteFrom('album_view_state')
          .where('userId', '=', userId)
          .where('albumId', '=', anyUuid(changes.deletes))
          .execute();
      }

      if (changes.upserts.length > 0) {
        await tx
          .insertInto('album_view_state')
          .values(changes.upserts.map((row) => ({ ...row, userId })))
          .onConflict((oc) =>
            oc.columns(['albumId', 'userId']).doUpdateSet((eb) => ({
              isHidden: eb.ref('excluded.isHidden'),
              thumbnailAssetId: eb.ref('excluded.thumbnailAssetId'),
            })),
          )
          .execute();
      }

      if (changes.touched.length > 0) {
        await sql`SELECT set_config('immich.preserve_updated_at', 'on', true)`.execute(tx);
        await tx
          .updateTable('album')
          .set((eb) => ({ updateId: eb.fn<string>('immich_uuid_v7', []) }))
          .where('id', '=', anyUuid(changes.touched))
          .execute();
        await sql`SELECT set_config('immich.preserve_updated_at', '', true)`.execute(tx);
      }

      if (changes.shown.length > 0) {
        const now = sql<Date>`clock_timestamp()`;
        await tx
          .updateTable('album_user')
          .set({ updatedAt: now })
          .where('albumId', '=', anyUuid(changes.shown))
          .execute();
        await tx
          .updateTable('album_asset')
          .set({ updatedAt: now })
          .where('albumId', '=', anyUuid(changes.shown))
          .execute();
      }

      // rows of albums the user left
      await tx
        .deleteFrom('album_view_state')
        .where('userId', '=', userId)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('album_user')
                .whereRef('album_user.albumId', '=', 'album_view_state.albumId')
                .where('album_user.userId', '=', userId),
            ),
          ),
        )
        .execute();

      if (checkpoint) {
        await tx
          .insertInto('album_view_state_checkpoint')
          .values({ userId, updateId: checkpoint })
          .onConflict((oc) => oc.column('userId').doUpdateSet({ updateId: checkpoint }))
          .execute();
      } else {
        await tx.deleteFrom('album_view_state_checkpoint').where('userId', '=', userId).execute();
      }
    });
  }
}
