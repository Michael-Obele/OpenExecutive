<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  const nav = [
    { href: "/", label: "Dashboard" },
    { href: "/today", label: "Today" },
    { href: "/company-profile", label: "Company" },
    { href: "/departments", label: "Departments" },
    { href: "/people", label: "People" },
    { href: "/jobs", label: "Workflows" },
    { href: "/knowledge", label: "Knowledge" },
    { href: "/artifacts", label: "Artifacts" },
    { href: "/audit", label: "Audit" },
    { href: "/review", label: "Review" },
    { href: "/clients", label: "Clients" },
    { href: "/talent", label: "Talent" },
    { href: "/watchlist", label: "Watchlist" },
    { href: "/memories", label: "Memories" },
    { href: "/architecture", label: "Architecture" },
  ];
</script>

<div class="flex min-h-screen">
  <aside class="w-56 shrink-0 border-r border-zinc-800 bg-zinc-900/50 p-4">
    <div class="mb-6 flex items-center gap-2">
      <span class="text-sm font-semibold tracking-tight text-zinc-100"
        >Durbar</span
      >
      <span
        class="rounded bg-indigo-600/20 px-1.5 py-0.5 text-[10px] text-indigo-300"
        >web</span
      >
    </div>
    <nav class="space-y-1">
      {#each nav as item (item.href)}
        <a
          href={item.href}
          class="block rounded px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {item.label}
        </a>
      {/each}
    </nav>
    <p class="mt-6 text-[11px] leading-relaxed text-zinc-500">
      Dashboard calls Durbar over HTTP. Set <code class="text-zinc-400"
        >DURBAR_PUBLIC_URL</code
      > when hosting frontend and server separately.
    </p>
  </aside>
  <main class="min-w-0 flex-1 bg-zinc-950">
    {@render children()}
  </main>
</div>
