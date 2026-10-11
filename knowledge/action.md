# How the action checks assemblies

The composite action resolves a released Burr version, restores its binary
cache, and downloads the platform archive and SHA-256 checksum on a cache miss.
It runs the headless checker once per assembly. JSON is the same burr.checks.v1
schema used in Burr's viewer; exit 0 is complete pass, 1 interference, 2 command
or import error, and 3 incomplete. Import errors and timeouts become incomplete
assembly entries, so one bad file does not suppress reports for the others.

PR file selection uses GitHub's paginated files API, including renames and
excluding deletions. Explicit globs use Python's standard glob library. Paths
are checked to stay inside the checkout, including symlink resolution. The
action never runs CAD-supplied code. CAD parsing still consumes untrusted input,
so workflows must use pull_request with ordinary runner isolation.

Reports are written before the failure exit. Comment permission errors warn
without erasing the summary or changing the geometry verdict. Comments are
updated only when their author is github-actions[bot] and the marker matches.

## Live verification

- [Failing PR](https://github.com/fraylabs/burr-action-demo/pull/1): a deliberately
  overlapping MIT box assembly reports one proven `fixed`/`moving` interference,
  zero unresolved pairs, and a failed job.
- [Passing PR](https://github.com/fraylabs/burr-action-demo/pull/2): the GPL Voron
  mount has two separated solids, zero interference and unresolved pairs, and a
  complete pass.
- [Runner compatibility](https://github.com/fraylabs/burr-action-demo/actions/runs/38116650326):
  ubuntu-latest and macos-14 pass using released Burr 0.40.4. Report-only mode
  succeeds while its output remains `interference`.
- Rerunning both PRs keeps their original GitHub Actions comment IDs. The clean
  rerun logs a binary cache hit and successful restore.
