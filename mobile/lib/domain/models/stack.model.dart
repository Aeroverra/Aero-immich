import 'package:flutter/foundation.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

part 'stack.model.freezed.dart';

/// How a stack was created. Do not change the order, the value is stored as its index.
enum StackSource {
  /// created by a user or a client such as an importer
  manual,

  /// created by the server from similar photos taken close together
  auto,
}

// Model for a stack stored in the server
@freezed
abstract class Stack with _$Stack {
  const factory Stack({
    required String id,
    required DateTime createdAt,
    required DateTime updatedAt,
    required String ownerId,
    required String primaryAssetId,
    @Default(StackSource.manual) StackSource source,
  }) = _Stack;
}

@freezed
abstract class StackResponse with _$StackResponse {
  const factory StackResponse({required String id, required String primaryAssetId, required List<String> assetIds}) =
      _StackResponse;
}
