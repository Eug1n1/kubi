# Kubi

A desktop workbench for Kubernetes: many clusters at once, one window or one
window per cluster, the user's choice.

## Language

**Context**:
A named entry in the user's kubeconfig that says how to reach one cluster.
_Avoid_: profile, account

**Cluster**:
The Kubernetes environment a context points at. A context names a cluster;
they are not interchangeable words.
_Avoid_: context (when the environment itself is meant)

**Context window**:
A window pinned to exactly one context; that cluster is all it can show, and it
cannot switch to another.
_Avoid_: separate window, detached window (that is a different thing)

**Detached window**:
A log or exec dock pane moved into its own window; it keeps running when the
owning window moves to another cluster.
_Avoid_: context window, separate window

**Update**:
An in-place replacement of the installed app through the updater with a
restart — not downloading an installer by hand, and not refreshing cluster data.
_Avoid_: upgrade (means the same thing; Update is the word the UI uses)

**About**:
The Settings tab that shows the running version, the update status, and the
Check for updates action.
_Avoid_: updates tab, version page
