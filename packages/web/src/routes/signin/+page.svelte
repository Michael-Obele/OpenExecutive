<script lang="ts">
	import { signIn, signUp } from '$lib/remote/auth.remote.js';

	interface Props {
		callbackUrl?: string;
		error?: string | null;
	}

	let { callbackUrl = '/', error = null }: Props = $props();

	let mode = $state<'signin' | 'signup'>('signin');
	let showPassword = $state(false);

	const queryError = $derived(
		error === 'AccessDenied'
			? 'Your account is not on the allow-list for this workspace. Ask an admin to add you.'
			: error === 'Configuration'
				? 'Authentication is misconfigured. Contact the administrator.'
				: error
					? 'Sign-in failed. Try again, or contact the administrator if this keeps happening.'
					: null
	);
</script>

<main class="flex min-h-screen items-center justify-center px-6">
	<div class="w-full max-w-sm rounded-2xl border border-line bg-surface-elevated/60 p-8 shadow-xl">
		<h1 class="text-xl font-semibold tracking-tight text-fg">Open Executive</h1>
		<p class="mt-2 text-sm text-fg-muted">
			{#if mode === 'signin'}Sign in to continue.{:else}Create your account.{/if}
		</p>

		{#if queryError}
			<p
				class="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200"
				role="alert"
			>
				{queryError}
			</p>
		{/if}

		{#if mode === 'signin'}
			<form {...signIn} class="mt-6 space-y-3">
				<input {...signIn.fields.callbackUrl.as('hidden', callbackUrl)} />
				{#each signIn.fields.allIssues() ?? [] as issue (issue.message)}
					<p class="rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200" role="alert">
						{issue.message}
					</p>
				{/each}
				<label class="block">
					<span class="text-xs font-medium text-fg-muted">Email</span>
					<input
						{...signIn.fields.email.as('email')}
						placeholder="ada@example.com"
						autocomplete="email"
						class="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none aria-invalid:border-red-500"
					/>
					{#each signIn.fields.email.issues() ?? [] as issue (issue.message)}
						<p class="mt-1 text-xs text-red-400">{issue.message}</p>
					{/each}
				</label>
				<label class="block">
					<span class="text-xs font-medium text-fg-muted">Password</span>
					<div class="relative mt-1">
						<input
							{...signIn.fields._password.as(showPassword ? 'text' : 'password')}
							placeholder="••••••••"
							autocomplete="current-password"
							class="w-full rounded-md border border-line bg-surface px-3 py-2 pr-16 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none aria-invalid:border-red-500"
						/>
						<button
							type="button"
							onclick={() => (showPassword = !showPassword)}
							class="absolute top-1/2 right-1 -translate-y-1/2 rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-overlay hover:text-fg"
							aria-label={showPassword ? 'Hide password' : 'Show password'}
						>
							{showPassword ? 'Hide' : 'Show'}
						</button>
					</div>
					{#each signIn.fields._password.issues() ?? [] as issue (issue.message)}
						<p class="mt-1 text-xs text-red-400">{issue.message}</p>
					{/each}
				</label>
				<button
					type="submit"
					class="w-full cursor-pointer rounded-md bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-60"
				>
					Sign in
				</button>
			</form>
		{:else}
			<form {...signUp} class="mt-6 space-y-3">
				<input {...signUp.fields.callbackUrl.as('hidden', callbackUrl)} />
				{#each signUp.fields.allIssues() ?? [] as issue (issue.message)}
					<p class="rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200" role="alert">
						{issue.message}
					</p>
				{/each}
				<label class="block">
					<span class="text-xs font-medium text-fg-muted">Name</span>
					<input
						{...signUp.fields.name.as('text')}
						placeholder="Ada Lovelace"
						autocomplete="name"
						class="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none aria-invalid:border-red-500"
					/>
					{#each signUp.fields.name.issues() ?? [] as issue (issue.message)}
						<p class="mt-1 text-xs text-red-400">{issue.message}</p>
					{/each}
				</label>
				<label class="block">
					<span class="text-xs font-medium text-fg-muted">Email</span>
					<input
						{...signUp.fields.email.as('email')}
						placeholder="ada@example.com"
						autocomplete="email"
						class="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none aria-invalid:border-red-500"
					/>
					{#each signUp.fields.email.issues() ?? [] as issue (issue.message)}
						<p class="mt-1 text-xs text-red-400">{issue.message}</p>
					{/each}
				</label>
				<label class="block">
					<span class="text-xs font-medium text-fg-muted">Password</span>
					<div class="relative mt-1">
						<input
							{...signUp.fields._password.as(showPassword ? 'text' : 'password')}
							placeholder="••••••••"
							autocomplete="new-password"
							class="w-full rounded-md border border-line bg-surface px-3 py-2 pr-16 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none aria-invalid:border-red-500"
						/>
						<button
							type="button"
							onclick={() => (showPassword = !showPassword)}
							class="absolute top-1/2 right-1 -translate-y-1/2 rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-overlay hover:text-fg"
							aria-label={showPassword ? 'Hide password' : 'Show password'}
						>
							{showPassword ? 'Hide' : 'Show'}
						</button>
					</div>
					{#each signUp.fields._password.issues() ?? [] as issue (issue.message)}
						<p class="mt-1 text-xs text-red-400">{issue.message}</p>
					{/each}
				</label>
				<button
					type="submit"
					class="w-full cursor-pointer rounded-md bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-60"
				>
					Create account
				</button>
			</form>
		{/if}

		<button
			type="button"
			onclick={() => (mode = mode === 'signin' ? 'signup' : 'signin')}
			class="mt-4 w-full cursor-pointer text-center text-xs text-fg-muted hover:text-fg"
		>
			{#if mode === 'signin'}Don't have an account? Create one{:else}Already have an account? Sign in{/if}
		</button>
	</div>
</main>
