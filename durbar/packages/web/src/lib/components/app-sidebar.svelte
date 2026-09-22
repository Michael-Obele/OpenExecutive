<script lang="ts">
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import { page } from "$app/state";
  import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
  import CalendarDays from "@lucide/svelte/icons/calendar-days";
  import Building from "@lucide/svelte/icons/building";
  import Layers from "@lucide/svelte/icons/layers";
  import Users from "@lucide/svelte/icons/users";
  import ClipboardCheck from "@lucide/svelte/icons/clipboard-check";
  import BookOpen from "@lucide/svelte/icons/book-open";
  import Archive from "@lucide/svelte/icons/archive";
  import ScrollText from "@lucide/svelte/icons/scroll-text";
  import Eye from "@lucide/svelte/icons/eye";
  import Briefcase from "@lucide/svelte/icons/briefcase";
  import Brain from "@lucide/svelte/icons/brain";
  import Network from "@lucide/svelte/icons/network";
  import Radar from "@lucide/svelte/icons/radar";

  const pathname = $derived(page.url.pathname);
  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(href + "/");

  const groups = [
    {
      label: "Overview",
      items: [
        { href: "/", label: "Dashboard", icon: LayoutDashboard },
        { href: "/today", label: "Today", icon: CalendarDays },
      ],
    },
    {
      label: "Company",
      items: [
        { href: "/company-profile", label: "Company", icon: Building },
        { href: "/departments", label: "Departments", icon: Layers },
        { href: "/people", label: "People", icon: Users },
      ],
    },
    {
      label: "Operations",
      items: [
        { href: "/jobs", label: "Workflows", icon: ClipboardCheck },
        { href: "/clients", label: "Clients", icon: Briefcase },
        { href: "/talent", label: "Talent", icon: Users },
        { href: "/watchlist", label: "Watchlist", icon: Radar },
      ],
    },
    {
      label: "Knowledge",
      items: [
        { href: "/knowledge", label: "Knowledge", icon: BookOpen },
        { href: "/artifacts", label: "Artifacts", icon: Archive },
        { href: "/memories", label: "Memories", icon: Brain },
        { href: "/audit", label: "Audit", icon: ScrollText },
        { href: "/review", label: "Review", icon: Eye },
        { href: "/architecture", label: "Architecture", icon: Network },
      ],
    },
  ];
</script>

<Sidebar.Root variant="inset" collapsible="icon">
  <Sidebar.Header>
    <div class="flex items-center gap-2 px-2 py-2">
      <div
        class="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-lg font-serif text-sm font-bold"
      >
        D
      </div>
      <div class="group-data-[collapsible=icon]:hidden flex flex-col">
        <span class="text-sm font-semibold tracking-tight">Durbar</span>
        <span class="text-muted-foreground text-xs">Executive console</span>
      </div>
    </div>
  </Sidebar.Header>
  <Sidebar.Content>
    {#each groups as group (group.label)}
      <Sidebar.Group>
        <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
        <Sidebar.GroupContent>
          <Sidebar.Menu>
            {#each group.items as item (item.href)}
              <Sidebar.MenuItem>
                <Sidebar.MenuButton
                  isActive={isActive(item.href)}
                  tooltipContent={item.label}
                >
                  {#snippet child({ props })}
                    <a href={item.href} {...props}>
                      <item.icon />
                      <span>{item.label}</span>
                    </a>
                  {/snippet}
                </Sidebar.MenuButton>
              </Sidebar.MenuItem>
            {/each}
          </Sidebar.Menu>
        </Sidebar.GroupContent>
      </Sidebar.Group>
    {/each}
  </Sidebar.Content>
  <Sidebar.Footer>
    <div
      class="group-data-[collapsible=icon]:hidden px-2 py-2 text-[11px] leading-relaxed text-muted-foreground"
    >
      Dashboard calls Durbar over HTTP. Set <code class="text-foreground"
        >DURBAR_PUBLIC_URL</code
      > for split deploys.
    </div>
  </Sidebar.Footer>
</Sidebar.Root>
