<script lang="ts">
  import { toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TakeoutSettingsForm from '$lib/components/takeouts/TakeoutSettingsForm.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<UserPageLayout title={data.meta.title}>
  <div class="mx-auto w-full max-w-2xl py-4">
    <TakeoutSettingsForm settings={data.settings} onSaved={() => toastManager.primary($t('saved'))} />
  </div>
</UserPageLayout>
