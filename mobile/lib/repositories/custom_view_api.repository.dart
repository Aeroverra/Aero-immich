import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:openapi/api.dart' as api;

final customViewApiRepositoryProvider = Provider<CustomViewApiRepository>(
  (ref) => CustomViewApiRepository(ref.watch(apiServiceProvider).customViewsApi),
);

/// The server session's view: the switched view (null for the default one) and when it falls back to the default
class ActiveCustomView {
  final String? viewId;
  final DateTime? expiresAt;

  const ActiveCustomView({this.viewId, this.expiresAt});
}

/// Why switching to a view was refused
enum CustomViewSwitchError {
  /// a locked view and no PIN code was sent
  pinRequired,

  /// a locked view and the PIN code is wrong
  wrongPin,

  /// the view does not exist or needs private mode
  notFound,
}

class CustomViewSwitchException implements Exception {
  final CustomViewSwitchError error;

  const CustomViewSwitchException(this.error);

  @override
  String toString() => 'CustomViewSwitchException(${error.name})';
}

class CustomViewApiRepository extends ApiRepository {
  final api.CustomViewsApi _api;

  const CustomViewApiRepository(this._api);

  /// The views of the user; views with private access only while private mode is unlocked. [tagId] lists the views
  /// that name the tag.
  Future<List<CustomView>> getAll({String? tagId}) async {
    final dtos = await checkNull(_api.getCustomViews(tagId: tagId));
    return dtos.map(_toModel).toList();
  }

  Future<CustomView> create(CustomView view) async {
    final dto = await checkNull(
      _api.createCustomView(
        api.CustomViewCreateDto(
          name: view.name,
          order: api.Optional.present(view.order),
          isDefault: api.Optional.present(view.isDefault),
          access: api.Optional.present(view.access.toDto()),
          includeAll: api.Optional.present(view.includeAll),
          includeUntagged: api.Optional.present(view.includeUntagged),
          includeTagIds: api.Optional.present(view.includeTagIds),
          excludeTagIds: api.Optional.present(view.excludeTagIds),
          privateAssets: api.Optional.present(view.privateAssets.toDto()),
        ),
      ),
    );
    return _toModel(dto);
  }

  Future<CustomView> update(CustomView view) async {
    final dto = await checkNull(
      _api.updateCustomView(
        view.id,
        api.CustomViewUpdateDto(
          name: api.Optional.present(view.name),
          order: api.Optional.present(view.order),
          isDefault: api.Optional.present(view.isDefault),
          access: api.Optional.present(view.access.toDto()),
          includeAll: api.Optional.present(view.includeAll),
          includeUntagged: api.Optional.present(view.includeUntagged),
          includeTagIds: api.Optional.present(view.includeTagIds),
          excludeTagIds: api.Optional.present(view.excludeTagIds),
          privateAssets: api.Optional.present(view.privateAssets.toDto()),
        ),
      ),
    );
    return _toModel(dto);
  }

  /// Saves only the order of [view]
  Future<void> updateOrder(String viewId, int order) {
    return _api.updateCustomView(viewId, api.CustomViewUpdateDto(order: api.Optional.present(order)));
  }

  Future<void> delete(String viewId) => _api.deleteCustomView(viewId);

  Future<ActiveCustomView> getActive() async {
    final dto = await checkNull(_api.getActiveCustomView());
    return ActiveCustomView(viewId: dto.viewId, expiresAt: dto.expiresAt);
  }

  /// Switches the session to [viewId], or back to the default view with null. Throws [CustomViewSwitchException] when
  /// the server refuses.
  Future<ActiveCustomView> setActive(String? viewId, {String? pinCode}) async {
    try {
      final dto = await checkNull(
        _api.setActiveCustomView(
          api.CustomViewActiveUpdateDto(
            viewId: viewId,
            pinCode: pinCode == null ? const api.Optional.absent() : api.Optional.present(pinCode),
          ),
        ),
      );
      return ActiveCustomView(viewId: dto.viewId, expiresAt: dto.expiresAt);
    } on api.ApiException catch (error) {
      if (error.code == 401) {
        throw const CustomViewSwitchException(CustomViewSwitchError.pinRequired);
      }
      if (error.code == 400) {
        final message = error.message ?? '';
        throw CustomViewSwitchException(
          message.contains('PIN') ? CustomViewSwitchError.wrongPin : CustomViewSwitchError.notFound,
        );
      }
      rethrow;
    }
  }

  static CustomView _toModel(api.CustomViewResponseDto dto) => CustomView(
    id: dto.id,
    ownerId: '',
    name: dto.name,
    order: dto.order,
    isDefault: dto.isDefault,
    access: switch (dto.access) {
      api.ViewAccess.open => ViewAccess.open,
      api.ViewAccess.private => ViewAccess.private,
      _ => ViewAccess.locked,
    },
    includeAll: dto.includeAll,
    includeUntagged: dto.includeUntagged,
    privateAssets: switch (dto.privateAssets) {
      api.ViewPrivateAssets.unlocked => ViewPrivateAssets.unlocked,
      api.ViewPrivateAssets.only => ViewPrivateAssets.only,
      _ => ViewPrivateAssets.hide,
    },
    includeTagIds: dto.includeTagIds,
    excludeTagIds: dto.excludeTagIds,
  );
}

extension on ViewAccess {
  api.ViewAccess toDto() => switch (this) {
    ViewAccess.open => api.ViewAccess.open,
    ViewAccess.locked => api.ViewAccess.locked,
    ViewAccess.private => api.ViewAccess.private,
  };
}

extension on ViewPrivateAssets {
  api.ViewPrivateAssets toDto() => switch (this) {
    ViewPrivateAssets.hide => api.ViewPrivateAssets.hide_,
    ViewPrivateAssets.unlocked => api.ViewPrivateAssets.unlocked,
    ViewPrivateAssets.only => api.ViewPrivateAssets.only,
  };
}
