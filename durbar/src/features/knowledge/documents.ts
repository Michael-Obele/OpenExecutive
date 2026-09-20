/**
 * Knowledge documents — parsing the curated corpus.
 *
 * Three document shapes live under `knowledge/builtin/`, and they are not
 * uniform, so the parser has to handle all three:
 *
 *   domain/<name>.md            plain Markdown: `# Title` then `## Sections`
 *   failures/<domain>/<n>.md    frontmatter: domain, topic, company, year,
 *                               failure_type[]
 *   skills/<domain>/<n>.md      frontmatter: name, description, when_to_use,
 *                               category
 *
 * The frontmatter is worth parsing rather than stripping: a skill's
 * `when_to_use` says *when it applies*, which is better retrieval signal than
 * any amount of body prose, and a failure case's `company`/`year`/`failure_type`
 * is what makes the failure library searchable by situation.
 */

export type KnowledgeKind = 'domain' | 'failure' | 'skill';

export interface KnowledgeSection {
  /** `##` heading, or '' for the text before the first one. */
  readonly heading: string;
  readonly body: string;
}

export interface KnowledgeDocument {
  readonly kind: KnowledgeKind;
  readonly domain: string;
  /** Path relative to the corpus root, for provenance in the prompt. */
  readonly path: string;
  readonly title: string;
  /** Retrieval-facing one-liner: `when_to_use`, or company/topic/year. */
  readonly summary: string;
  readonly sections: readonly KnowledgeSection[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parses the frontmatter subset this corpus actually uses: `key: value` and
 * `key: [a, b]`. Deliberately not a YAML implementation — a general parser would
 * be a dependency, and anything outside this subset should fail loudly in the
 * tests rather than be silently misread.
 */
export function parseFrontmatter(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) continue;

    fields[key] = value.trim().replace(/^["']|["']$/g, '');
  }

  return fields;
}

/** `[a, b, c]` -> ['a','b','c']; anything else -> []. */
export function parseInlineList(value: string | undefined): string[] {
  if (!value) return [];
  const match = value.match(/^\[(.*)\]$/);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter((item) => item !== '');
}

/**
 * Splits a document body into `##` sections.
 *
 * Tracks fenced code blocks, because several strategy documents contain shell
 * or formula examples whose `#` lines would otherwise be mistaken for headings —
 * which would shred the document into nonsense chunks and destroy retrieval
 * for exactly the technical documents that need it.
 */
export function splitSections(body: string): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let heading = '';
  let buffer: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text !== '' || heading !== '') sections.push({ heading, body: text });
    buffer = [];
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const isHeading = !inFence && /^##\s+/.test(line);
    if (isHeading) {
      flush();
      heading = line.replace(/^##\s+/, '').trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  // Drop a leading empty preamble so `##`-first documents don't index a blank.
  return sections.filter((section) => section.body !== '' || section.heading !== '');
}

function inferKind(relativePath: string): KnowledgeKind {
  if (relativePath.startsWith('failures/')) return 'failure';
  if (relativePath.startsWith('skills/')) return 'skill';
  return 'domain';
}

/**
 * Domain for retrieval. Frontmatter wins when present (the failure library
 * declares it), otherwise it is the first path segment — which for
 * `failures/product/quibi.md` is the *second* segment, since the first is the
 * kind.
 */
function inferDomain(relativePath: string, fields: Record<string, string>): string {
  if (fields['domain']) return fields['domain'];
  if (fields['category']) return fields['category'];

  const segments = relativePath.split('/');
  const kind = inferKind(relativePath);
  if (kind === 'domain') return segments[0] ?? 'general';
  return segments[1] ?? 'general';
}

function firstTitle(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^#\s+(.*)$/);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function summarise(
  kind: KnowledgeKind,
  fields: Record<string, string>,
  body: string,
): string {
  if (kind === 'skill') {
    // `when_to_use` describes applicability; `description` describes content.
    // Both help, and they are short, so join them.
    return [fields['description'], fields['when_to_use']]
      .filter((part): part is string => Boolean(part))
      .join(' — ');
  }

  if (kind === 'failure') {
    const types = parseInlineList(fields['failure_type']).join(', ');
    return [
      fields['company'],
      fields['year'] ? `(${fields['year']})` : '',
      fields['topic'],
      types ? `— ${types}` : '',
    ]
      .filter((part) => part !== '' && part !== undefined)
      .join(' ');
  }

  // Plain domain doc: the first prose paragraph is the closest thing to a
  // summary, and it beats indexing the title twice.
  const withoutTitle = body.replace(/^#\s+.*$/m, '').trim();
  const paragraph = withoutTitle.split(/\n\s*\n/)[0] ?? '';
  return paragraph.replace(/\s+/g, ' ').slice(0, 300);
}

export function parseDocument(raw: string, relativePath: string): KnowledgeDocument {
  const frontmatterMatch = raw.match(FRONTMATTER);
  const fields = frontmatterMatch?.[1] ? parseFrontmatter(frontmatterMatch[1]) : {};
  const body = frontmatterMatch ? raw.slice(frontmatterMatch[0].length) : raw;

  const kind = inferKind(relativePath);
  const title = firstTitle(body) || fields['name'] || relativePath;

  return {
    kind,
    domain: inferDomain(relativePath, fields),
    path: relativePath,
    title,
    summary: summarise(kind, fields, body),
    sections: splitSections(body),
  };
}
