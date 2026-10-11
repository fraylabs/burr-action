# Burr Action

Check STEP assemblies for interference on every pull request. Burr uses the
geometry in your assembly to report proven interference, contact, and unresolved
pairs separately. Your CAD files stay on the GitHub runner.

```yaml
name: Assembly checks
on: [pull_request]
permissions:
  contents: read
  pull-requests: write # only needed for comment: true
jobs:
  burr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: fraylabs/burr-action@v1
        with:
          comment: 'true'
```

By default, the action checks only added, modified, or renamed `.step` / `.stp`
files in the PR (case insensitive). Deleted files are skipped. Outside a PR it
checks tracked STEP files. Set `files` to newline-separated globs to check a
specific set instead, for example `models/**/*.step`.

Every assembly gets a job summary with part names and interference reasons,
unresolved counts and reasons, and contact pairs folded away. An incomplete
check is never called a pass. The optional comment is created or updated by
`github-actions[bot]`; a read-only fork token simply skips the comment with a
warning. Use `pull_request`, never `pull_request_target` to execute untrusted CAD.

| Input | Default | Meaning |
| --- | --- | --- |
| `version` | `0.40.4` | Released Burr version, or `latest` |
| `files` | empty | Newline-separated Python globs, relative to checkout |
| `fail-on-interference` | `true` | Fail on proven interference |
| `fail-on-unresolved` | `true` | Fail on incomplete checks, import errors, or timeouts |
| `comment` | `false` | Update one PR comment using the workflow token |
| `github-token` | `${{ github.token }}` | Token for changed files and optional comment |
| `timeout` | `300` | Seconds per assembly (1–3600) |

Linux x64 and macOS x64/arm64 runners are supported. Released binaries are
checksum-verified and cached by version, OS, and architecture. Burr 0.40.4 or
newer is required for `check --json`.

Outputs: `status` (`pass`, `interference`, `incomplete`) and `report-path` (a JSON
file containing all assembly reports). To retain the JSON, give the action an
`id` and upload `${{ steps.<id>.outputs.report-path }}` with
`actions/upload-artifact@v4` in an `if: always()` step.

[Real passing and failing PRs](https://github.com/fraylabs/burr-action-demo/pulls)
show the action running against redistributed open-source STEP assemblies.

MIT license. Burr itself: [fraylabs/burr](https://github.com/fraylabs/burr).
