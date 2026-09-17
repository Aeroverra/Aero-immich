import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { hash } from 'bcrypt';
import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetVisibility, Permission, StackSource, ViewAccess, ViewPrivateAssets } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { ConfigRepository } from 'src/repositories/config.repository';
import { CryptoRepository } from 'src/repositories/crypto.repository';
import { CustomViewRepository } from 'src/repositories/custom-view.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { SessionRepository } from 'src/repositories/session.repository';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository';
import { TagRepository } from 'src/repositories/tag.repository';
import { TelemetryRepository } from 'src/repositories/telemetry.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { AlbumService } from 'src/services/album.service';
import { AssetService } from 'src/services/asset.service';
import { AuthService } from 'src/services/auth.service';
import { CustomViewService } from 'src/services/custom-view.service';
import { StackService } from 'src/services/stack.service';
import { TagService } from 'src/services/tag.service';
import { TimelineService } from 'src/services/timeline.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const pinCode = '123456';
const metadata = { adminRoute: false, sharedLinkRoute: false, uri: '/timeline' };

const options = () => ({
  database: defaultDatabase,
  real: [
    AccessRepository,
    AlbumRepository,
    AssetRepository,
    ConfigRepository,
    CryptoRepository,
    CustomViewRepository,
    PartnerRepository,
    SessionRepository,
    SharedLinkRepository,
    StackRepository,
    SystemMetadataRepository,
    TagRepository,
    UserRepository,
  ],
  mock: [LoggingRepository, EventRepository, StorageRepository, TelemetryRepository],
});

const setup = () => {
  const { sut, ctx } = newMediumService(CustomViewService, options());
  return {
    sut,
    ctx,
    auth: newMediumService(AuthService, options()).sut,
    timeline: newMediumService(TimelineService, options()).sut,
    albums: newMediumService(AlbumService, options()).sut,
    assets: newMediumService(AssetService, options()).sut,
    stacks: newMediumService(StackService, options()).sut,
    tags: newMediumService(TagService, options()).sut,
  };
};

type Setup = ReturnType<typeof setup>;

/**
 * A user with a PIN and a login session, tags Family, Family/Kids, Gym and Secret (hidden) with Secret/Deep, and
 * assets: untagged, family, kids, gym, family + gym, a private untagged one, and one tagged Secret/Deep
 */
const newLibrary = async ({ ctx, auth }: Setup) => {
  const { user } = await ctx.newUser({ pinCode: await hash(pinCode, 10) });
  const { session } = await ctx.newSession({ userId: user.id });
  // sessionInsert stores sha256(id) as the token, so the bearer token is the raw session id
  const headers = { authorization: `Bearer ${session.id}` };
  const login = () => auth.authenticate({ headers, queryParams: {}, metadata });

  const tagRepository = ctx.get(TagRepository);
  const family = await tagRepository.create({ userId: user.id, value: 'Family' });
  const kids = await tagRepository.create({ userId: user.id, value: 'Family/Kids', parentId: family.id });
  const gym = await tagRepository.create({ userId: user.id, value: 'Gym' });
  const secret = await tagRepository.create({ userId: user.id, value: 'Secret', isHidden: true });
  const deep = await tagRepository.create({ userId: user.id, value: 'Secret/Deep', parentId: secret.id });

  const newAsset = async (day: number, tagIds: string[], isPrivate = false) => {
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      isPrivate,
      localDateTime: new Date(`1970-02-${String(day).padStart(2, '0')}`),
      fileCreatedAt: new Date(`1970-02-${String(day).padStart(2, '0')}`),
    });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    if (tagIds.length > 0) {
      await ctx.newTagAsset({ tagIds, assetIds: [asset.id] });
    }
    return asset;
  };

  const assets = {
    untagged: await newAsset(1, []),
    family: await newAsset(2, [family.id]),
    kids: await newAsset(3, [kids.id]),
    gym: await newAsset(4, [gym.id]),
    familyGym: await newAsset(5, [family.id, gym.id]),
    private: await newAsset(6, [], true),
    secret: await newAsset(7, [deep.id]),
  };

  return { ctx, user, session, headers, login, tags: { family, kids, gym, secret, deep }, assets };
};

const unlock = async ({ auth }: Setup, login: () => Promise<AuthDto>) => {
  await auth.enablePrivateMode(await login(), { pinCode });
  return login();
};

/** the ids of every asset the timeline shows for February 1970 */
const timelineIds = async ({ timeline }: Setup, auth: AuthDto, options: { withStacked?: boolean } = {}) => {
  const buckets = await timeline.getTimeBuckets(auth, options);
  const bucket = buckets.find(({ timeBucket }) => timeBucket === '1970-02-01');
  if (!bucket) {
    return [];
  }
  const response = JSON.parse(await timeline.getTimeBucket(auth, { timeBucket: '1970-02-01', ...options }));
  expect(response.id).toHaveLength(bucket.count);
  return response.id as string[];
};

const sortedTimelineIds = async (context: Setup, login: () => Promise<AuthDto>) => {
  const ids = await timelineIds(context, await login());
  return ids.toSorted();
};

const activeViewId = async (login: () => Promise<AuthDto>) => {
  const auth = await login();
  return auth.session?.viewId;
};

const viewNames = async ({ sut }: Setup, auth: AuthDto) => {
  const views = await sut.getAll(auth, {});
  return views.map(({ name }) => name);
};

const tagValues = async ({ tags }: Setup, auth: AuthDto) => {
  const response = await tags.getAll(auth);
  return response.map(({ value }) => value);
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(CustomViewService.name, () => {
  describe('rules', () => {
    it('should show everything, like before views, while the user has no views', async () => {
      const context = setup();
      const { login, assets } = await newLibrary(context);

      const ids = await timelineIds(context, await login());
      expect(ids).toHaveLength(6);
      expect(ids).not.toContain(assets.private.id);
    });

    it('should apply the default view, with exclude winning and private assets hidden', async () => {
      const context = setup();
      const { login, assets, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      await context.sut.create(unlocked, {
        name: 'Default',
        isDefault: true,
        includeAll: true,
        excludeTagIds: [tags.gym.id],
        privateAssets: ViewPrivateAssets.Hide,
      });

      // private mode is on, but the default view hides private assets anyway
      const ids = await timelineIds(context, await login());
      expect(ids.toSorted()).toEqual(
        [assets.untagged.id, assets.family.id, assets.kids.id, assets.secret.id].toSorted(),
      );
    });

    it('should include children of an include tag and evaluate hidden tags for untagged', async () => {
      const context = setup();
      const { login, assets, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      const familyView = await context.sut.create(unlocked, { name: 'Family', includeTagIds: [tags.family.id] });
      const untaggedView = await context.sut.create(unlocked, { name: 'Untagged', includeUntagged: true });
      const onlyPrivate = await context.sut.create(unlocked, {
        name: 'Private',
        includeAll: true,
        privateAssets: ViewPrivateAssets.Only,
      });

      await context.sut.setActive(unlocked, { viewId: familyView.id });
      expect(await sortedTimelineIds(context, login)).toEqual(
        [assets.family.id, assets.kids.id, assets.familyGym.id].toSorted(),
      );

      await context.sut.setActive(unlocked, { viewId: untaggedView.id });
      // the Secret/Deep asset looks untagged while locked, but the rule sees the real tag
      expect(await sortedTimelineIds(context, login)).toEqual([assets.untagged.id, assets.private.id].toSorted());

      await context.sut.setActive(unlocked, { viewId: onlyPrivate.id });
      expect(await timelineIds(context, await login())).toEqual([assets.private.id]);
    });

    it('should only let partner assets through everything or untagged', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { user, login, tags } = await newLibrary(context);
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id, inTimeline: true });
      const { asset: partnerAsset } = await ctx.newAsset({
        ownerId: partner.id,
        localDateTime: new Date('1970-02-20'),
      });
      await ctx.newExif({ assetId: partnerAsset.id, make: 'Canon' });

      const unlocked = await unlock(context, login);
      const familyView = await sut.create(unlocked, { name: 'Family', includeTagIds: [tags.family.id] });
      const untaggedView = await sut.create(unlocked, { name: 'Untagged', includeUntagged: true });

      const withPartners = async () => {
        const auth = await login();
        const buckets = await context.timeline.getTimeBuckets(auth, {
          withPartners: true,
          userId: user.id,
          visibility: AssetVisibility.Timeline,
        });
        const response = JSON.parse(
          await context.timeline.getTimeBucket(auth, {
            timeBucket: buckets[0].timeBucket,
            withPartners: true,
            userId: user.id,
            visibility: AssetVisibility.Timeline,
          }),
        );
        return response.id as string[];
      };

      await sut.setActive(unlocked, { viewId: familyView.id });
      expect(await withPartners()).not.toContain(partnerAsset.id);
      await sut.setActive(unlocked, { viewId: untaggedView.id });
      expect(await withPartners()).toContain(partnerAsset.id);
    });

    it('should ignore views for API keys', async () => {
      const context = setup();
      const { user, login, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      await context.sut.create(unlocked, { name: 'Default', isDefault: true, includeTagIds: [tags.family.id] });

      expect(await timelineIds(context, await login())).toHaveLength(3);
      const apiKey = factory.auth({ user, apiKey: { permissions: [Permission.All] } });
      expect(await timelineIds(context, apiKey)).toHaveLength(6);
    });

    it('should treat an asset the view hides as not found', async () => {
      const context = setup();
      const { login, assets, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      await context.sut.create(unlocked, { name: 'Default', isDefault: true, includeTagIds: [tags.family.id] });

      const auth = await login();
      await expect(context.assets.get(auth, assets.family.id)).resolves.toMatchObject({ id: assets.family.id });
      await expect(context.assets.get(auth, assets.gym.id)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('switching', () => {
    it('should require the PIN on every switch to a locked view', async () => {
      const context = setup();
      const { login, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      const locked = await context.sut.create(unlocked, {
        name: 'Gym',
        access: ViewAccess.Locked,
        includeTagIds: [tags.gym.id],
      });
      await context.auth.disablePrivateMode(unlocked);

      const auth = await login();
      await expect(context.sut.setActive(auth, { viewId: locked.id })).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(context.sut.setActive(auth, { viewId: locked.id, pinCode: '000000' })).rejects.toThrow(
        'Wrong PIN code',
      );
      await expect(context.sut.setActive(auth, { viewId: locked.id, pinCode })).resolves.toMatchObject({
        viewId: locked.id,
      });
      expect(await timelineIds(context, await login())).toHaveLength(2);

      // back to the default without anything, and the PIN again on the next switch
      await context.sut.setActive(await login(), { viewId: null });
      await expect(context.sut.setActive(await login(), { viewId: locked.id })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('should only list and switch to private views while private mode is unlocked', async () => {
      const context = setup();
      const { login } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      const hidden = await context.sut.create(unlocked, {
        name: 'Hidden',
        access: ViewAccess.Private,
        includeAll: true,
      });
      await context.sut.create(unlocked, { name: 'Open', includeAll: true });
      expect(await viewNames(context, unlocked)).toEqual(['Hidden', 'Open']);

      await context.auth.disablePrivateMode(unlocked);
      const locked = await login();
      expect(await viewNames(context, locked)).toEqual(['Open']);
      await expect(context.sut.get(locked, hidden.id)).rejects.toThrow('View not found');
      await expect(context.sut.setActive(locked, { viewId: hidden.id })).rejects.toThrow('View not found');
    });

    it('should require private mode to edit views', async () => {
      const context = setup();
      const { login } = await newLibrary(context);
      await expect(context.sut.create(await login(), { name: 'Nope', includeAll: true })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('should reject a default view that needs a PIN and a tag both included and excluded', async () => {
      const context = setup();
      const { login, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      await expect(
        context.sut.create(unlocked, { name: 'Bad', isDefault: true, access: ViewAccess.Locked, includeAll: true }),
      ).rejects.toThrow('The default view cannot require a PIN code or private mode');
      await expect(
        context.sut.create(unlocked, { name: 'Bad', includeTagIds: [tags.gym.id], excludeTagIds: [tags.gym.id] }),
      ).rejects.toThrow('A tag cannot be both included and excluded');
    });

    it('should fall back to the default view when private mode locks', async () => {
      const context = setup();
      const { login, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      const view = await context.sut.create(unlocked, { name: 'Gym', includeTagIds: [tags.gym.id] });
      await context.sut.setActive(unlocked, { viewId: view.id });
      expect(await activeViewId(login)).toBe(view.id);

      await context.auth.disablePrivateMode(await login());
      const auth = await login();
      expect(auth.session?.viewId).toBeUndefined();
      expect(await timelineIds(context, auth)).toHaveLength(6);
    });

    it('should fall back to the default view when the private mode timeout passes', async () => {
      const context = setup();
      const { ctx, login, session, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      const view = await context.sut.create(unlocked, { name: 'Gym', includeTagIds: [tags.gym.id] });
      await context.sut.setActive(unlocked, { viewId: view.id });

      const past = DateTime.now().minus({ minutes: 1 }).toJSDate();
      await ctx.get(SessionRepository).update(session.id, { privateModeExpiresAt: past });
      const auth = await login();
      expect(auth.session).toEqual({ id: session.id, hasElevatedPermission: false, privateMode: false });

      // the relock is consumed: a new switch while locked is not reset right away
      await context.sut.setActive(auth, { viewId: view.id });
      expect(await activeViewId(login)).toBe(view.id);
    });

    it('should fall back to the default view when the view timeout passes without private mode', async () => {
      const context = setup();
      const { ctx, login, session, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      const view = await context.sut.create(unlocked, { name: 'Gym', includeTagIds: [tags.gym.id] });
      await context.auth.disablePrivateMode(unlocked);

      const response = await context.sut.setActive(await login(), { viewId: view.id });
      const expiresAt = DateTime.fromISO(response.expiresAt!);
      expect(expiresAt.diffNow('minutes').minutes).toBeGreaterThan(25);
      expect(await activeViewId(login)).toBe(view.id);

      await ctx
        .get(SessionRepository)
        .update(session.id, { viewExpiresAt: DateTime.now().minus({ seconds: 1 }).toJSDate() });
      expect(await activeViewId(login)).toBeUndefined();
    });

    it('should return to the default view when the active view is deleted', async () => {
      const context = setup();
      const { login, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      const view = await context.sut.create(unlocked, { name: 'Gym', includeTagIds: [tags.gym.id] });
      await context.sut.setActive(unlocked, { viewId: view.id });
      await context.sut.delete(await login(), view.id);
      await expect(context.sut.getActive(await login())).resolves.toEqual({
        viewId: null,
        view: null,
        expiresAt: null,
      });
    });

    it('should touch the assets that moved in or out of the default view', async () => {
      const context = setup();
      const { ctx, login, assets, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      const updateIds = async () => {
        const rows = await ctx.database.selectFrom('asset').select(['id', 'updateId']).execute();
        return new Map(rows.map(({ id, updateId }) => [id, updateId]));
      };

      const before = await updateIds();
      const view = await context.sut.create(unlocked, {
        name: 'Default',
        isDefault: true,
        includeAll: true,
        excludeTagIds: [tags.gym.id],
      });
      const after = await updateIds();
      expect(after.get(assets.gym.id)).not.toBe(before.get(assets.gym.id));
      expect(after.get(assets.familyGym.id)).not.toBe(before.get(assets.familyGym.id));
      expect(after.get(assets.family.id)).toBe(before.get(assets.family.id));

      // renaming changes nothing about which assets pass
      await context.sut.update(await login(), view.id, { name: 'Renamed' });
      expect(await updateIds()).toEqual(after);
    });
  });

  describe('albums', () => {
    it('should compute counts and covers from visible assets and hide albums without any', async () => {
      const context = setup();
      const { ctx, user, login, assets, tags } = await newLibrary(context);
      const { album: mixed } = await ctx.newAlbum({ ownerId: user.id, albumThumbnailAssetId: assets.gym.id }, [
        assets.gym.id,
        assets.family.id,
      ]);
      const { album: gymOnly } = await ctx.newAlbum({ ownerId: user.id }, [assets.gym.id]);
      const { album: empty } = await ctx.newAlbum({ ownerId: user.id });

      const unlocked = await unlock(context, login);
      await context.sut.create(unlocked, {
        name: 'Default',
        isDefault: true,
        includeAll: true,
        excludeTagIds: [tags.gym.id],
      });

      const locked = await (async () => {
        await context.auth.disablePrivateMode(await login());
        return login();
      })();
      const list = await context.albums.getAll(locked, {});
      expect(list.map(({ id }) => id).toSorted()).toEqual([mixed.id, empty.id].toSorted());
      const mixedResponse = list.find(({ id }) => id === mixed.id)!;
      expect(mixedResponse).toMatchObject({ assetCount: 1, albumThumbnailAssetId: assets.family.id });
      expect(mixedResponse.hiddenByViewCount).toBeUndefined();

      await expect(context.albums.get(locked, gymOnly.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(context.albums.getStatistics(locked)).resolves.toMatchObject({ owned: 2 });

      const unlockedAgain = await unlock(context, login);
      await expect(context.albums.get(unlockedAgain, mixed.id)).resolves.toMatchObject({
        assetCount: 1,
        hiddenByViewCount: 1,
      });
    });
  });

  describe('stacks', () => {
    it('should represent a stack by its first visible member when the view hides the primary asset', async () => {
      const context = setup();
      const { ctx, user, login, assets, tags } = await newLibrary(context);
      const { stack } = await ctx.newStack({ ownerId: user.id, source: StackSource.Manual }, [
        assets.gym.id,
        assets.family.id,
        assets.kids.id,
      ]);
      const { stack: allHidden } = await ctx.newStack({ ownerId: user.id }, [assets.familyGym.id, assets.secret.id]);

      const unlocked = await unlock(context, login);
      await context.sut.create(unlocked, {
        name: 'Default',
        isDefault: true,
        includeAll: true,
        excludeTagIds: [tags.gym.id, tags.secret.id],
      });

      const auth = await login();
      const response = JSON.parse(
        await context.timeline.getTimeBucket(auth, { timeBucket: '1970-02-01', withStacked: true }),
      );
      expect(response.id).toContain(assets.family.id);
      expect(response.id).not.toContain(assets.gym.id);
      expect(response.id).not.toContain(assets.kids.id);
      expect(response.id).not.toContain(assets.familyGym.id);
      const index = response.id.indexOf(assets.family.id);
      expect(response.stack[index]).toEqual([stack.id, '2']);

      const buckets = await context.timeline.getTimeBuckets(auth, { withStacked: true });
      expect(buckets).toEqual([{ timeBucket: '1970-02-01', count: response.id.length }]);

      await expect(context.stacks.get(auth, stack.id)).resolves.toMatchObject({ primaryAssetId: assets.family.id });
      const stacks = await context.stacks.search(auth, {});
      expect(stacks.map(({ id }) => id)).toEqual([stack.id]);
      expect(stacks.map(({ id }) => id)).not.toContain(allHidden.id);
    });
  });

  describe('hidden tags', () => {
    it('should leave hidden tags and their children out while private mode is locked', async () => {
      const context = setup();
      const { login, assets, tags } = await newLibrary(context);

      const locked = await login();
      expect(await tagValues(context, locked)).toEqual(['Family', 'Family/Kids', 'Gym']);
      await expect(context.tags.get(locked, tags.deep.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(context.assets.get(locked, assets.secret.id)).resolves.toMatchObject({ tags: [] });

      const unlocked = await unlock(context, login);
      expect(await tagValues(context, unlocked)).toEqual(['Family', 'Family/Kids', 'Gym', 'Secret', 'Secret/Deep']);
      await expect(context.assets.get(unlocked, assets.secret.id)).resolves.toMatchObject({
        tags: [expect.objectContaining({ value: 'Secret/Deep', isHidden: true })],
      });
    });

    it('should list the views that use a tag or one of its children', async () => {
      const context = setup();
      const { login, tags } = await newLibrary(context);
      const unlocked = await unlock(context, login);
      await context.sut.create(unlocked, { name: 'Kids', includeTagIds: [tags.kids.id] });
      await context.sut.create(unlocked, { name: 'Gym', includeTagIds: [tags.gym.id] });

      const views = await context.sut.getAll(unlocked, { tagId: tags.family.id });
      expect(views.map(({ name }) => name)).toEqual(['Kids']);
    });

    it('should keep a tag a view uses when the tag cleanup runs', async () => {
      const context = setup();
      const { ctx, user, login } = await newLibrary(context);
      const unused = await ctx.get(TagRepository).create({ userId: user.id, value: 'Unused' });
      const named = await ctx.get(TagRepository).create({ userId: user.id, value: 'Reviewed' });
      const unlocked = await unlock(context, login);
      await context.sut.create(unlocked, { name: 'Reviewed', includeTagIds: [named.id] });

      await ctx.get(TagRepository).deleteEmptyTags();
      await expect(ctx.get(TagRepository).get(unused.id)).resolves.toBeUndefined();
      await expect(ctx.get(TagRepository).get(named.id)).resolves.toBeDefined();
    });
  });
});
