import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:bandait/domain/enums/message_type.dart';

part 'message_model.freezed.dart';
part 'message_model.g.dart';

@freezed
class MessageModel with _$MessageModel {
  const factory MessageModel({
    required MessageType type,
    @Default({}) Map<String, dynamic> payload,
    required int timestamp,
    String? senderId,
  }) = _MessageModel;

  factory MessageModel.fromJson(Map<String, dynamic> json) =>
      _$MessageModelFromJson(json);
}
