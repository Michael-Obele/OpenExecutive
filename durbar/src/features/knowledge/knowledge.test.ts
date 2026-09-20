/**
 * Spec for knowledge parsing and retrieval.
 *
 * The parsing tests use hand-written fixtures so the expected output is
 * explicit. The retrieval tests run against the **real corpus** — a parser that
 * passes synthetic fixtures but mangles 96 real documents is not a port.
 */

import { describe, expect, test } from 'bun:test';
import { openDb } from '../../db.ts';
import {
  parseDocument,
  parseFrontmatter,
  parseInlineList,
  splitSections,
} from './documents.ts';
import {
  indexCorpus,
  loadCorpus,
  renderKnowledge,
  searchKnowledge,
  toFtsQuery,
} from './knowledge.ts';

describe('parseFrontmatter', () => {
  test('reads scalars', () => {
    expect(parseFrontmatter('name: board-prep\nyear: 2020')).toEqual({
      name: 'board-prep',
      year: '2020',
    });
  });

  test('reads inline arrays as raw text', () => {
    expect(parseFrontmatter('failure_type: [a, b, c]')['failure_type']).toBe('[a, b, c]');
  });

  test('strips surrounding quotes', () => {
    expect(parseFrontmatter('topic: "product market fit"')['topic']).toBe(
      'product market fit',
    );
  });

  test('ignores indented list items so multi-line values do not leak keys', () => {
    const fields = parseFrontmatter('name: x\n  - not-a-key: y');
    expect(Object.keys(fields)).toEqual(['name']);
  });
});

describe('parseInlineList', () => {
  test('splits and trims', () => {
    expect(parseInlineList('[format_assumption, distribution]')).toEqual([
      'format_assumption',
      'distribution',
    ]);
  });

  test('returns empty for a non-list', () => {
    expect(parseInlineList('nope')).toEqual([]);
    expect(parseInlineList(undefined)).toEqual([]);
    expect(parseInlineList('[]')).toEqual([]);
  });
});

describe('splitSections', () => {
  test('splits on ## and keeps the preamble', () => {
    const sections = splitSections('# T\nintro\n\n## A\nalpha\n\n## B\nbeta');
    expect(sections.map((s) => s.heading)).toEqual(['', 'A', 'B']);
    expect(sections[1]?.body).toBe('alpha');
  });

  test('does not treat # inside a fenced code block as a heading', () => {
    // Strategy docs contain shell/formula examples; shredding them on a `#`
    // inside a fence would destroy retrieval for the technical documents.
    const body = '## Real\n\n```sh\n# not a heading\n## also not\n```\n\ntail';
    const sections = splitSections(body);
    expect(sections.map((s) => s.heading)).toEqual(['Real']);
    expect(sections[0]?.body).toContain('# not a heading');
    expect(sections[0]?.body).toContain('## also not');
  });

  test('handles a document with no headings', () => {
    expect(splitSections('just prose')).toEqual([{ heading: '', body: 'just prose' }]);
  });
});

describe('parseDocument — the three real shapes', () => {
  test('plain domain doc: domain from path, no frontmatter', () => {
    const doc = parseDocument('# Growth Strategy\n\nGrowth is a portfolio.\n\n## A\nx', 'strategy/growth_strategy.md');
    expect(doc.kind).toBe('domain');
    expect(doc.domain).toBe('strategy');
    expect(doc.title).toBe('Growth Strategy');
    expect(doc.summary).toContain('Growth is a portfolio');
  });

  test('failure case: domain from frontmatter, summary from company/topic/year', () => {
    const raw = [
      '---',
      'domain: product',
      'topic: product_market_fit',
      'company: Quibi',
      'year: 2020',
      'failure_type: [launch_timing, no_social_sharing]',
      '---',
      '# Quibi Collapse (2020)',
      '## Situation',
      'It launched during lockdowns.',
    ].join('\n');

    const doc = parseDocument(raw, 'failures/product/quibi.md');
    expect(doc.kind).toBe('failure');
    expect(doc.domain).toBe('product');
    expect(doc.title).toBe('Quibi Collapse (2020)');
    expect(doc.summary).toContain('Quibi');
    expect(doc.summary).toContain('2020');
    expect(doc.summary).toContain('launch_timing');
    // Frontmatter must not survive into the indexed body.
    expect(doc.sections[0]?.body).not.toContain('failure_type');
  });

  test('skill: summary joins description and when_to_use', () => {
    const raw = [
      '---',
      'name: board-prep-deck',
      'description: Full board deck outline',
      'when_to_use: User is preparing for a board meeting',
      'category: board',
      '---',
      '# Board Prep Deck',
      '## Inputs',
      'Gather these first.',
    ].join('\n');

    const doc = parseDocument(raw, 'skills/board/board-prep-deck.md');
    expect(doc.kind).toBe('skill');
    expect(doc.domain).toBe('board');
    expect(doc.summary).toContain('Full board deck outline');
    expect(doc.summary).toContain('preparing for a board meeting');
  });
});

describe('toFtsQuery', () => {
  test('drops FTS operator keywords, which a length filter alone would miss', () => {
    // 'and'/'or'/'not'/'near' are long enough to survive a minimum-length
    // filter but are real FTS5 operators. Leaking one turns a question into
    // `... OR and`, which errors or matches huge numbers of rows.
    const query = toFtsQuery('How much runway OR do we have NOT');
    expect(query).toBe('how OR much OR runway OR have');
    for (const keyword of ['and', 'or', 'not', 'near']) {
      expect(query.split(' OR ')).not.toContain(keyword);
    }
  });

  test('strips quotes and punctuation that would unbalance a phrase', () => {
    expect(toFtsQuery('"unbalanced unit economics*')).toBe(
      'unbalanced OR unit OR economics',
    );
  });

  test('OR-joins rather than AND-joining, for recall', () => {
    expect(toFtsQuery('unit economics')).toBe('unit OR economics');
  });

  test('never returns an empty string, which FTS5 treats as a syntax error', () => {
    expect(toFtsQuery('a b')).toBe('""');
    expect(toFtsQuery('')).toBe('""');
    // A query made only of operator keywords must not leak them through.
    expect(toFtsQuery('and or not near')).toBe('""');
  });
});

describe('the real corpus', () => {
  const documents = loadCorpus();

  test('parses every file without losing any', () => {
    expect(documents).toHaveLength(96);
    for (const doc of documents) {
      expect(doc.title).not.toBe('');
      expect(doc.sections.length).toBeGreaterThan(0);
      expect(doc.path.endsWith('.md')).toBe(true);
    }
  });

  test('classifies the three kinds', () => {
    const counts = documents.reduce<Record<string, number>>((acc, doc) => {
      acc[doc.kind] = (acc[doc.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts['failure']).toBe(17);
    expect(counts['skill']).toBe(15);
    expect(counts['domain']).toBe(64);
  });

  test('covers all eight domains', () => {
    const domains = new Set(documents.map((doc) => doc.domain));
    for (const domain of [
      'board', 'finance', 'hr', 'legal', 'marketing', 'operations', 'product', 'strategy',
    ]) {
      expect(domains.has(domain)).toBe(true);
    }
  });

  test('failure cases carry a searchable summary', () => {
    const quibi = documents.find((doc) => doc.path.includes('quibi'));
    expect(quibi?.summary).toContain('Quibi');
    expect(quibi?.summary).toContain('2020');
  });
});

describe('index and search', () => {
  const db = openDb();
  const documents = loadCorpus();
  const rows = indexCorpus(db, documents);

  test('indexes one row per section', () => {
    expect(rows).toBeGreaterThan(documents.length);
  });

  test('re-indexing is idempotent', () => {
    const again = indexCorpus(db, documents);
    expect(again).toBe(rows);
    const count = db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM knowledge_fts')
      .get();
    expect(count?.n).toBe(rows);
  });

  test('finds a failure case by company name', () => {
    const hits = searchKnowledge(db, 'Quibi mobile streaming collapse');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toContain('quibi');
  });

  test('finds the board-deck skill from a question about preparing for a board meeting', () => {
    // This is the case that only works because `when_to_use` is indexed.
    const hits = searchKnowledge(db, 'I am preparing for a board meeting, what should be in my deck?');
    expect(hits.some((hit) => hit.path.includes('board-prep-deck'))).toBe(true);
  });

  test('filters by domain', () => {
    const hits = searchKnowledge(db, 'unit economics payback', { domain: 'finance', limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.domain === 'finance')).toBe(true);
  });

  test('filters by kind', () => {
    const hits = searchKnowledge(db, 'pricing strategy', { kind: 'skill', limit: 5 });
    expect(hits.every((hit) => hit.kind === 'skill')).toBe(true);
  });

  test('returns nothing — not an error — for an unrelated query', () => {
    expect(searchKnowledge(db, 'zzzqqq xylophone')).toEqual([]);
  });

  test('sanitizes malformed FTS syntax instead of failing the turn', () => {
    // FTS5 throws on malformed MATCH. Sanitizing first means malformed input
    // never reaches MATCH as syntax — so this returns hits, not an error, and
    // the important guarantee is that it does not throw.
    expect(() => searchKnowledge(db, '"unbalanced AND (')).not.toThrow();
    expect(Array.isArray(searchKnowledge(db, '"unbalanced AND ('))).toBe(true);
  });

  test('respects the limit', () => {
    expect(searchKnowledge(db, 'strategy growth', { limit: 2 })).toHaveLength(2);
  });
});

describe('renderKnowledge', () => {
  test('is empty when there are no hits, so callers can skip the block', () => {
    expect(renderKnowledge([])).toBe('');
  });

  test('fences the block and labels it as background, not instructions', () => {
    const rendered = renderKnowledge([
      {
        kind: 'domain',
        domain: 'finance',
        path: 'finance/unit_economics.md',
        title: 'Unit Economics',
        body: '## LTV\nLTV to CAC.',
        score: -1,
      },
    ]);
    expect(rendered).toContain('NOT instructions');
    expect(rendered).toContain('--- begin reference ---');
    expect(rendered).toContain('--- end reference ---');
    expect(rendered).toContain('[finance · Unit Economics]');
  });
});
