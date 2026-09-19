<script lang="ts" module>
	import type { PeriodType } from '$lib/api.js';

	/**
	 * Pair of (period_type dropdown + period_value text input) for editing a Goal's
	 * timeframe. When the dropdown changes, the parent receives both new values via
	 * `onChange`; the helper `suggestPeriodValue(type, today)` lets callers populate
	 * a sensible default for the new type.
	 *
	 * For period_type="ongoing" the value input is hidden and the value is forced
	 * to the literal string "Ongoing" so the stored row is well-formed.
	 * Ported from `packages/ui/src/components/TimeframePicker.tsx`.
	 */
	const PERIOD_TYPES: { value: PeriodType; label: string; placeholder: string }[] = [
		{ value: 'week', label: 'Week', placeholder: 'Week of May 18' },
		{ value: 'month', label: 'Month', placeholder: 'May 2026' },
		{ value: 'quarter', label: 'Quarter', placeholder: 'Q2 2026' },
		{ value: 'year', label: 'Year', placeholder: '2026' },
		{ value: 'ongoing', label: 'Ongoing', placeholder: 'Ongoing' }
	];

	const MONTH_NAMES = [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December'
	];

	const MONTH_SHORT = [
		'Jan',
		'Feb',
		'Mar',
		'Apr',
		'May',
		'Jun',
		'Jul',
		'Aug',
		'Sep',
		'Oct',
		'Nov',
		'Dec'
	];

	/**
	 * Suggest a sensible period_value string for a given period_type, anchored on
	 * `today`. Used by the form when the user changes the dropdown so they're not
	 * left with a stale value from a different period scale.
	 *
	 * Week: "Week of {Mon DD}" — anchored on the most recent Monday.
	 * Month: "{MonthName YYYY}"
	 * Quarter: "Q{1-4} YYYY"
	 * Year: "{YYYY}"
	 * Ongoing: "Ongoing"
	 */
	export function suggestPeriodValue(periodType: PeriodType, today: Date = new Date()): string {
		switch (periodType) {
			case 'week': {
				const d = new Date(today);
				// ISO weekday: Mon=1..Sun=7. Date.getDay(): Sun=0..Sat=6.
				const dayOfWeek = d.getDay() === 0 ? 7 : d.getDay();
				d.setDate(d.getDate() - (dayOfWeek - 1));
				return `Week of ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
			}
			case 'month':
				return `${MONTH_NAMES[today.getMonth()]} ${today.getFullYear()}`;
			case 'quarter': {
				const q = Math.floor(today.getMonth() / 3) + 1;
				return `Q${q} ${today.getFullYear()}`;
			}
			case 'year':
				return String(today.getFullYear());
			case 'ongoing':
				return 'Ongoing';
		}
	}
</script>

<script lang="ts">
	interface Props {
		periodType: PeriodType;
		periodValue: string;
		onChange: (periodType: PeriodType, periodValue: string) => void;
		/** Visual size: compact inputs match the in-list edit row; default matches the new-row form. */
		size?: 'compact' | 'default';
	}

	let { periodType, periodValue, onChange, size = 'default' }: Props = $props();

	let placeholder = $derived(PERIOD_TYPES.find((p) => p.value === periodType)?.placeholder ?? '');
	// Both sizes currently share one class set in the Next.js source; `size` is
	// carried through as a data attribute so the distinction stays available.
	const inputCls =
		'px-2 py-1.5 rounded-lg bg-surface-input border border-line text-sm focus:outline-none focus:border-indigo-500';
</script>

<div class="grid grid-cols-2 gap-2" data-size={size}>
	<label class="flex flex-col gap-1 text-xs text-fg-muted">
		Timeframe
		<select
			value={periodType}
			onchange={(e) => {
				const next = e.currentTarget.value as PeriodType;
				// Auto-fill a sensible default for the new type unless the existing
				// value still makes sense (rare; the type usually implies a format).
				onChange(next, suggestPeriodValue(next));
			}}
			class={inputCls}
		>
			{#each PERIOD_TYPES as p (p.value)}
				<option value={p.value}>{p.label}</option>
			{/each}
		</select>
	</label>
	{#if periodType !== 'ongoing'}
		<label class="flex flex-col gap-1 text-xs text-fg-muted">
			Period
			<input
				value={periodValue}
				oninput={(e) => onChange(periodType, e.currentTarget.value)}
				class={inputCls}
				{placeholder}
			/>
		</label>
	{/if}
</div>
