# CLAUDE.md — Notepher (self-hosted fork)

Guidance for Claude Code working in this repository. Read this first; for the *why*
behind decisions see **[docs/architecture-decisions.md](docs/architecture-decisions.md)**.

## What this is

A privately self-hosted fork of [`deptyped/notepher-bot`](https://github.com/deptyped/notepher-bot)
(MIT) — a note-taking **Telegram Mini App**. Notes live in device `localStorage` +
Telegram Cloud Storage; there is **no backend data store**. The app is a pure static
site served over HTTPS; a Telegram bot menu button opens it.

This repo is **independent of any other project** on this machine. All work stays here.
Origin: `janschaf/notepher-bot` (fork). Auto-commit and push to `main` after completed work.

## Layout (monorepo)

| Path | What |
|------|------|
| `apps/web-app` | The Mini App (Vue 3 + Pinia + Vite 8 + tiptap 3). **This is what gets deployed.** |
| `apps/bot` | Optional grammY bot (nicer `/start`, i18n). **Not run** — see decision 3. |
| `docs/architecture-decisions.md` | Full ADR record of hosting / bot / deploy / tiptap decisions. |
| `assets/` | Logo/header images for the README. |

## Hosting & deploy (the live setup)

- **Host:** Cloudflare Pages, project `notepher`. Pure static, no Workers, no Functions.
- **Production URL:** `https://notepher-8ci.pages.dev` (stable alias → latest `main` deploy).
- **Reachability:** BotFather `/setmenubutton` → that URL. No bot process runs.

**Redeploy after a source change:**

```bash
cd apps/web-app
npm run build                 # type-check + vite build → dist/
npx wrangler pages deploy dist --project-name notepher --branch main
```

**Verify a deploy is live:**

```bash
curl -sS -o /dev/null -w "HTTP %{http_code} %{content_type}\n" https://notepher-8ci.pages.dev/
```

Deploys need Cloudflare auth (`npx wrangler login`, one-time, browser). The build is
root-hosted (`base: '/'`); the real Vite config is **`vite.config.mts`**.

## Gotchas (will bite a fresh session)

- **tiptap read-only checkboxes.** The task-list read-only toggle is hand-fixed in
  `apps/web-app/src/components/notes/NoteEditor.vue` (`onReadOnlyChecked`, DOM-resync
  strategy) because tiptap 3 changed the signature and the old v2 patch was dropped.
  If you upgrade tiptap, re-verify that function. Details: decision 1 in the ADR.
- **wrangler auto-config pollution.** `wrangler@4` tries to convert the Pages project
  into a Workers+Vite project — scaffolding `wrangler.jsonc`, a stray `vite.config.ts`
  (alongside the real `.mts`), and rewriting `package.json`. The project already exists
  as **classic Pages**, so this won't recur in normal use — but if you ever see
  `wrangler.jsonc` or `apps/web-app/vite.config.ts` appear, delete them; they're leakage.
  Never pass `--force` to deploy commands (it was needed only for the one-time create).
- **favicon 404.** `index.html` links `/favicon.ico` which the repo doesn't ship —
  harmless. Add one to `apps/web-app/public/` and rebuild to silence it.

## Conventions

- **Tooling:** npm (there's a `package-lock.json`); Node ≥18 (developed on 24).
- **UI language:** English for all user-facing strings.
- **Testing read-only behavior** means emulating a touch/mobile viewport — the editor
  is only read-only (and checkboxes only route through `onReadOnlyChecked`) in that mode.
- Keep the fork clean of deploy scaffolding and local scratch; commit explicit paths.
