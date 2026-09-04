#!/usr/bin/env node
/**
 * Screenshots of this site, taken by the agent instead of sent to it.
 *
 * Design work is a loop — change a rule, look at the page, change it again — and the loop
 * only closes if whoever edits the stylesheet can also see the result. This script is the
 * seeing half.
 *
 * No dependency. It drives an already-installed Chrome over the DevTools Protocol, which is
 * ~200 lines here against a Playwright install in a repository whose whole position on
 * dependencies is §74 and AGENTS.md, "Change discipline". The reason it is affordable is
 * SPEC §49.1: this site renders on the server and runs no client script beyond the theme
 * control, so "the page is ready" is the load event and a settle, not the pile of heuristics
 * a JavaScript application needs.
 *
 * Node's global WebSocket (Node 22, which `engines` already requires) is the whole client.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mintSession } from "./session.mjs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/* Chrome is the operator's own browser. Nothing here downloads one. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

/*
 * Three widths, named. §49.5 asks for mobile-first and responsive, and a screenshot at one
 * width answers neither question; `wide` exists because the layout decisions being made now
 * are about what happens past the current `--page` cap.
 */
const VIEWPORTS = {
  mobile: { width: 390, height: 844, mobile: true },
  desktop: { width: 1440, height: 1000, mobile: false },
  wide: { width: 1920, height: 1200, mobile: false },
};

const BASES = {
  staging: "https://staging.orator.space",
  prod: "https://orator.space",
  local: "http://localhost:4321",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(message) {
  process.stderr.write(`${message}

usage: node .claude/skills/design-shots/shot.mjs [options] <path|url> ...

  --base <staging|prod|local|URL>   default staging — prod has no content to lay out
  --viewport <mobile|desktop|wide|WxH>[,...]   default desktop
  --theme <light|dark|both>         default light
  --full                            whole page rather than the fold
  --clip <selector>                 just that element, for iterating on one component
  --as <username>                   open a session for that account — local base only
  --label <name>                    filename prefix, e.g. before / after
  --out <dir>                       default .design-shots (git-ignored)
`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    base: BASES.staging,
    viewports: ["desktop"],
    themes: ["light"],
    full: false,
    clip: null,
    label: null,
    as: null,
    out: ".design-shots",
    targets: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? usage(`${arg} needs a value`);
    if (arg === "--base") {
      const raw = value();
      opts.base = (BASES[raw] ?? raw).replace(/\/$/, "");
    } else if (arg === "--viewport") {
      opts.viewports = value().split(",");
    } else if (arg === "--theme") {
      const raw = value();
      opts.themes = raw === "both" ? ["light", "dark"] : [raw];
    } else if (arg === "--full") opts.full = true;
    else if (arg === "--clip") opts.clip = value();
    else if (arg === "--label") opts.label = value();
    else if (arg === "--as") opts.as = value();
    else if (arg === "--out") opts.out = value();
    else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
    else opts.targets.push(arg);
  }
  if (opts.targets.length === 0) usage("nothing to screenshot");
  /*
   * A session is written into the miniflare database under `.wrangler-state`, which only a
   * dev server opens. Refusing any other base here is not a formality: a deployed site has no
   * such row, so the run would quietly produce a directory of signed-out pages.
   */
  if (opts.as !== null && !opts.base.startsWith("http://localhost")) {
    usage(`--as needs --base local; a session is minted in the local database and nowhere else`);
  }
  for (const name of opts.viewports) {
    if (!VIEWPORTS[name] && !/^\d+x\d+$/.test(name)) usage(`unknown viewport ${name}`);
  }
  for (const theme of opts.themes) {
    if (theme !== "light" && theme !== "dark") usage(`unknown theme ${theme}`);
  }
  return opts;
}

function viewportOf(name) {
  if (VIEWPORTS[name]) return VIEWPORTS[name];
  const [width, height] = name.split("x").map(Number);
  return { width, height, mobile: width < 700 };
}

/** `/p/06G6…` becomes `p-06G6…`, so a directory listing reads like the site map. */
function slug(target) {
  const path = target.startsWith("http") ? new URL(target).pathname : target;
  const cleaned = path
    .replace(/^\/|\/$/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    /* A leading dash from `/@handle` makes a filename every CLI tool reads as a flag. */
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "home" : cleaned;
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error(
    `no Chrome found. Set CHROME_PATH, or install one of:\n  ${CHROME_CANDIDATES.join("\n  ")}`,
  );
}

/**
 * A CDP connection over one page target.
 *
 * `send` resolves on the matching id; `once` resolves on the next event of a name. Both are
 * the minimum that a navigate-and-capture loop needs, and neither grows a queue that has to
 * be drained.
 */
function connect(ws) {
  let nextId = 0;
  const pending = new Map();
  const waiting = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      if (message.error) slot.reject(new Error(`${message.error.message} (${slot.method})`));
      else slot.resolve(message.result);
      return;
    }
    const resolvers = waiting.get(message.method);
    if (resolvers) {
      waiting.delete(message.method);
      for (const resolve of resolvers) resolve(message.params);
    }
  });

  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    once(method) {
      return new Promise((resolve) => {
        if (!waiting.has(method)) waiting.set(method, []);
        waiting.get(method).push(resolve);
      });
    },
  };
}

async function launch() {
  const binary = findChrome();
  const profile = await mkdtemp(join(tmpdir(), "orator-shot-"));
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      /* Comparable bytes across machines: no subpixel smoothing, no display profile. */
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let port = null;
  for (let attempt = 0; attempt < 100 && port === null; attempt++) {
    await sleep(100);
    try {
      port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0].trim();
    } catch {
      /* Chrome has not written it yet. */
    }
  }
  if (!port) throw new Error("Chrome did not open a debugging port");

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("Chrome opened no page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("could not attach to Chrome")), { once: true });
  });

  return {
    cdp: connect(ws),
    async close() {
      try {
        ws.close();
      } catch {
        /* Already gone. */
      }
      /*
       * Chrome writes its profile right up to the moment it exits, so removing the directory
       * on the heels of `kill` races it and throws ENOTEMPTY on a run that has already
       * produced every screenshot it was asked for. Wait for the exit, then retry; a leftover
       * directory under the OS temp path is the OS's problem and never a failed run.
       */
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await Promise.race([exited, sleep(3000)]);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

/**
 * Puts a session cookie in the browser before the first shot.
 *
 * `session.mjs` writes the row; this hands the browser the other half. `Network.setCookie`
 * rather than a visit to a sign-in page, because there is no sign-in page a script can use —
 * see the note at the top of `session.mjs` for why that stayed true.
 */
async function signIn(cdp, base, username) {
  /*
   * The repository root from this file's own location, not from the working directory.
   *
   * `process.cwd()` made the script correct only when run from the root — and running it
   * from `apps/web`, which is where a dev server is started, produced a confusing failure
   * about a database rather than about a path.
   */
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const token = await mintSession(repoRoot, username);
  const { hostname } = new URL(base);
  await cdp.send("Network.enable");
  const { success } = await cdp.send("Network.setCookie", {
    name: "orator_session",
    value: token,
    domain: hostname,
    path: "/",
    httpOnly: true,
  });
  if (!success) throw new Error(`Chrome refused the session cookie for ${hostname}`);
}

async function capture(cdp, { url, viewport, theme, full, clip }) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 2,
    mobile: viewport.mobile,
  });
  /*
   * The theme is emulated rather than clicked. `theme.js` removes `data-theme` when the
   * choice is the system one, so `prefers-color-scheme` is what the stylesheet reads — which
   * means a screenshot needs no interaction and no stored preference.
   */
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });

  /*
   * Whether anything answered, and what it said, rather than assuming both.
   *
   * A run against a dev server that has stopped writes a directory of Chrome's own "This site
   * can't be reached" page, at the right sizes and in the right themes, with nothing to say
   * so — which is how half an hour goes into wondering why a stylesheet has no effect.
   * Chrome's error page is a real navigation with a real load event, so the load event cannot
   * be the check. `Page.navigate` returns `errorText` when the navigation itself failed,
   * which is the authoritative answer and needs no race.
   */
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  const loaded = cdp.once("Page.loadEventFired");
  const responded = cdp.once("Network.responseReceived");
  const navigation = await cdp.send("Page.navigate", { url });
  if (navigation.errorText) throw new Error(`${url}: ${navigation.errorText}`);
  await Promise.race([loaded, sleep(30000)]);

  /*
   * A 404 is not a failure: this site has a designed 404 (§49.5) and looking at it is a
   * reason to run this script. A 5xx is — it means the page threw, and a screenshot of a
   * stack trace is not a screenshot of a design.
   */
  const first = await Promise.race([responded, sleep(1000)]);
  if (first !== undefined && first.response.status >= 500) {
    throw new Error(`${url} answered ${first.response.status} ${first.response.statusText}`);
  }

  await cdp.send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
  await sleep(250);

  let clipRect;
  if (clip) {
    const { result } = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(clip)});
        if (!el) return null;
        el.scrollIntoView();
        const b = el.getBoundingClientRect();
        return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height, scale: 1 };
      })()`,
    });
    if (!result.value) throw new Error(`no element matches ${clip} on ${url}`);
    clipRect = result.value;
  } else if (full) {
    const { cssContentSize } = await cdp.send("Page.getLayoutMetrics");
    clipRect = {
      x: 0,
      y: 0,
      width: cssContentSize.width,
      /* A runaway page is a bug in the page; a 40000px PNG is a bug in this script. */
      height: Math.min(cssContentSize.height, 20000),
      scale: 1,
    };
  }

  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: Boolean(clipRect),
    ...(clipRect ? { clip: clipRect } : {}),
  });
  return Buffer.from(data, "base64");
}

const opts = parseArgs(process.argv.slice(2));
const outDir = resolvePath(opts.out);
await mkdir(outDir, { recursive: true });

const browser = await launch();
let failures = 0;
try {
  if (opts.as !== null) {
    await signIn(browser.cdp, opts.base, opts.as);
    process.stdout.write(`signed in as @${opts.as}\n`);
  }

  for (const target of opts.targets) {
    const url = target.startsWith("http")
      ? target
      : `${opts.base}${target.startsWith("/") ? "" : "/"}${target}`;
    for (const viewportName of opts.viewports) {
      for (const theme of opts.themes) {
        const name = [opts.label, slug(target), viewportName, theme].filter(Boolean).join("-");
        const file = join(outDir, `${name}.png`);
        try {
          const png = await capture(browser.cdp, {
            url,
            viewport: viewportOf(viewportName),
            theme,
            full: opts.full,
            clip: opts.clip,
          });
          await writeFile(file, png);
          process.stdout.write(`${file}\n`);
        } catch (error) {
          failures++;
          process.stderr.write(`FAILED ${url} (${viewportName}/${theme}): ${error.message}\n`);
        }
      }
    }
  }
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
