import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart' hide Store;
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/widgets/settings/advanced_settings.dart';
import 'package:immich_mobile/widgets/settings/asset_list_settings/asset_list_settings.dart';
import 'package:immich_mobile/widgets/settings/asset_viewer_settings/asset_viewer_settings.dart';
import 'package:immich_mobile/widgets/settings/backup_settings/backup_settings.dart';
import 'package:immich_mobile/widgets/settings/beta_sync_settings/sync_status_and_actions.dart';
import 'package:immich_mobile/widgets/settings/custom_views_settings.dart';
import 'package:immich_mobile/widgets/settings/free_up_space_settings.dart';
import 'package:immich_mobile/widgets/settings/language_settings.dart';
import 'package:immich_mobile/widgets/settings/networking_settings/networking_settings.dart';
import 'package:immich_mobile/widgets/settings/notification_setting.dart';
import 'package:immich_mobile/widgets/settings/preference_settings/preference_setting.dart';
import 'package:immich_mobile/widgets/settings/previously_deleted_settings/previously_deleted_settings.dart';
import 'package:immich_mobile/widgets/settings/settings_card.dart';
import 'package:immich_mobile/widgets/settings/stack_actions_settings/stack_actions_settings.dart';
import 'package:immich_mobile/widgets/settings/tags_settings.dart';

enum SettingSection {
  advanced(Icons.build_outlined),
  assetViewer(Icons.image_outlined),
  backup(Icons.cloud_upload_outlined),
  customViews(Icons.filter_alt_outlined),
  freeUpSpace(Icons.cleaning_services_outlined),
  languages(Icons.language),
  networking(Icons.wifi),
  notifications(Icons.notifications_none_rounded),
  preferences(Icons.interests_outlined),
  previouslyDeleted(Icons.restore_from_trash_outlined),
  stackActions(Icons.burst_mode_outlined),
  tags(Icons.sell_outlined),
  timeline(Icons.auto_awesome_mosaic_outlined),
  beta(Icons.sync_outlined);

  final IconData icon;

  String title(Translations t) => switch (this) {
    SettingSection.advanced => t.advanced,
    SettingSection.assetViewer => t.asset_viewer_settings_title,
    SettingSection.backup => t.backup,
    SettingSection.customViews => t.custom_views,
    SettingSection.freeUpSpace => t.free_up_space,
    SettingSection.languages => t.language,
    SettingSection.networking => t.networking_settings,
    SettingSection.notifications => t.notifications,
    SettingSection.preferences => t.preferences_settings_title,
    SettingSection.previouslyDeleted => t.previously_deleted_files,
    SettingSection.stackActions => t.stack_actions,
    SettingSection.tags => t.tags,
    SettingSection.timeline => t.asset_list_settings_title,
    SettingSection.beta => t.sync_status,
  };

  String subtitle(Translations t) => switch (this) {
    SettingSection.advanced => t.advanced_settings_tile_subtitle,
    SettingSection.assetViewer => t.asset_viewer_settings_subtitle,
    SettingSection.backup => t.backup_settings_subtitle,
    SettingSection.customViews => t.custom_views_settings_subtitle,
    SettingSection.freeUpSpace => t.free_up_space_settings_subtitle,
    SettingSection.languages => t.setting_languages_subtitle,
    SettingSection.networking => t.networking_subtitle,
    SettingSection.notifications => t.setting_notifications_subtitle,
    SettingSection.preferences => t.preferences_settings_subtitle,
    SettingSection.previouslyDeleted => t.previously_deleted_files_description,
    SettingSection.stackActions => t.stack_actions_description,
    SettingSection.tags => t.tags_settings_subtitle,
    SettingSection.timeline => t.asset_list_settings_subtitle,
    SettingSection.beta => t.sync_status_subtitle,
  };

  Widget get widget => switch (this) {
    SettingSection.advanced => const AdvancedSettings(),
    SettingSection.assetViewer => const AssetViewerSettings(),
    SettingSection.backup => const BackupSettings(),
    SettingSection.customViews => const CustomViewsSettings(),
    SettingSection.freeUpSpace => const FreeUpSpaceSettings(),
    SettingSection.languages => const LanguageSettings(),
    SettingSection.networking => const NetworkingSettings(),
    SettingSection.notifications => const NotificationSetting(),
    SettingSection.preferences => const PreferenceSetting(),
    SettingSection.previouslyDeleted => const PreviouslyDeletedSettings(),
    SettingSection.stackActions => const StackActionsSettings(),
    SettingSection.tags => const TagsSettings(),
    SettingSection.timeline => const AssetListSettings(),
    SettingSection.beta => const SyncStatusAndActions(),
  };

  const SettingSection(this.icon);
}

@RoutePage()
class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(centerTitle: false, title: Text(context.t.settings)),
      body: context.isMobile ? const _MobileLayout() : const _TabletLayout(),
    );
  }
}

/// The sections this server supports: custom views and tag management (tags sync with them) only for servers that
/// know custom views
List<SettingSection> _visibleSections(WidgetRef ref) {
  final customViews = ref.watch(customViewsSupportedProvider);
  return SettingSection.values
      .where((section) => customViews || (section != SettingSection.customViews && section != SettingSection.tags))
      .toList();
}

class _MobileLayout extends ConsumerWidget {
  const _MobileLayout();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final List<Widget> settings = _visibleSections(ref)
        .expand(
          (setting) => setting == SettingSection.beta
              ? [
                  SettingsCard(
                    icon: Icons.sync_outlined,
                    title: context.t.sync_status,
                    subtitle: context.t.sync_status_subtitle,
                    settingRoute: const SyncStatusRoute(),
                  ),
                ]
              : [
                  SettingsCard(
                    title: setting.title(context.t),
                    subtitle: setting.subtitle(context.t),
                    icon: setting.icon,
                    settingRoute: SettingsSubRoute(section: setting),
                  ),
                ],
        )
        .toList();
    settings.add(
      SettingsCard(
        icon: Icons.auto_awesome_outlined,
        title: context.t.whats_new,
        subtitle: context.t.whats_new_settings_subtitle,
        settingRoute: const WhatsNewRoute(),
      ),
    );
    return ListView(padding: const EdgeInsets.only(top: 10.0, bottom: 60), children: [...settings]);
  }
}

class _TabletLayout extends HookConsumerWidget {
  const _TabletLayout();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectedSection = useState<SettingSection>(SettingSection.values.first);

    return Row(
      mainAxisAlignment: MainAxisAlignment.start,
      children: [
        Expanded(
          flex: 2,
          child: CustomScrollView(
            slivers: [
              ..._visibleSections(ref).map(
                (s) => SliverToBoxAdapter(
                  child: ListTile(
                    title: Text(s.title(context.t)),
                    leading: Icon(s.icon),
                    selected: s.index == selectedSection.value.index,
                    selectedColor: context.primaryColor,
                    selectedTileColor: context.themeData.highlightColor,
                    onTap: () => selectedSection.value = s,
                  ),
                ),
              ),
              SliverToBoxAdapter(
                child: ListTile(
                  title: Text(context.t.whats_new),
                  leading: const Icon(Icons.auto_awesome_outlined),
                  onTap: () => context.pushRoute(const WhatsNewRoute()),
                ),
              ),
            ],
          ),
        ),
        const VerticalDivider(width: 1),
        Expanded(flex: 4, child: selectedSection.value.widget),
      ],
    );
  }
}

@RoutePage()
class SettingsSubPage extends StatelessWidget {
  const SettingsSubPage(this.section, {super.key});

  final SettingSection section;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(centerTitle: false, title: Text(section.title(context.t))),
      body: section.widget,
    );
  }
}
