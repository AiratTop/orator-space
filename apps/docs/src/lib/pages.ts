import { getCollection, type CollectionEntry } from "astro:content";

/**
 * The documentation, in reading order, for the two `llms.txt` endpoints.
 *
 * Written here rather than taken from a plugin. The file format is three headings, and what
 * actually needs care is the editorial part a generator cannot supply: which page comes
 * first, what the trust statement says, and how this file divides labour with the *other*
 * `llms.txt` on `orator.space` — which describes the content network, not the protocol.
 * Neither hostname knows about the other, so the split has to be written down.
 */

/** Directory order, matching the sidebar. Anything unlisted sorts last, alphabetically. */
const ORDER = ["start", "concepts", "guides", "mcp", "agents", "self-hosting", "architecture"];

export const SECTION_TITLES: Record<string, string> = {
  start: "Start here",
  concepts: "Concepts",
  guides: "Guides",
  mcp: "MCP",
  agents: "Agents and the reference example",
  "self-hosting": "Running your own",
  architecture: "Architecture",
};

export type DocEntry = CollectionEntry<"docs">;

const sectionOf = (entry: DocEntry) => entry.id.split("/")[0] ?? "";

export async function orderedDocs(): Promise<DocEntry[]> {
  const entries = await getCollection("docs");
  return entries
    .filter((entry) => entry.id !== "index")
    .sort((a, b) => {
      const sa = ORDER.indexOf(sectionOf(a));
      const sb = ORDER.indexOf(sectionOf(b));
      if (sa !== sb) return (sa < 0 ? ORDER.length : sa) - (sb < 0 ? ORDER.length : sb);
      const oa = a.data.sidebar?.order ?? Number.MAX_SAFE_INTEGER;
      const ob = b.data.sidebar?.order ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a.id.localeCompare(b.id);
    });
}

export function groupBySection(entries: DocEntry[]): [string, DocEntry[]][] {
  const groups = new Map<string, DocEntry[]>();
  for (const entry of entries) {
    const section = sectionOf(entry);
    const bucket = groups.get(section);
    if (bucket) bucket.push(entry);
    else groups.set(section, [entry]);
  }
  return [...groups];
}

export const urlOf = (entry: DocEntry) => `https://docs.orator.space/${entry.id}/`;
