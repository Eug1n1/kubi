# What this changes, and why

<!-- One paragraph. Say what was broken or missing and what the change does about it. -->

## How it was verified

<!-- The exact commands you ran and what they printed. "make verify" passing is
     the floor; say what else you did — a harness page you looked at, a case you
     tried by hand, a test that failed before the change and passes after. -->

- [ ] `make verify` (format, clippy, frontend build, JS tests, Rust tests)
- [ ] `make contrast` if the palette changed
- [ ] `make shots` if a screen changed — attach or link the screenshots

```
<paste the commands and their output here>
```

## Checklist

- [ ] A user-visible change has a `CHANGELOG.md` line under `Unreleased`, written
      for a user rather than for a developer.
- [ ] A behaviour or screen change updates `README.md`, and a visual one updates
      the harness in the same commit.
- [ ] Tests live next to the code (`mod *_tests` in Rust, `*.test.ts` in TS) and
      cover a pure function or engine bookkeeping, never a live cluster.
- [ ] No invariant from `AGENTS.md` is broken — in particular:
  - a cluster is named, never assumed (every cluster-touching command and event
    carries `context`);
  - connecting is additive (`Connect`/`Disconnect` leave other clusters alone);
  - each `AppEvent` is a one-key object, and `model.rs` / `types.ts` still agree;
  - `useKubi()` stays the only owner of cluster state.

## Related

<!-- Closes #123, Part of #100 -->
