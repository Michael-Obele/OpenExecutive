<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { ADVANCED_ITEMS } from '$lib/navigation.js';
</script>

<main class="flex-1 min-h-0 overflow-y-auto">
  <div class="mx-auto max-w-3xl px-4 py-8 sm:px-6">
    <h1 class="text-xl font-semibold text-fg">Settings &amp; advanced</h1>
    <p class="mt-1 text-sm text-fg-muted">Configuration, diagnostics, and power-user tools. These sit outside the day-to-day workspace nav.</p>
    <div class="mt-6 grid gap-3 sm:grid-cols-2">
      {#each ADVANCED_ITEMS as item (item.href)}
        <a href={item.href} class="rounded-xl border border-line bg-surface-elevated px-4 py-4 transition-colors hover:bg-surface-overlay">
          <div class="flex items-center gap-2">
            <Icon name={item.icon} size="w-4 h-4" class="text-fg-muted" />
            <span class="text-sm font-medium text-fg">{item.label}</span>
          </div>
          <p class="mt-1 text-xs text-fg-muted">{item.description}</p>
        </a>
      {/each}
    </div>
  </div>
</main>
