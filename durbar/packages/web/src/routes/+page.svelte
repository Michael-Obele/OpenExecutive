<script lang="ts">
  import { onMount } from "svelte";
  import { getHealth, getToday } from "$lib/remote/health.remote.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Activity from "@lucide/svelte/icons/activity";
  import CalendarDays from "@lucide/svelte/icons/calendar-days";
  import MessageSquare from "@lucide/svelte/icons/message-square";

  let health = $state<{
    status: string;
    provider: string;
    model: string;
  } | null>(null);
  let today = $state<unknown>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const [h, t] = await Promise.all([
        getHealth(),
        getToday().catch(() => null),
      ]);
      health = h as typeof health;
      today = t;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });
</script>

<div class="mx-auto max-w-5xl px-6 py-8">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p class="text-muted-foreground mt-1 text-sm">
        Durbar — lean Bun + SQLite reimplementation of OpenExecutive. Set
        <code class="bg-muted rounded px-1 py-0.5">DURBAR_PUBLIC_URL</code> for split deploys.
      </p>
    </div>
    <Sidebar.Trigger class="-ml-1" />
  </div>

  {#if error}
    <Alert.Root variant="destructive" class="mt-6">
      <TriangleAlert />
      <Alert.Title>Failed to load dashboard</Alert.Title>
      <Alert.Description>{error}</Alert.Description>
    </Alert.Root>
  {/if}

  <div class="mt-6 grid gap-4 sm:grid-cols-2">
    <Card.Root>
      <Card.Header>
        <Card.Title class="flex items-center gap-2 text-sm">
          <Activity class="size-4" /> Health
        </Card.Title>
        <Card.Description>Durbar server and model provider</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if health}
          <dl class="space-y-2 text-sm">
            <div class="flex items-center justify-between">
              <dt class="text-muted-foreground">Status</dt>
              <dd><Badge variant={health.status === "ok" ? "default" : "destructive"}>{health.status}</Badge></dd>
            </div>
            <div class="flex items-center justify-between">
              <dt class="text-muted-foreground">Provider</dt>
              <dd class="font-medium">{health.provider}</dd>
            </div>
            <div class="flex items-center justify-between">
              <dt class="text-muted-foreground">Model</dt>
              <dd class="text-muted-foreground text-xs">{health.model}</dd>
            </div>
          </dl>
        {:else}
          <div class="space-y-2">
            <Skeleton class="h-4 w-full" />
            <Skeleton class="h-4 w-3/4" />
            <Skeleton class="h-4 w-5/6" />
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="flex items-center gap-2 text-sm">
          <CalendarDays class="size-4" /> Today
        </Card.Title>
        <Card.Description>Briefing and activity</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if today}
          <pre class="bg-muted max-h-48 overflow-auto rounded p-3 text-xs">{JSON.stringify(today, null, 2)}</pre>
        {:else}
          <div class="space-y-2">
            <Skeleton class="h-4 w-full" />
            <Skeleton class="h-20 w-full" />
          </div>
        {/if}
      </Card.Content>
    </Card.Root>
  </div>

  <Card.Root class="mt-6">
    <Card.Header>
      <Card.Title class="flex items-center gap-2 text-sm">
        <MessageSquare class="size-4" /> Chat
      </Card.Title>
      <Card.Description>
        Chat turns are SSE streams (<code>POST /chat → text/event-stream</code>). Streams directly from Durbar.
      </Card.Description>
    </Card.Header>
    <Card.Footer>
      <Button href="/today">Open Today →</Button>
    </Card.Footer>
  </Card.Root>
</div>
