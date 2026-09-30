<script lang="ts" module>
  import {
    TakeoutBurstMode,
    TakeoutHeicJpgMode,
    TakeoutOnErrors,
    TakeoutRawJpgMode,
    TakeoutVideoBoostMode,
    type TakeoutSettingsDto,
  } from '@immich/sdk';

  export const TAKEOUT_SETTINGS_DEFAULTS: TakeoutSettingsDto = {
    rawJpg: TakeoutRawJpgMode.StackCoverRaw,
    burst: TakeoutBurstMode.Stack,
    heicJpg: TakeoutHeicJpgMode.NoStack,
    videoBoost: TakeoutVideoBoostMode.Stack,
    customTags: ['Source/Google Photos/{date} {user}'],
    sessionTag: true,
    sessionTagTemplate: '{immich-go}/{start}',
    takeoutTag: true,
    peopleTags: true,
    onErrors: TakeoutOnErrors.Continue,
    stopAfterErrors: 0,
    dateRange: null,
    syncAlbums: true,
    includePartner: true,
    includeArchived: true,
    includeTrashed: false,
    includeUnmatched: false,
    googlePhotosFields: true,
    applyRotation: true,
    tagServerDuplicates: false,
    burstByTime: false,
    homeTimeZone: 'America/New_York',
  };
</script>

<script lang="ts">
  import { updateTakeoutSettings } from '@immich/sdk';
  import { Button, Field, Input, NumberInput, Select, Switch, Text } from '@immich/ui';
  import { mdiClose, mdiContentSaveOutline, mdiPlus, mdiRestore } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import Combobox, { asComboboxOptions, asSelectedOption } from '$lib/components/shared-components/Combobox.svelte';
  import { handleError } from '$lib/utils/handle-error';

  interface Props {
    settings: TakeoutSettingsDto;
    readOnly?: boolean;
    onSaved?: (settings: TakeoutSettingsDto) => void;
  }

  let { settings, readOnly = false, onSaved }: Props = $props();

  let form = $state<TakeoutSettingsDto>({ ...settings, customTags: [...settings.customTags] });
  let saving = $state(false);

  const timeZones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const timeZoneOptions = asComboboxOptions(timeZones);

  const rawJpgOptions = Object.values(TakeoutRawJpgMode).map((value) => ({ value }));
  const burstOptions = Object.values(TakeoutBurstMode).map((value) => ({ value }));
  const heicJpgOptions = Object.values(TakeoutHeicJpgMode).map((value) => ({ value }));
  const videoBoostOptions = Object.values(TakeoutVideoBoostMode).map((value) => ({ value }));
  const onErrorsOptions = Object.values(TakeoutOnErrors).map((value) => ({ value }));

  const addTag = () => (form.customTags = [...form.customTags, '']);
  const removeTag = (index: number) => (form.customTags = form.customTags.filter((_, i) => i !== index));

  const reset = () => {
    form = { ...TAKEOUT_SETTINGS_DEFAULTS, customTags: [...TAKEOUT_SETTINGS_DEFAULTS.customTags] };
  };

  const save = async () => {
    saving = true;
    try {
      const saved = await updateTakeoutSettings({
        takeoutSettingsUpdateDto: {
          ...form,
          dateRange: form.dateRange && form.dateRange.trim() !== '' ? form.dateRange.trim() : null,
          customTags: form.customTags.map((tag) => tag.trim()).filter((tag) => tag !== ''),
        },
      });
      form = { ...saved, customTags: [...saved.customTags] };
      onSaved?.(saved);
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      saving = false;
    }
  };
</script>

<div class="flex flex-col gap-6" class:pointer-events-none={readOnly} class:opacity-70={readOnly}>
  <Field label={$t('takeout_setting_raw_jpg')} description={$t('takeout_setting_raw_jpg_description')}>
    <Select options={rawJpgOptions} bind:value={form.rawJpg} />
  </Field>

  <Field label={$t('takeout_setting_burst')} description={$t('takeout_setting_burst_description')}>
    <Select options={burstOptions} bind:value={form.burst} />
  </Field>

  <Field label={$t('takeout_setting_heic_jpg')} description={$t('takeout_setting_heic_jpg_description')}>
    <Select options={heicJpgOptions} bind:value={form.heicJpg} />
  </Field>

  <Field label={$t('takeout_setting_video_boost')} description={$t('takeout_setting_video_boost_description')}>
    <Select options={videoBoostOptions} bind:value={form.videoBoost} />
  </Field>

  <Field label={$t('takeout_setting_custom_tags')} description={$t('takeout_setting_custom_tags_description')}>
    <div class="flex flex-col gap-2">
      {#each form.customTags as _, index (index)}
        <div class="flex items-center gap-2">
          <Input bind:value={form.customTags[index]} />
          <Button size="tiny" variant="ghost" color="danger" leadingIcon={mdiClose} onclick={() => removeTag(index)}>
            {$t('remove')}
          </Button>
        </div>
      {/each}
      <div>
        <Button size="tiny" variant="outline" color="secondary" leadingIcon={mdiPlus} onclick={addTag}
          >{$t('add')}</Button
        >
      </div>
      <Text size="tiny" color="muted">{'{date}'} · {'{user}'} · {'{start}'}</Text>
    </div>
  </Field>

  <Field label={$t('takeout_setting_session_tag')} description={$t('takeout_setting_session_tag_description')}>
    <Switch bind:checked={form.sessionTag} />
  </Field>

  <Field
    label={$t('takeout_setting_session_tag_template')}
    description={$t('takeout_setting_session_tag_template_description')}
  >
    <Input bind:value={form.sessionTagTemplate} disabled={!form.sessionTag} />
  </Field>

  <Field label={$t('takeout_setting_takeout_tag')} description={$t('takeout_setting_takeout_tag_description')}>
    <Switch bind:checked={form.takeoutTag} />
  </Field>

  <Field label={$t('takeout_setting_people_tags')} description={$t('takeout_setting_people_tags_description')}>
    <Switch bind:checked={form.peopleTags} />
  </Field>

  <Field label={$t('takeout_setting_on_errors')} description={$t('takeout_setting_on_errors_description')}>
    <Select options={onErrorsOptions} bind:value={form.onErrors} />
  </Field>

  {#if form.onErrors === TakeoutOnErrors.Continue}
    <Field
      label={$t('takeout_setting_stop_after_errors')}
      description={$t('takeout_setting_stop_after_errors_description')}
    >
      <NumberInput bind:value={form.stopAfterErrors} min={0} />
    </Field>
  {/if}

  <Field label={$t('takeout_setting_date_range')} description={$t('takeout_setting_date_range_description')}>
    <Input value={form.dateRange ?? ''} oninput={(event) => (form.dateRange = event.currentTarget.value)} />
  </Field>

  <Field label={$t('takeout_setting_sync_albums')} description={$t('takeout_setting_sync_albums_description')}>
    <Switch bind:checked={form.syncAlbums} />
  </Field>

  <Field label={$t('takeout_setting_include_partner')} description={$t('takeout_setting_include_partner_description')}>
    <Switch bind:checked={form.includePartner} />
  </Field>

  <Field label={$t('takeout_setting_include_trashed')} description={$t('takeout_setting_include_trashed_description')}>
    <Switch bind:checked={form.includeTrashed} />
  </Field>

  <Field
    label={$t('takeout_setting_include_unmatched')}
    description={$t('takeout_setting_include_unmatched_description')}
  >
    <Switch bind:checked={form.includeUnmatched} />
  </Field>

  <Field
    label={$t('takeout_setting_google_photos_fields')}
    description={$t('takeout_setting_google_photos_fields_description')}
  >
    <Switch bind:checked={form.googlePhotosFields} />
  </Field>

  <Field label={$t('takeout_setting_apply_rotation')} description={$t('takeout_setting_apply_rotation_description')}>
    <Switch bind:checked={form.applyRotation} />
  </Field>

  <Field
    label={$t('takeout_setting_tag_server_duplicates')}
    description={$t('takeout_setting_tag_server_duplicates_description')}
  >
    <Switch bind:checked={form.tagServerDuplicates} />
  </Field>

  <Field label={$t('takeout_setting_burst_by_time')} description={$t('takeout_setting_burst_by_time_description')}>
    <Switch bind:checked={form.burstByTime} />
  </Field>

  <Field label={$t('takeout_setting_home_time_zone')} description={$t('takeout_setting_home_time_zone_description')}>
    <Combobox
      label={$t('takeout_setting_home_time_zone')}
      hideLabel
      options={timeZoneOptions}
      selectedOption={asSelectedOption(form.homeTimeZone)}
      onSelect={(option) => (form.homeTimeZone = option?.value ?? form.homeTimeZone)}
    />
  </Field>

  {#if !readOnly}
    <div class="flex gap-2">
      <Button leadingIcon={mdiContentSaveOutline} loading={saving} onclick={save}>{$t('save')}</Button>
      <Button variant="outline" color="secondary" leadingIcon={mdiRestore} onclick={reset}
        >{$t('reset_to_default')}</Button
      >
    </div>
  {/if}
</div>
