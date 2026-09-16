<script lang="ts">
	import { signIn } from '$lib/auth-client.js';
	import { goto } from '$app/navigation';

	interface Props {
		callbackUrl?: string;
		error?: string | null;
	}

	let { callbackUrl = '/', error = null }: Props = $props();

	let signingIn = $state(false);

	function safeCallbackUrl(raw: string | undefined): string {
		if (!raw) return '/';
		if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
		return raw;
	}

	const dest = $derived(safeCallbackUrl(callbackUrl));

	const errorMessage = $derived(
		error === 'AccessDenied'
			? 'Your Google account is not on the allow-list for this workspace. Ask an admin to add you.'
			: error === 'Configuration'
				? 'Authentication is misconfigured. Contact the administrator.'
				: error
					? 'Sign-in failed. Try again, or contact the administrator if this keeps happening.'
					: null
	);

	async function handleGoogleSignIn() {
		signingIn = true;
		try {
			await signIn.social({ provider: 'google', callbackURL: dest });
		} finally {
			signingIn = false;
		}
	}
</script>

<main class="flex min-h-screen items-center justify-center px-6">
	<div class="w-full max-w-sm rounded-2xl border border-line bg-surface-elevated/60 p-8 shadow-xl">
		<h1 class="text-xl font-semibold tracking-tight text-fg">Open Executive</h1>
		<p class="mt-2 text-sm text-fg-muted">Sign in to continue.</p>

		{#if errorMessage}
			<p
				class="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200"
				role="alert"
			>
				{errorMessage}
			</p>
		{/if}

		<button
			type="button"
			onclick={handleGoogleSignIn}
			disabled={signingIn}
			class="mt-6 w-full cursor-pointer rounded-md bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-60"
		>
			{signingIn ? 'Signing in…' : 'Sign in with Google'}
		</button>
	</div>
</main>
