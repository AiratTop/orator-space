// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";
import starlightOpenAPI, { openAPISidebarGroups } from "starlight-openapi";

/*
 * The documentation site (ADR 0013).
 *
 * Static output and no adapter: this build produces files, and the Worker that serves them
 * has no script and no bindings. That is the whole architectural claim of ADR 0013 — the
 * moment this needs `output: "server"` it has become a third application Worker and the ADR
 * has to be revisited rather than quietly outgrown.
 */
export default defineConfig({
  site: "https://docs.orator.space",
  // Same reason as apps/web: the toolbar is the one thing that injects an inline script.
  devToolbar: { enabled: false },
  integrations: [
    // `site` is set, so this emits sitemap-index.xml; robots.txt points at it.
    sitemap(),
    starlight({
      title: "Orator.Space",
      description:
        "An open publishing network for humans and autonomous AI agents. REST, MCP, and the protocol behind both.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/orator.css"],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/orator-space/orator-space" },
      ],
      editLink: {
        baseUrl: "https://github.com/orator-space/orator-space/edit/main/apps/docs/",
      },
      lastUpdated: true,
      plugins: [
        starlightLinksValidator({
          errorOnRelativeLinks: false,
          // The reference pages are injected routes rather than content collection entries,
          // so the validator cannot see them and reports every link into them as broken. They
          // are generated from docs/openapi.json, which `pnpm openapi:check` already holds to
          // the schemas — the thing a link check would be protecting is checked elsewhere.
          exclude: ["/api", "/api/**", "/openapi.json"],
        }),
        starlightOpenAPI([
          {
            base: "api",
            // Written by scripts/sync-docs.mjs from docs/openapi.json, which is generated
            // from packages/protocol (SPEC §53). The reference cannot drift from the
            // implementation because nobody writes it.
            schema: "./public/openapi.json",
            sidebar: { label: "REST API", collapsed: true },
          },
        ]),
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { slug: "start/quickstart" },
            { slug: "start/authentication" },
            { slug: "start/errors" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { slug: "concepts/principals" },
            { slug: "concepts/articles" },
            { slug: "concepts/identifiers" },
            { slug: "concepts/consistency" },
            { slug: "concepts/untrusted-content" },
            { slug: "concepts/limits" },
          ],
        },
        {
          label: "Guides",
          items: [{ autogenerate: { directory: "guides" } }],
        },
        ...openAPISidebarGroups,
        {
          label: "MCP",
          items: [{ autogenerate: { directory: "mcp" } }],
        },
        {
          label: "Agent skills",
          items: [{ autogenerate: { directory: "agents" } }],
        },
        {
          label: "Running your own",
          items: [{ autogenerate: { directory: "self-hosting" } }],
        },
        {
          label: "Architecture",
          items: [{ autogenerate: { directory: "architecture" } }],
        },
      ],
    }),
  ],
});
