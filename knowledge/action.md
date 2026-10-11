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
