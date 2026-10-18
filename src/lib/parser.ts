import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import matter from 'gray-matter';
import {
  extractWikiLinks,
  buildStemLookup,
  resolveLink,
} from './wiki-links.js';
import type { ParsedNode, ParsedEdge } from './types.js';

const EXCLUDED_DIRS = new Set(['.obsidian', '_FileOrganizer2000', 'attachments']);

export interface ParseResult {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  stubIds: Set<string>;
}

export async function parseVault(vaultPath: string): Promise<ParseResult> {
  const mdPaths = await collectMarkdownFiles(vaultPath);
  const stemLookup = buildStemLookup(mdPaths);
  const allPathsSet = new Set(mdPaths);
  const nodes: ParsedNode[] = [];
  const edges: ParsedEdge[] = [];
  const stubIds = new Set<string>();

  for (const relPath of mdPaths) {
    const absPath = join(vaultPath, relPath);
    const raw = await readFile(absPath, 'utf-8');

    let fm: Record<string, unknown>;
    let content: string;
    try {
      const parsed = matter(raw);
      fm = parsed.data;
      content = parsed.content;
    } catch {
      // Malformed YAML frontmatter — treat entire file as content
      console.warn(`Malformed frontmatter in ${relPath}, treating as plain markdown`);
      fm = {};
      content = raw;
    }

    const title = (fm.title as string)
      ?? basename(relPath, '.md');

    const inlineTags = extractInlineTags(content);
    const frontmatter = { ...fm };
    if (inlineTags.length > 0) {
      frontmatter.inline_tags = inlineTags;
    }

    nodes.push({ id: relPath, title, content, frontmatter });

    const links = extractWikiLinks(content);
    const paragraphs = content.split(/\n\n+/);

    const bodyTargets = new Set<string>();

    for (const link of links) {
      const targetId = resolveLink(link.raw, stemLookup, allPathsSet);
      const resolvedTarget = targetId ?? `_stub/${link.raw}.md`;

      if (!targetId) {
        stubIds.add(resolvedTarget);
      }

      const context = paragraphs.find(p => p.includes(`[[${link.raw}`))
        ?? paragraphs.find(p => p.includes(link.display ?? link.raw))
        ?? '';

      bodyTargets.add(resolvedTarget);

      edges.push({
        sourceId: relPath,
        targetId: resolvedTarget,
        context: context.trim(),
      });
    }

    // Wikilinks declared as frontmatter fields, e.g. `up: "[[Parent]]"` or
    // `cites: ["[[Source A]]", "[[Source B]]"]`. gray-matter has already split these
    // out into `fm`, and extractWikiLinks above only ever sees the body, so without
    // this pass frontmatter relationships never become edges at all. The field name
    // is recorded in the edge context, since ParsedEdge has nowhere else to put it.
    const fmTargets = new Set<string>();

    for (const [field, value] of Object.entries(fm)) {
      for (const link of extractWikiLinks(collectStrings(value).join('\n'))) {
        const targetId = resolveLink(link.raw, stemLookup, allPathsSet);
        const resolvedTarget = targetId ?? `_stub/${link.raw}.md`;

        if (!targetId) {
          stubIds.add(resolvedTarget);
        }

        // Don't duplicate an edge the body already produced, and don't emit the same
        // target twice when several frontmatter fields point at it.
        if (bodyTargets.has(resolvedTarget) || fmTargets.has(resolvedTarget)) continue;
        fmTargets.add(resolvedTarget);

        edges.push({
          sourceId: relPath,
          targetId: resolvedTarget,
          context: `frontmatter: ${field}`,
        });
      }
    }
  }

  return { nodes, edges, stubIds };
}

/** Flatten a frontmatter value to the strings inside it, so nested lists and maps are searched too. */
function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}

function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  const pattern = /(?<!\w)#([a-zA-Z][\w-\/]*)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}

async function collectMarkdownFiles(
  vaultPath: string,
  subdir = '',
): Promise<string[]> {
  const results: string[] = [];
  const dirPath = join(vaultPath, subdir);
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

    const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...await collectMarkdownFiles(vaultPath, relPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(relPath);
    }
  }

  return results;
}
