# The work loop

How a change gets from an issue to `main`. The other files in this directory say
which tools to reach for; this one says what order to use them in and what
"done" means. It is written for an agent working unattended, so every step names
the command rather than the intention.

## 1. Pick the work

Issues live in `Eug1n1/kubi` (see [`issue-tracker.md`](issue-tracker.md)). The
triage label vocabulary is in [`triage-labels.md`](triage-labels.md).

```sh
gh issue list --state open --label ready-for-agent \
  --json number,title,body,labels --jq '.[] | {number, title}'
```

`ready-for-agent` means the issue holds up on its own: a stated problem, an
outcome, acceptance criteria and a way to verify it. If it does not, it is not
ready — say what is missing on the issue and move it to `needs-info` rather than
guessing.

Claim it before starting, so two sessions do not collide:

```sh
gh issue edit <n> --add-assignee @me
gh issue view <n> --json number,title,body,labels,comments
```

Read the issue twice: the body holds the spec, the comments hold what was
already decided. Then read the domain docs it touches — [`GLOSSARY.md`](../../GLOSSARY.md)
for the vocabulary and [`docs/adr/`](../adr/) for decisions already made. A
proposal that contradicts an ADR has to say so explicitly.

## 2. Start from a clean, verified base

```sh
make doctor      # can this machine build, test and screenshot?
make install     # only when node_modules is missing
git switch -c fix/namespace-menu-width main
```

Branch names follow the commit type: `feat/…`, `fix/…`, `docs/…`, `chore/…`.

## 3. Orient before editing

[`AGENTS.md`](../../AGENTS.md) is the map: where the engine, the UI state and the
stylesheet live, and which invariants must not break. `make verify` on the
untouched branch tells you the baseline is green before you start — if it is
not, that is the first thing to report, not the last.

Adding a command or an event touches four places (`model.rs`, the dispatch match
in `engine.rs`, `types.ts`, the handler in `useKubi`). The protocol mirror test
covers the Rust and TypeScript sides agreeing; the rest is on you.

## 4. Make the change

The smallest complete change, in the shape the code already has. Comments record
decisions, traps and trade-offs in one line — not what the next line does.
American spelling (color, behavior, center).

## 5. Verify

```sh
make verify      # format, clippy, frontend build, JS tests, Rust tests
```

That is the floor, not the proof. What else depends on what changed:

| Changed | Also run | And |
| --- | --- | --- |
| A screen, a menu, a drawer | `make shots` | look at the PNGs before believing them |
| The palette or `theme.ts` | `make contrast` | it exits non-zero on a failing pair |
| Rust logic | `cargo test -p kubi-core` | a new rule gets a test next to it |
| Pure TS logic | `npm test --prefix apps/desktop` | `*.test.ts` next to the module |
| The protocol | `cargo test -p kubi-core --test protocol_mirror` | it names the tag that drifted |

Two things the harness cannot show, and what to do instead, are in the
"Checking a change" section of [`AGENTS.md`](../../AGENTS.md): `:hover` and
`:active` never fire in a static render, and portals do not render through SSR.
Screenshotting an interaction means mounting the component in a real browser.

If a check cannot be run here, say which one and why in the pull request. An
unverified change presented as verified is worse than an unverified one.

## 6. Record it

- A user-visible change gets a `CHANGELOG.md` line under `Unreleased`, phrased
  for a user rather than a developer. A pure refactor does not need one.
- A behaviour or screen change updates `README.md` and the harness in the same
  commit.
- Commit messages: `type(scope): imperative summary`, then a body that says why
  the change is needed and how it was checked.

```sh
git add -A
git commit -m "fix(desktop): give the namespace menu one shared width

A short name highlighted only its own text, so the row looked broken. The menu
now sizes every row to the widest name. Checked with make shots and by hand in
dev mode."
```

## 7. Open the pull request

```sh
git push -u origin fix/namespace-menu-width
gh pr create --fill --body-file .github/PULL_REQUEST_TEMPLATE.md
```

Fill in the template rather than deleting sections: "how it was verified" is the
part a reviewer cannot reconstruct. Reference the issue (`Closes #<n>`).

Then watch CI and fix what it finds:

```sh
gh pr checks --watch
```

`main` requires a pull request and a green CI run, so nothing is merged by
pushing to it. Leave the merge to the maintainer unless the task said otherwise.

## When to stop and ask

Stop, and say so on the issue, when:

- the acceptance criteria cannot all be met without changing behaviour the issue
  did not mention;
- the change needs an invariant from `AGENTS.md` to be broken;
- a decision contradicts an ADR;
- verification needs a real cluster, and none is available — engine tests and the
  harness never touch one, so a change that needs a live cluster cannot be
  finished unattended.

A blocked issue with a clear question is a good outcome. A guessed
implementation presented as done is not.
