# Notepher Self-Host — Architecture Decisions

This fork of [`deptyped/notepher-bot`](https://github.com/deptyped/notepher-bot) is
self-hosted privately. This document records the decisions made to get it deployed
and running, and the reasoning behind each — including the alternatives that were
rejected and *why*, so a future change doesn't silently undo a deliberate choice.

Format is lightweight ADR (Architecture Decision Record): each decision states the
context, the choice, the alternatives considered, and the consequences.

---

## 1. Dependency upgrade: tiptap 2 → 3 (security) + read-only checkbox fix

**Context.** The upstream toolchain carried known-vulnerable transitive deps. The
upgrade (Vite 8, tiptap 2→3, and the surrounding toolchain) was done on branch
`deps-upgrade` and merged via PR #1.

**The subtle part.** tiptap 2 required a local patch,
`patches/@tiptap+extension-task-item+2.1.11.patch`, to make task-list checkboxes
toggle in **read-only** mode. tiptap 3 moved `onReadOnlyChecked` into
`@tiptap/extension-list` and **changed its signature** from the patched
`(node, checked, html)` to the native `(node, checked) => boolean` with
**revert-on-falsy** semantics (return a falsy value → tiptap undoes the DOM
checkbox toggle). The patch was dropped during the upgrade, so the old callback
`(_1, _2, html) => { content.value = html }` broke two ways at once:

- it read a third `html` argument that tiptap 3 never passes → set the note model
  to `undefined` (silent corruption, surfaced as a `content=undefined` Vue warning), and
- it returned `undefined` → tiptap reverted the checkbox, so the tap did nothing.

**Decision.** Rewrite `onReadOnlyChecked` for the tiptap 3 signature using a
**DOM-resync** strategy (`apps/web-app/src/components/notes/NoteEditor.vue`): on each
read-only toggle, re-read every task item's `checked` state from its live checkbox,
zip it 1:1 against the doc's task items (both are depth-first ordered, with a length
guard), dispatch a single ProseMirror transaction, persist the fresh HTML, and return
`true` so the tick sticks.

**Why DOM-resync and not node identity.** tiptap's NodeView updates in place, so the
`node` reference passed to the change listener goes stale after the first mutation.
A naive identity lookup worked once and then failed on the second toggle. Recomputing
from live DOM + live doc every click is immune to that staleness.

**Also hardened.** `stripTags(content)` in `apps/web-app/src/helpers/html.ts` now
tolerates `null`/`undefined`, so a corrupted model can never crash the
`isNoteEmpty` / unmount save-or-delete path.

**Consequence.** The local patch is gone (one less maintenance liability). The fix is
verified in a real browser (single- and multi-item read-only toggling persists
correctly, content stays a valid string). If a future tiptap upgrade changes
`onReadOnlyChecked` again, this is the function to re-check.

---

## 2. Hosting: Cloudflare Pages

**Context.** The Mini App is a pure static site (`apps/web-app` → `dist/`). Notes
live in device `localStorage` + Telegram Cloud Storage — there is **no backend data
store** to host. The only hard requirement is HTTPS static hosting at a URL Telegram
accepts.

**Decision.** Host `dist/` on **Cloudflare Pages**, project `notepher`, production URL
**`https://notepher-8ci.pages.dev`**.

**Why.**
- Free forever (verified against Cloudflare's current pricing): unlimited bandwidth
  and static requests, no credit card, no time limit. We use zero Pages Functions, so
  the only metered quota never applies.
- Instant HTTPS `*.pages.dev` URL that Telegram accepts as a Mini App URL with **no
  domain to buy and no certificate to manage**.
- One-command deploys (`wrangler pages deploy dist`).
- **Completely isolated** from any other infrastructure — nothing shared, nothing to
  break or be broken by.
- The build is root-hosted (`base: '/'`), so `dist/` ships unchanged and the PWA
  service worker is scoped cleanly to `/`.

### Rejected: reuse an existing production CloudFront/S3 distribution

Technically possible and the marginal dollar cost is ~zero, but it was rejected on
**coupling**, not cost (cost is explicitly not a tiebreaker here):

- The production bucket had a daily cleanup Lambda that deletes objects older than
  24h except a hard-coded preserve list — Notepher's files would be **deleted every
  day** unless that production Lambda were edited for a personal side-app.
- Serving under a path prefix (`/notepher/`) would force a `base: '/notepher/'`
  rebuild and a service-worker scope under that prefix; a clean subdomain instead
  would mean an ACM cert SAN + DNS record + a change to the production CDN's
  infrastructure template.
- Net effect: every future change to that production system (cleanup logic, bucket
  policy, cache behaviors, invalidations, cert/domain) would have to account for a
  notes app, and vice versa. That entanglement buys nothing over Cloudflare Pages,
  which is also free.

### Rejected: dedicated AWS (own bucket + own CloudFront + own stack)

The "stay in AWS but isolated" option: a new dedicated S3 bucket, its own CloudFront
distribution, an ACM cert, DNS, and a small CloudFormation stack, with its own
subdomain. Fully decoupled and uses already-owned infra — but materially more setup
(bucket, distribution, cert, DNS, stack) and not free-tier-forever the way Pages is
(pennies/month, but non-zero). Chosen against in favour of Pages' zero-setup, $0,
zero-coupling profile. This remains the fallback if avoiding a Cloudflare account ever
outweighs those advantages.

---

## 3. No bot backend (menu-button-only)

**Context.** The repo ships an optional grammY bot (`apps/bot`) that adds nicer
`/start` UX, `/setcommands`, and i18n. Upstream's own README states the Mini App is
**fully functional without it**.

**Decision.** Do **not** run the bot. Make the app reachable purely via BotFather's
`/setmenubutton` pointing at the Pages URL.

**Why.** The bot is a persistent Node process (polling or webhook) — an always-on
thing to host, monitor, and keep patched — for UX polish the app doesn't need to
function. YAGNI. The menu button alone delivers the whole app.

**Consequence.** Nothing server-side to operate. If richer bot UX is wanted later,
`apps/bot` can be brought up independently (needs `BOT_TOKEN` + `WEB_APP_URL`); it does
not change how the Mini App is hosted.

---

## 4. Deploy mechanism: classic Pages via wrangler (not Workers)

**Context.** `wrangler@4` tries to "helpfully" convert a `pages project create` into a
Workers + Vite project: it scaffolds `wrangler.jsonc`, rewrites `package.json`
scripts, creates a second `vite.config.ts` alongside the real `vite.config.mts`,
installs `@cloudflare/vite-plugin`, and runs a build — which fails here on an ESM-only
plugin loaded via `require`.

**Decision.** Use **classic Cloudflare Pages** (static asset host), created once with
`wrangler pages project create notepher --production-branch main --force`. The
`--force` flag bypasses the Workers delegation and is needed **only** for that initial
create; subsequent `wrangler pages deploy` commands run against classic Pages directly
and must **not** pass `--force`.

**Why.** We want a dumb static CDN for a pre-built `dist/`, not a Workers runtime with
server-side build config. The classic path uploads the already-built folder and does
nothing else — no build on Cloudflare's side, no injected config.

**Gotcha / cleanup.** The first (delegated) attempt mutated the working tree
(`.gitignore`, `package.json`, `package-lock.json`, plus new `vite.config.ts` and
`wrangler.jsonc`). These were all reverted/removed — the fork must stay clean of
Cloudflare scaffolding. If you ever see a `vite.config.ts` or `wrangler.jsonc` appear
in `apps/web-app`, it's that auto-config leaking back in; delete it.

---

## Operations quick reference

**Production URL:** `https://notepher-8ci.pages.dev` (stable alias → latest `main`
deploy; per-deploy immutable URLs look like `https://<hash>.notepher-8ci.pages.dev`).

**Redeploy** (after any source change):

```bash
cd apps/web-app
npm run build
npx wrangler pages deploy dist --project-name notepher --branch main
```

**Verify a deploy is live:**

```bash
curl -sS -o /dev/null -w "HTTP %{http_code} %{content_type}\n" https://notepher-8ci.pages.dev/
```

**Set / change the Telegram menu button:** BotFather → `/setmenubutton` → select bot →
send the Pages URL → set button text.

**Known cosmetic issue.** `index.html` links `/favicon.ico`, which the repo doesn't
ship → a harmless 404 in the webview. Drop a `favicon.ico` into `apps/web-app/public/`
and rebuild to silence it.
