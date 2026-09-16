<script lang="ts">
	import { signIn, signUp } from '$lib/auth-client.js';
	import { goto } from '$app/navigation';

	interface Props {
		callbackUrl?: string;
		error?: string | null;
	}

	let { callbackUrl = '/', error = null }: Props = $props();

	let email = $state('');
	let password = $state('');
	let name = $state('');
	let mode = $state<'signin' | 'signup'>('signin');
	let busy = $state(false);
	let formError = $state<string | null>(null);

	function safeCallbackUrl(raw: string | undefined): string {
		if (!raw) return '/';
		if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
		return raw;
	}

	const dest = $derived(safeCallbackUrl(callbackUrl));

	const queryError = $derived(
		error === 'AccessDenied'
			? 'Your account is not on the allow-list for this workspace. Ask an admin to add you.'
			: error === 'Configuration'
				? 'Authentication is misconfigured. Contact the administrator.'
				: error
					? 'Sign-in failed. Try again, or contact the administrator if this keeps happening.'
					: null
	);

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		formError = null;
		if (!email.trim() || !password) {
			formError = 'Email and password are required.';
			return;
		}
		if (mode === 'signup' && !name.trim()) {
			formError = 'Name is required.';
			return;
		}
		busy = true;
		try {
			if (mode === 'signup') {
				const res = await signUp.email({ email: email.trim(), password, name: name.trim() });
				if (res.error) {
					formError = res.error.message ?? 'Sign-up failed.';
					return;
				}
			} else {
				const res = await signIn.email({ email: email.trim(), password });
				if (res.error) {
					formError = res.error.message ?? 'Invalid email or password.';
					return;
				}
			}
			await goto(dest);
		} catch (err) {
			formError = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			busy = false;
		}
	}
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
		{#if formError}
			<p class="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200" role="alert">
				{formError}
			</p>
		{/if}

		<form class="mt-6 space-y-3" onsubmit={handleSubmit}>
			{#if mode === 'signup'}
				<label class="block">
					<span class="text-xs font-medium text-fg-muted">Name</span>
					<input
						type="text"
						bind:value={name}
						placeholder="Ada Lovelace"
						autocomplete="name"
						class="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
					/>
				</label>
			{/if}
			<label class="block">
				<span class="text-xs font-medium text-fg-muted">Email</span>
				<input
					type="email"
					bind:value={email}
					placeholder="ada@example.com"
					autocomplete="email"
					required
					class="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
				/>
			</label>
			<label class="block">
				<span class="text-xs font-medium text-fg-muted">Password</span>
				<input
					type="password"
					bind:value={password}
					placeholder="••••••••"
					autocomplete={mode === 'signin' ? 'current-password' : 'new-password'}
					required
					minlength={8}
					class="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
				/>
			</label>
			<button
				type="submit"
				disabled={busy}
				class="w-full cursor-pointer rounded-md bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-60"
			>
				{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
			</button>
		</form>

		<button
			type="button"
			onclick={() => {
				mode = mode === 'signin' ? 'signup' : 'signin';
				formError = null;
			}}
			class="mt-4 w-full text-center text-xs text-fg-muted hover:text-fg"
		>
			{#if mode === 'signin'}Don't have an account? Create one{:else}Already have an account? Sign in{/if}
		</button>
	</div>
</main>
