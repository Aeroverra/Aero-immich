<script lang="ts">
  import type { StackSelectionChoice } from '$lib/services/stack-selection.service';
  import { Button, Checkbox, Label, Modal, ModalBody, ModalFooter, Text } from '@immich/ui';
  import { mdiImageMultipleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    stackCount: number;
    onClose: (choice?: StackSelectionChoice) => void;
  };

  let { stackCount, onClose }: Props = $props();

  let remember = $state(false);
</script>

<Modal
  title={$t('stack_actions_prompt_title')}
  icon={mdiImageMultipleOutline}
  size="small"
  onClose={() => onClose()}
  focusOnOpen
>
  <ModalBody>
    <p>{$t('stack_actions_prompt_description', { values: { count: stackCount } })}</p>

    <div class="flex flex-col items-center gap-1 pt-4">
      <div class="flex items-center gap-2">
        <Checkbox id="stack-selection-remember-input" bind:checked={remember} color="secondary" />
        <Label label={$t('stack_actions_remember')} for="stack-selection-remember-input" />
      </div>
      <Text size="tiny" color="muted" class="text-center">{$t('stack_actions_remember_description')}</Text>
    </div>
  </ModalBody>

  <ModalFooter>
    <div class="flex w-full flex-col gap-2 sm:flex-row">
      <Button shape="round" color="secondary" fullWidth onclick={() => onClose({ includeStacked: false, remember })}>
        {$t('stack_actions_mode_primary')}
      </Button>
      <Button shape="round" fullWidth onclick={() => onClose({ includeStacked: true, remember })}>
        {$t('stack_actions_mode_stack')}
      </Button>
    </div>
  </ModalFooter>
</Modal>
