<script lang="ts">
  import { TooltipProvider } from '@immich/ui';
  import type { ComponentProps } from 'svelte';
  import PersonSuggestionsPage from './+page.svelte';

  interface Props {
    data: ComponentProps<typeof PersonSuggestionsPage>['data'];
  }

  let { data }: Props = $props();
</script>

<TooltipProvider>
  <PersonSuggestionsPage {data} />
</TooltipProvider>
