import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';

class PrivatePicker extends HookWidget {
  const PrivatePicker({super.key, required this.onSelect, this.filter});

  final Function(SearchPrivateFilter) onSelect;
  final SearchPrivateFilter? filter;

  @override
  Widget build(BuildContext context) {
    final selected = useState(filter ?? SearchPrivateFilter.all);

    return RadioGroup(
      onChanged: (value) {
        selected.value = value!;
        onSelect(value);
      },
      groupValue: selected.value,
      child: Column(
        children: [
          RadioListTile(
            key: const Key("private_all"),
            title: Text(context.t.search_private_all),
            value: SearchPrivateFilter.all,
          ),
          RadioListTile(
            key: const Key("private_only"),
            title: Text(context.t.search_private_only),
            value: SearchPrivateFilter.onlyPrivate,
          ),
          RadioListTile(
            key: const Key("private_exclude"),
            title: Text(context.t.search_private_exclude),
            value: SearchPrivateFilter.notPrivate,
          ),
        ],
      ),
    );
  }
}
