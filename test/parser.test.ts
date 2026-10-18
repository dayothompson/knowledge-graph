import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { parseVault } from '../src/lib/parser.js';

const FIXTURE_VAULT = join(import.meta.dirname, 'fixtures', 'vault');
const FRONTMATTER_VAULT = join(import.meta.dirname, 'fixtures', 'frontmatter-vault');

describe('parseVault', () => {
  it('finds all .md files and skips excluded directories', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('People/Alice Smith.md');
    expect(ids).toContain('People/Bob Jones.md');
    expect(ids).toContain('Concepts/Widget Theory.md');
    expect(ids).toContain('orphan.md');
    // Should NOT include .obsidian or attachments
    expect(ids.every(id => !id.startsWith('.obsidian/'))).toBe(true);
    expect(ids.every(id => !id.startsWith('attachments/'))).toBe(true);
  });

  it('parses frontmatter correctly', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const alice = nodes.find(n => n.id === 'People/Alice Smith.md')!;
    expect(alice.title).toBe('Alice Smith');
    expect(alice.frontmatter.type).toBe('person');
    expect(alice.frontmatter.aliases).toContain('A. Smith');
  });

  it('falls back to filename when no title in frontmatter', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const noTitle = nodes.find(n => n.id === 'no-title.md')!;
    expect(noTitle.title).toBe('no-title');
  });

  it('extracts resolved edges with context', async () => {
    const { edges } = await parseVault(FIXTURE_VAULT);
    const aliceToWidget = edges.find(
      e => e.sourceId === 'People/Alice Smith.md'
        && e.targetId === 'Concepts/Widget Theory.md'
    );
    expect(aliceToWidget).toBeDefined();
    expect(aliceToWidget!.context).toContain('Widget Theory');
  });

  it('creates stub edges for nonexistent targets', async () => {
    const { edges, stubIds } = await parseVault(FIXTURE_VAULT);
    const stubEdge = edges.find(e => e.targetId.includes('Nonexistent Page'));
    expect(stubEdge).toBeDefined();
    expect(stubIds.size).toBeGreaterThan(0);
  });

  it('extracts inline tags', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const bob = nodes.find(n => n.id === 'People/Bob Jones.md')!;
    expect(bob.frontmatter.inline_tags).toContain('research');
    expect(bob.frontmatter.inline_tags).toContain('published');
  });
});

describe('parseVault frontmatter links', () => {
  it('indexes wikilinks declared as frontmatter fields', async () => {
    const { edges } = await parseVault(FRONTMATTER_VAULT);
    const fromChild = edges.filter(e => e.sourceId === 'Child.md');

    expect(fromChild.map(e => e.targetId).sort()).toEqual([
      'Concepts/Deep Topic.md',
      'Parent.md',
      'Sibling.md',
      '_stub/Missing Source.md',
    ]);
  });

  it('records the frontmatter field name in the edge context', async () => {
    const { edges } = await parseVault(FRONTMATTER_VAULT);
    const byTarget = (id: string) =>
      edges.find(e => e.sourceId === 'Child.md' && e.targetId === id)!;

    expect(byTarget('Parent.md').context).toBe('frontmatter: up');
    expect(byTarget('Concepts/Deep Topic.md').context).toBe('frontmatter: related');
    expect(byTarget('_stub/Missing Source.md').context).toBe('frontmatter: cites');
  });

  it('does not duplicate a target linked from both body and frontmatter', async () => {
    const { edges } = await parseVault(FRONTMATTER_VAULT);
    const childToSibling = edges.filter(
      e => e.sourceId === 'Child.md' && e.targetId === 'Sibling.md'
    );

    expect(childToSibling).toHaveLength(1);
    // The body occurrence wins, so the usual paragraph context is preserved.
    expect(childToSibling[0].context).toContain('Sibling');
  });

  it('creates stubs for unresolved frontmatter targets', async () => {
    const { stubIds } = await parseVault(FRONTMATTER_VAULT);
    expect(stubIds.has('_stub/Missing Source.md')).toBe(true);
  });

  it('finds links nested inside frontmatter maps', async () => {
    const { edges } = await parseVault(FRONTMATTER_VAULT);
    const nested = edges.find(
      e => e.sourceId === 'Sibling.md' && e.targetId === 'Parent.md'
    );

    expect(nested).toBeDefined();
    expect(nested!.context).toBe('frontmatter: meta');
  });

  it('leaves body edges untouched', async () => {
    const { edges } = await parseVault(FIXTURE_VAULT);
    // Alice Smith links [[Widget Theory]] twice in the body; both occurrences
    // are still recorded, as before this change.
    const aliceToWidget = edges.filter(
      e => e.sourceId === 'People/Alice Smith.md'
        && e.targetId === 'Concepts/Widget Theory.md'
    );

    expect(aliceToWidget).toHaveLength(2);
  });
});
