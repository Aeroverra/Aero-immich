import { BadRequestException, Injectable } from '@nestjs/common';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { StackCreateDto, StackResponseDto, StackSearchDto, StackUpdateDto, mapStack } from 'src/dtos/stack.dto';
import { Permission, StackSource, StackUserEditAction } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { getActiveView, toPrivateScope } from 'src/utils/access';
import { isViewUnrestricted } from 'src/utils/database';
import { findOrFail } from 'src/utils/misc';
import { UUIDAssetIDParamDto } from 'src/validation';

@Injectable()
export class StackService extends BaseService {
  async search(auth: AuthDto, dto: StackSearchDto): Promise<StackResponseDto[]> {
    const stacks = await this.stackRepository.search(
      {
        ownerId: auth.user.id,
        primaryAssetId: dto.primaryAssetId,
      },
      toPrivateScope(auth),
    );

    return (
      stacks
        // a stack whose primary asset is hidden by private mode is hidden as a whole; a view hides a stack only when
        // it hides every member, and the first visible member stands in for a hidden primary asset
        .filter((stack) =>
          isViewUnrestricted(getActiveView(auth))
            ? stack.assets.some(({ id }) => id === stack.primaryAssetId)
            : stack.assets.length > 0,
        )
        .map((stack) => mapStack(stack, { auth }))
    );
  }

  async create(auth: AuthDto, dto: StackCreateDto): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds });

    const previousStacks = await this.stackRepository.getForUserEdit({ assetIds: dto.assetIds });
    const stack = await this.stackRepository.create({ ownerId: auth.user.id }, dto.assetIds, toPrivateScope(auth));

    // a stack is never half private: one private member makes every member private
    if (stack.assets.some(({ isPrivate }) => isPrivate)) {
      const assetIds = stack.assets.filter(({ isPrivate }) => !isPrivate).map(({ id }) => id);
      if (assetIds.length > 0) {
        await this.assetRepository.updateAll(assetIds, { isPrivate: true });
        await this.eventRepository.emit('AssetPrivateUpdateAll', { assetIds, userId: auth.user.id });
      }
      for (const asset of stack.assets) {
        asset.isPrivate = true;
      }
    }

    await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: auth.user.id });

    // a stack whose primary asset was passed moves into the new stack as a whole, any other stack only loses the
    // assets that were passed
    for (const previous of previousStacks) {
      const memberIds = previous.assets.map(({ id }) => id);
      const assetIds = dto.assetIds.includes(previous.primaryAssetId)
        ? memberIds
        : memberIds.filter((id) => dto.assetIds.includes(id));
      await this.eventRepository.emit('StackUserEdit', {
        userId: auth.user.id,
        stackId: previous.id,
        source: previous.source,
        action: StackUserEditAction.Merge,
        assetIds,
        targetStackId: stack.id,
      });
    }

    return mapStack(stack, { auth });
  }

  async get(auth: AuthDto, id: string): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.StackRead, ids: [id] });
    const stack = await this.findOrFail(id, auth);
    return mapStack(stack, { auth });
  }

  async update(auth: AuthDto, id: string, dto: StackUpdateDto): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.StackUpdate, ids: [id] });
    const stack = await this.findOrFail(id, auth);
    if (dto.primaryAssetId && stack.assets.every(({ id }) => id !== dto.primaryAssetId)) {
      throw new BadRequestException('Primary asset must be in the stack');
    }

    const updatedStack = await this.stackRepository.update(
      id,
      { id, primaryAssetId: dto.primaryAssetId },
      toPrivateScope(auth),
    );

    await this.eventRepository.emit('StackUpdate', { stackId: id, userId: auth.user.id });

    if (dto.primaryAssetId && dto.primaryAssetId !== stack.primaryAssetId) {
      await this.eventRepository.emit('StackUserEdit', {
        userId: auth.user.id,
        stackId: id,
        source: stack.source,
        action: StackUserEditAction.UpdatePrimary,
        assetIds: [dto.primaryAssetId],
      });
    }

    return mapStack(updatedStack, { auth });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: [id] });
    const stacks = await this.stackRepository.getForUserEdit({ stackIds: [id] });
    await this.stackRepository.delete(id);
    await this.eventRepository.emit('StackDelete', { stackId: id, userId: auth.user.id });
    await this.emitDeleted(auth, stacks);
  }

  async deleteAll(auth: AuthDto, dto: BulkIdsDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: dto.ids });
    const stacks = await this.stackRepository.getForUserEdit({ stackIds: dto.ids });
    await this.stackRepository.deleteAll(dto.ids);
    await this.eventRepository.emit('StackDeleteAll', { stackIds: dto.ids, userId: auth.user.id });
    await this.emitDeleted(auth, stacks);
  }

  async removeAsset(auth: AuthDto, dto: UUIDAssetIDParamDto): Promise<void> {
    const { id: stackId, assetId } = dto;
    await this.requireAccess({ auth, permission: Permission.StackUpdate, ids: [stackId] });

    const stack = await this.stackRepository.getForAssetRemoval(assetId);

    if (!stack?.id || stack.id !== stackId) {
      throw new BadRequestException('Asset not in stack');
    }

    if (stack.primaryAssetId === assetId) {
      throw new BadRequestException("Cannot remove stack's primary asset");
    }

    await this.assetRepository.update({ id: assetId, stackId: null });
    await this.eventRepository.emit('StackUpdate', { stackId, userId: auth.user.id });
    await this.eventRepository.emit('StackUserEdit', {
      userId: auth.user.id,
      stackId,
      source: stack.source!,
      action: StackUserEditAction.RemoveAssets,
      assetIds: [assetId],
    });
  }

  private async emitDeleted(
    auth: AuthDto,
    stacks: Array<{ id: string; source: StackSource; assets: { id: string }[] }>,
  ) {
    for (const stack of stacks) {
      await this.eventRepository.emit('StackUserEdit', {
        userId: auth.user.id,
        stackId: stack.id,
        source: stack.source,
        action: StackUserEditAction.Delete,
        assetIds: stack.assets.map(({ id }) => id),
      });
    }
  }

  private findOrFail(id: string, auth: AuthDto) {
    return findOrFail(() => this.stackRepository.getById(id, toPrivateScope(auth)), 'Asset stack');
  }
}
