import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { ViewFilter } from 'src/database';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  CustomView,
  CustomViewActiveResponseDto,
  CustomViewActiveUpdateDto,
  CustomViewCreateDto,
  CustomViewResponseDto,
  CustomViewSearchDto,
  CustomViewUpdateDto,
  mapCustomView,
} from 'src/dtos/custom-view.dto';
import { Permission, ViewAccess } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { isPrivateMode, requirePrivateMode } from 'src/utils/access';
import { getPreferences } from 'src/utils/preferences';

/** Only the parts of a view that decide which assets pass it */
const toRuleKey = (view: ViewFilter | null | undefined) =>
  view
    ? JSON.stringify([
        view.includeAll,
        view.includeUntagged,
        [...view.includeTagIds].toSorted(),
        [...view.excludeTagIds].toSorted(),
        view.privateAssets,
      ])
    : null;

@Injectable()
export class CustomViewService extends BaseService {
  async getAll(auth: AuthDto, dto: CustomViewSearchDto): Promise<CustomViewResponseDto[]> {
    if (dto.tagId) {
      await this.requireAccess({ auth, permission: Permission.TagRead, ids: [dto.tagId] });
    }

    const views = await this.customViewRepository.getAll(auth.user.id, { tagId: dto.tagId });
    // private-mode-only views do not exist while private mode is locked
    return views.filter((view) => this.isListed(auth, view)).map((view) => mapCustomView(view));
  }

  async get(auth: AuthDto, id: string): Promise<CustomViewResponseDto> {
    const view = await this.findOrFail(auth, id, Permission.ViewRead);
    return mapCustomView(view);
  }

  async create(auth: AuthDto, dto: CustomViewCreateDto): Promise<CustomViewResponseDto> {
    // views name hidden tags, so they are only edited while private mode is unlocked
    requirePrivateMode(auth);

    const tags = await this.validateRules(auth, {
      includeTagIds: dto.includeTagIds ?? [],
      excludeTagIds: dto.excludeTagIds ?? [],
      access: dto.access ?? ViewAccess.Open,
      isDefault: dto.isDefault ?? false,
    });

    const userId = auth.user.id;
    const before = await this.customViewRepository.getDefault(userId);
    const id = await this.customViewRepository.create(
      {
        ownerId: userId,
        name: dto.name,
        order: dto.order,
        isDefault: dto.isDefault,
        access: dto.access,
        includeAll: dto.includeAll,
        includeUntagged: dto.includeUntagged,
        privateAssets: dto.privateAssets,
      },
      tags,
    );
    await this.onDefaultViewChange(userId, before);

    const view = await this.customViewRepository.get(id);
    return mapCustomView(view!);
  }

  async update(auth: AuthDto, id: string, dto: CustomViewUpdateDto): Promise<CustomViewResponseDto> {
    requirePrivateMode(auth);
    const existing = await this.findOrFail(auth, id, Permission.ViewUpdate);

    const hasTagRules = dto.includeTagIds !== undefined || dto.excludeTagIds !== undefined;
    const tags = await this.validateRules(auth, {
      includeTagIds: dto.includeTagIds ?? existing.includeTagIds,
      excludeTagIds: dto.excludeTagIds ?? existing.excludeTagIds,
      access: dto.access ?? existing.access,
      isDefault: dto.isDefault ?? existing.isDefault,
    });

    const userId = auth.user.id;
    const before = await this.customViewRepository.getDefault(userId);
    await this.customViewRepository.update(
      id,
      userId,
      {
        name: dto.name,
        order: dto.order,
        isDefault: dto.isDefault,
        access: dto.access,
        includeAll: dto.includeAll,
        includeUntagged: dto.includeUntagged,
        privateAssets: dto.privateAssets,
      },
      hasTagRules ? tags : undefined,
    );
    await this.onDefaultViewChange(userId, before);

    const view = await this.customViewRepository.get(id);
    return mapCustomView(view!);
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    requirePrivateMode(auth);
    await this.findOrFail(auth, id, Permission.ViewDelete);

    const userId = auth.user.id;
    const before = await this.customViewRepository.getDefault(userId);
    // sessions on this view fall back to the default view through the foreign key
    await this.customViewRepository.delete(id);
    await this.onDefaultViewChange(userId, before);
  }

  async getActive(auth: AuthDto): Promise<CustomViewActiveResponseDto> {
    const session = auth.session;
    if (!session || auth.apiKey || auth.sharedLink) {
      // API keys and shared links ignore views
      return { viewId: null, view: null, expiresAt: null };
    }

    const view = session.view ? await this.customViewRepository.get(session.view.id) : undefined;
    const current = session.viewId ? await this.sessionRepository.get(session.id) : undefined;
    const expiresAt = current?.viewExpiresAt;

    return {
      viewId: session.viewId ?? null,
      view: view ? mapCustomView(view) : null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
  }

  async setActive(auth: AuthDto, dto: CustomViewActiveUpdateDto): Promise<CustomViewActiveResponseDto> {
    const session = auth.session;
    if (!session || auth.apiKey) {
      throw new BadRequestException('This endpoint can only be used with a session token');
    }

    const current = await this.sessionRepository.get(session.id);
    // a private mode timeout that already passed must not send the new view back to the default right away
    const privateModeExpired =
      !!current?.privateModeExpiresAt && DateTime.fromJSDate(current.privateModeExpiresAt) <= DateTime.now();

    const view = dto.viewId ? await this.findOrFail(auth, dto.viewId, Permission.ViewRead) : undefined;
    if (!view || view.isDefault) {
      // switching back to the default view never needs anything
      await this.sessionRepository.update(session.id, {
        viewId: null,
        viewExpiresAt: null,
        ...(privateModeExpired && { privateModeExpiresAt: null }),
      });
      return this.toActiveResponse(null, view ?? (await this.getDefaultView(auth.user.id)), null);
    }

    if (view.access === ViewAccess.Locked) {
      await this.requirePinCode(auth.user.id, dto.pinCode);
    }

    const timeoutMinutes = await this.getTimeoutMinutes(auth.user.id);
    const expiresAt = isPrivateMode(auth)
      ? (current?.privateModeExpiresAt ?? DateTime.now().plus({ minutes: timeoutMinutes }).toJSDate())
      : DateTime.now().plus({ minutes: timeoutMinutes }).toJSDate();

    await this.sessionRepository.update(session.id, {
      viewId: view.id,
      viewExpiresAt: expiresAt,
      ...(privateModeExpired && { privateModeExpiresAt: null }),
    });

    return this.toActiveResponse(view.id, view, expiresAt);
  }

  private toActiveResponse(
    viewId: string | null,
    view: CustomView | undefined,
    expiresAt: Date | null,
  ): CustomViewActiveResponseDto {
    return {
      viewId,
      view: view ? mapCustomView(view) : null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
  }

  private async getDefaultView(userId: string) {
    const filter = await this.customViewRepository.getDefault(userId);
    return filter ? this.customViewRepository.get(filter.id) : undefined;
  }

  private isListed(auth: AuthDto, view: Pick<CustomView, 'access'>) {
    return view.access !== ViewAccess.Private || isPrivateMode(auth);
  }

  private async findOrFail(auth: AuthDto, id: string, permission: Permission) {
    await this.requireAccess({ auth, permission, ids: [id] });
    const view = await this.customViewRepository.get(id);
    if (!view || !this.isListed(auth, view)) {
      throw new BadRequestException('View not found');
    }
    return view;
  }

  private async validateRules(
    auth: AuthDto,
    rules: { includeTagIds: string[]; excludeTagIds: string[]; access: ViewAccess; isDefault: boolean },
  ) {
    const includeTagIds = [...new Set(rules.includeTagIds)];
    const excludeTagIds = [...new Set(rules.excludeTagIds)];

    const overlap = includeTagIds.filter((tagId) => excludeTagIds.includes(tagId));
    if (overlap.length > 0) {
      throw new BadRequestException('A tag cannot be both included and excluded');
    }

    if (rules.isDefault && rules.access !== ViewAccess.Open) {
      throw new BadRequestException('The default view cannot require a PIN code or private mode');
    }

    await this.requireAccess({ auth, permission: Permission.TagRead, ids: [...includeTagIds, ...excludeTagIds] });

    return { includeTagIds, excludeTagIds };
  }

  private async requirePinCode(userId: string, pinCode?: string) {
    const user = await this.userRepository.getForPinCode(userId);
    if (!user.pinCode) {
      throw new BadRequestException('User does not have a PIN code');
    }

    if (!pinCode) {
      throw new UnauthorizedException('PIN code is required to switch to this view');
    }

    if (!this.cryptoRepository.compareBcrypt(pinCode, user.pinCode)) {
      throw new BadRequestException('Wrong PIN code');
    }
  }

  private async getTimeoutMinutes(userId: string) {
    const metadata = await this.userRepository.getMetadata(userId);
    return getPreferences(metadata).privateMode.timeoutMinutes;
  }

  /**
   * Clients without the views sync flag only receive the default view, so every asset that moved in or out of it
   * gets a fresh updateId and is sent again (or withheld with a delete).
   */
  private async onDefaultViewChange(userId: string, before: ViewFilter | undefined) {
    const after = await this.customViewRepository.getDefault(userId);
    if (toRuleKey(before) === toRuleKey(after)) {
      return;
    }

    const assetIds = await this.customViewRepository.getChangedAssetIds(userId, before ?? null, after ?? null);
    await this.customViewRepository.touchAssets(assetIds);
    this.logger.debug(`Default view of ${userId} changed, ${assetIds.length} asset(s) re-sent to sync clients`);
  }
}
