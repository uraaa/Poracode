# How work happens on this fork

For agents and for whoever is driving them. The rules exist because several
agents work this repository at once, and because a desktop app that ships an
auto-updater cannot afford a bad build.

## The shape of it

```
one feature  →  one branch  →  one worktree  →  one PR into the fork's master
```

Nothing is merged without the repository owner saying so. Nothing reaches
upstream at all for now.

## 1. A worktree per piece of work

Never work two features in one checkout. Two agents sharing a checkout will
switch each other's branch mid-edit — it has happened here, and the result was
one agent's changes sitting on another agent's branch.

Create the worktree where the app itself keeps them, `<project>/.poracode/worktrees/<name>`:

```bash
git worktree add .poracode/worktrees/<name> -b feat/<name> master
```

`.gitignore` already covers `**/worktrees/`, so the outer checkout never sees
it as untracked files.

Dependencies: run `pnpm install` inside the worktree. `pnpm-workspace.yaml`
shares the virtual store across checkouts, so this links packages rather than
copying them, and it wires the repository's own workspace packages correctly.

Linking `node_modules` from the main checkout by hand looks cheaper and is not
worth it. On Windows `mklink /J` fails quietly often enough that half the
worktrees in one session ended up with a real install regardless, and a link
that does succeed points the worktree's tooling at a different set of resolved
paths than pnpm would have produced.

**Removing a worktree can break the main checkout.** pnpm links a workspace
package from whichever checkout installed it last, so deleting a worktree can
leave the main checkout holding a dangling link:

```
node_modules/@poracode/agents-usage -> .poracode/worktrees/<deleted>/packages/agents-usage
```

`pnpm typecheck` then fails with a hundred "Cannot find module" errors that have
nothing to do with the change in front of you. So when the branch is merged and
the worktree is done:

```bash
git worktree remove .poracode/worktrees/<name>
pnpm install        # in the main checkout, to repair the workspace links
```

If the directory survives `git worktree remove`, it is usually its
`node_modules` holding it. Check whether that directory is a link before
deleting it recursively: deleting through a junction takes the target with it,
and the target may be the main checkout's `node_modules`.

## 2. Branch names

- `feat/<thing>` — a feature
- `fix/<thing>` — a defect with a user-visible symptom
- `perf/<thing>`, `refactor/<thing>`, `chore/<thing>`, `docs/<thing>`

Branch off `master` unless the work genuinely builds on another open branch. If
it does, say so in the PR and merge in order.

## 3. While the work is in progress

- Write the failing test first. A test written after the code passes
  immediately, which proves nothing.
- Commits are Conventional Commits, and the body says _why_, not _what_ — the
  diff already says what.
- Before opening the PR, all three must be clean locally:
  ```bash
  pnpm exec vitest run <the suites you touched>
  pnpm lint
  pnpm typecheck
  ```
- Do not chase failures you did not cause. Some suites fail on a clean tree in
  some environments; prove it by stashing your changes and re-running before
  blaming yourself — and say so in the PR.
- Renderer strings are localized. Wrap in a Lingui macro, run
  `pnpm i18n:extract`, fill the Russian catalog at minimum. See `AGENTS.md`.
- Agent scratch — plans, reports, review packages — lives under
  `.superpowers/`, which is git-ignored. It never enters a commit.

## 4. The PR is the end of the work, not the start of the review

Open the PR when the branch is finished and green locally:

```bash
git push -u origin <branch>
gh pr create --repo uraaa/Poracode --base master --fill
```

`ci.yml` runs on every pull request into `master`: typecheck, lint, fmt, test.

**A change counts as confirmed when its PR is green.** Not when an agent says
it works, not when someone ran the tests locally once. That rule exists so work
from a session nobody reviewed carries the same evidence as work that was
reviewed twice.

The PR body says what changed, what the user will notice, and what was
measured. Numbers beat adjectives: "warm scan 514 ms → 11 ms" is worth more
than "faster".

## 5. Merging is the owner's call

Agents do not merge. A green PR waits until the repository owner says to merge
it. Several green PRs can wait together — that is the point: they are batched
into one release instead of producing an installer per fix.

Order matters when one branch builds on another. Say the order in the PR and
merge in it.

## 6. What happens on master

`build-master.yml` builds the installers on every push to `master` and keeps
them as workflow artifacts. That is the automatic part: it proves the merged
state builds on all three platforms without anyone touching a local machine.

It does **not** publish a release, and the auto-updater never sees those
artifacts.

## 7. Releasing is a separate command

A release happens when the owner asks for one, never per fix:

1. Add the version's entry to `website/public/changelog.json` — the release
   workflow refuses to run without it, and the app reads that file for its
   in-app changelog.
2. Bump the version. Patch for fixes (`1.8.5` → `1.8.6`), minor for features
   (`1.9.0`). The version must be valid semver: `electron-updater` compares by
   semver, and a fourth digit (`1.8.5.1`) is not one — `1.8.5-1` would be read
   as _older_ than `1.8.5` and never offered as an update.
3. Run the `Release (stable)` workflow on the fork. It builds every platform,
   creates the tag and publishes the GitHub Release atomically, and the
   installed app picks it up on its next update check.

## 8. Upstream stays untouched

`upstream` is `Porabuild/Poracode`. Nothing is pushed there and no PR is opened
there for now. Once the fork's changes have been used long enough to trust,
the ones that are not fork-specific can be offered back — the two upstream bug
fixes listed in `FORK_CHANGES.md` are the obvious first candidates.

Keep that future in mind while working: a change that does not depend on
fork-only features should stay separable from one that does.

## Running several features at once

This is the normal case here, not the exception.

- One worktree per feature, as above. Never two agents in one checkout.
- Before splitting work across agents, check which files each piece touches.
  Two branches that both edit one file will conflict at merge time, and two
  _agents_ editing that file at the same moment will destroy each other's work.
  Group by file ownership, not by convenience.
- If the pieces are genuinely independent, they can run in parallel. If they
  share a file, run them in sequence and say so.
- A shared test file counts as a shared file. So does a shared contract or
  schema: two branches adding a field to the same type will conflict even
  though they never open the same feature.
- The last branch to merge rebases onto the others. It does not revert them.

## When something is wrong with the plan itself

Say so, with evidence, instead of implementing it anyway. A brief that turns
out to be wrong is worth more as a corrected brief than as code that follows
it. Measure before proposing a performance fix, and measure again after — the
numbers go in the PR.
