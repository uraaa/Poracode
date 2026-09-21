# Fork changes

What `uraaa/Poracode` adds on top of upstream `Porabuild/Poracode`, and where
each piece lives. Everything below sits on `feat/import-sessions`, branched off
`master`; current fork version is 1.8.5.

The fork keeps three kinds of change apart on purpose: features upstream does
not have, plumbing that only matters because this is a fork, and fixes to
upstream bugs that are worth offering back.

## 1. Codex profiles

Upstream ships profile support for Claude only. The fork registers Codex as a
profile driver, so several Codex logins can live side by side the way Claude
logins already do.

- Each profile gets an isolated `CODEX_HOME` (`~/.poracode/codex-profiles/<id>`),
  created before the first login rather than on first use — an empty home made
  `codex login` fail.
- Profiles are managed from the Codex settings page, and the profile's state is
  linked into the login overlay on every launch, not only the first.
- Usage is reported per profile instead of collapsing every Codex login into one
  bucket.

Code: `src/supervisor/agents/codex/` (`codexProfile`, `codexUsageProfiles`,
`session.ts`, `plugin/install.ts`), `src/shared/contracts` profile driver
registration, `src/renderer/views/SettingsOverlay`.

## 2. Importing existing CLI sessions

Conversations held in Claude Code or Codex outside Poracode can be pulled in and
continued as normal threads, with their full history.

**Discovery.** `src/main/sessionImport/homes.ts` enumerates every provider home:
the base account plus one per enabled profile. Claude transcripts are JSONL under
the config dir; Codex keeps rollout files under its own home. Only transcript
heads are read while listing, so a scan over hundreds of sessions stays under a
second.

**Attribution.** Claude Code writes every session into the config dir it runs
with, so a conversation held under a work login still lands in `~/.claude`. The
transcript's owner id is what says whose it is, and that is what the account
filter uses.

**Titles.** Both providers name a conversation after the fact — Claude Desktop
appends `custom-title` records to the transcript (read from the tail), Codex
Desktop stores `name`/`title` in `~/.codex/state_*.sqlite` (read-only). The first
prompt is only a fallback. Generated Codex titles have injected context stripped.

**Replay.** `src/main/sessionImport/replay.ts` turns a transcript into the same
canonical runtime events a live session emits, so the existing persistence layer
owns ordering, positions and stream storage. Nothing about imported threads is
special downstream — which is why an imported thread resumes, renders and
persists like any other.

**UI.** A full import panel with faceted filters (provider, account, project
folder) and a text filter over title, first message and folder; entry points in
the sidebar, in settings, and per project. Imported threads are marked in the
chat header.

Code: `src/main/sessionImport/`, `src/renderer/components/sessionImport/`,
`src/shared/contracts/sessionImport.ts`, `src/shared/ipc/procedures/sessionImport.ts`.

Design and plan: `docs/superpowers/specs/2026-09-20-import-cli-sessions-design.md`,
`docs/superpowers/plans/2026-09-20-import-cli-sessions.md`.

## 3. Fork release plumbing

The installed app checks GitHub releases for updates. Left pointing at upstream,
it would offer to replace a fork build with an upstream one that has neither
profiles nor import. The update feed therefore points at the fork
(`scripts/build-desktop-artifact.mjs`, `package.json`).

Releases are published on the fork (`v1.8.5` onwards) with the installer, its
blockmap and `latest.yml`, so in-app update works end to end. Builds are
unsigned; electron-updater skips signature verification because `app-update.yml`
carries no `publisherName`.

Releases are cut on request, not per change.

## 4. Upstream fixes

Both are upstream bugs found while working on the fork, and neither depends on
fork-only code.

- **Resumed launches dropped their first prompt.** The supervisor assumed a
  thread started with a `sessionRef` would receive its prompt separately. For
  threads it had already seen this never surfaced; a freshly imported thread was
  new to it, so the first message rendered in the chat and went nowhere.
  A resuming launch now starts the turn like any other. (`4bf0e3c31`)
- **An attachment could not be sent without a caption.** The composer required
  text, and the IPC schema rejected an empty prompt even when an attachment was
  present — the rejection surfaced only as a toast. A caption-less attachment is
  now a message in its own right. (`5cea5c527`)

## Working on the fork

- `origin` is `uraaa/Poracode`, `upstream` is `Porabuild/Poracode`.
- Feature work branches off `feat/import-sessions`, which carries everything
  above.
- Specs and plans go in `docs/superpowers/specs/` and `docs/superpowers/plans/`.
