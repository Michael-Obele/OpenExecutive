// Ported from `packages/ui/src/lib/file-attachments.ts` and `relativeTime.ts`.
// Shared helpers — no framework dependency, reused by Chat and list pages.
export const MAX_FILES_PER_TURN = 5;
export const MAX_BYTES_PER_FILE = 20 * 1024 * 1024;

export interface FileSelection<T> {
	files: T[];
	rejected: string[];
}

type AttachmentFile = { name: string; size: number };

export function mergePickedFiles<T extends AttachmentFile>(
	current: readonly T[],
	picked: readonly T[]
): FileSelection<T> {
	const files = [...current];
	const rejected: string[] = [];
	for (const file of picked) {
		if (file.size > MAX_BYTES_PER_FILE) {
			const maxSizeMb = MAX_BYTES_PER_FILE / (1024 * 1024);
			rejected.push(`${file.name} is too large (max ${maxSizeMb} MB)`);
			continue;
		}
		if (files.length >= MAX_FILES_PER_TURN) break;
		if (files.some((existing) => existing.name === file.name && existing.size === file.size))
			continue;
		files.push(file);
	}
	return { files, rejected };
}

export function formatRelativeTime(iso: string): string {
	if (!iso) return '';
	const ts = new Date(iso).getTime();
	if (!Number.isFinite(ts)) return '';
	const diff = Date.now() - ts;
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	return `${Math.floor(hrs / 24)}d ago`;
}
