import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { hostedExtras } from './hosted.mjs';
import { readAccepted, classifyAccepted, acceptedDraft } from './accepted.mjs';

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const workspace = fs.realpathSync(process.env.GITHUB_WORKSPACE);
process.chdir(workspace);
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
process.env.BURR_GENERATE_ACCEPTED ??= 'false';
for (const name of ['BURR_FAIL_INTERFERENCE', 'BURR_FAIL_UNRESOLVED', 'BURR_COMMENT', 'BURR_GENERATE_ACCEPTED']) {
  if (!['true', 'false'].includes(process.env[name])) throw new Error(`${name} must be true or false`);
}
const acceptedEntries = readAccepted(workspace, process.env.BURR_ACCEPTED_FITS || '.burr/accepted.yml');
const api = async (route, method = 'GET', body) => {
  const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'burr-action', 'X-GitHub-Api-Version': '2022-11-28' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${route}: ${response.status}`);
  return response.json();
};
let candidates;
if (process.env.BURR_FILES.trim()) {
  candidates = JSON.parse(execFileSync('python3', ['-c', 'import glob,json,sys; print(json.dumps(sorted(set(p for g in sys.argv[1:] for p in glob.glob(g,recursive=True)))))', ...process.env.BURR_FILES.split('\n').map(v => v.trim()).filter(Boolean)], { encoding: 'utf8' }));
} else if (event.pull_request) {
  candidates = [];
  for (let page = 1; ; page++) {
    const files = await api(`pulls/${event.pull_request.number}/files?per_page=100&page=${page}`);
    candidates.push(...files.filter(f => f.status !== 'removed').map(f => f.filename));
    if (files.length < 100) break;
    if (page === 30) throw new Error('GitHub limits PR file lists to 3000; use files globs for this PR');
  }
} else {
  candidates = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0');
}
const files = [...new Set(candidates)].filter(f => /\.(step|stp)$/i.test(f)).sort();
const timeout = Number(process.env.BURR_TIMEOUT);
if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) throw new Error('timeout must be 1–3600 seconds');
const reports = [];
for (const file of files) {
  let report;
  try {
    const resolved = fs.realpathSync(file);
    if (!resolved.startsWith(workspace + path.sep) || !fs.statSync(resolved).isFile()) throw new Error('assembly must be a file inside the checkout');
    const result = spawnSync(path.join(process.env.BURR_DIRECTORY, 'burr'), ['check', '--json', resolved], { encoding: 'utf8', timeout: timeout * 1000, maxBuffer: 32 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (![0, 1, 3].includes(result.status)) throw new Error(`Burr exited ${result.status}: ${result.stderr.slice(-2000)}`);
    report = JSON.parse(result.stdout);
    if (report.schema_version !== 'burr.checks.v1' || !Array.isArray(report.findings) || !['pass', 'fail', 'incomplete'].includes(report.outcome)) throw new Error('Unsupported Burr report; install a release with check --json');
    if (!Number.isSafeInteger(report.checked_pair_count) || report.checked_pair_count < 0 || typeof report.pair_set_complete !== 'boolean') throw new Error('Unsupported Burr pair coverage');
    if (report.pair_set_complete && ((report.unresolved_pairs || []).length || (report.incomplete_reasons || []).length || report.outcome === 'incomplete')) throw new Error('Burr completeness and unresolved geometry disagree');
    if ((result.status === 0) !== (report.outcome === 'pass') || (result.status === 1) !== (report.outcome === 'fail')) throw new Error('Burr exit code and report disagree');
    report.model_path = file;
  } catch (error) {
    report = { model_path: file, outcome: 'incomplete', pair_set_complete: false, findings: [], incomplete_reasons: [{ code: 'check_error', message: error.message }] };
  }
  reports.push(report);
  console.log(`${file}: ${report.outcome}; ${report.findings.length} interference(s), ${(report.unresolved_pairs || []).length} unresolved pair(s)`);
}
const staleAccepted = classifyAccepted(reports, acceptedEntries);
if (process.env.BURR_GENERATE_ACCEPTED === 'true') {
  const draftPath = path.join(process.env.RUNNER_TEMP, 'burr-accepted-draft.yml');
  const draft = acceptedDraft(reports);
  fs.writeFileSync(draftPath, draft);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `accepted-draft-path=${draftPath}\n`);
  console.log(`Draft accepted.yml (review required; no findings auto-accepted):\n${draft}`);
}
const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ').replace(/[\\`|*_[\]@]/g, c => `&#${c.charCodeAt(0)};`);
const pair = item => item.components.map(c => escape(c.name || c.definition_name || c.id)).join(' ↔ ');
const table = items => ['| Parts | Reason |', '| --- | --- |', ...items.slice(0, 100).map(item => `| ${pair(item)} | ${escape(item.message)} |`), ...(items.length > 100 ? [`\n${items.length - 100} more pairs in the JSON report.`] : [])].join('\n');
let summary = '<!-- burr-action-summary -->\n## Burr assembly checks\n\n';
if (!reports.length) summary += 'No matching STEP/STP assemblies to check.\n';
for (const report of reports) {
  const unresolved = report.unresolved_pairs || [];
  const contacts = report.contact_pairs || [];
  const complete = report.pair_set_complete === true;
  const count = Number.isSafeInteger(report.checked_pair_count) && report.checked_pair_count >= 0 ? report.checked_pair_count : 'Unknown number of';
  const accepted = report.accepted_fits;
  const remaining = report.unaccepted_findings;
  summary += `### ${escape(report.model_path)}\n\n${complete ? '' : '**INCOMPLETE — not a pass.** '}${count} pairs checked: ${remaining.length} interfering, ${contacts.length} touching${accepted.length ? `, ${accepted.length} accepted fit(s)` : ''}${complete ? ', all others proven clear' : `; ${unresolved.length} unresolved pair(s), clear remainder not proven`}\n\n`;
  if (remaining.length) summary += table(remaining) + '\n\n';
  if (accepted.length) {
    summary += '**Accepted fits**\n\n' + table(accepted.map(fit => ({ ...fit,
      message: `${fit.accepted_reason} (${fit.acceptance}${fit.volume_limit_enforced === false ? '; volume cap not enforced' : ''})` }))) + '\n\n';
    if (accepted.some(fit => fit.volume_limit_enforced === false)) console.log('::warning::Accepted fit volume cap not enforced: Burr did not report a measured overlap volume.');
  }
  if (unresolved.length) summary += '**Unresolved pairs**\n\n' + table(unresolved) + '\n\n';
  for (const reason of report.incomplete_reasons || []) summary += `- ${escape(reason.code)}: ${escape(reason.message)}\n`;
  if (contacts.length) summary += `\n<details><summary>Contact pairs (${contacts.length})</summary>\n\n${table(contacts)}\n\n</details>\n\n`;
}
if (staleAccepted.length) {
  summary += '**Stale accepted fits (warning)**\n\n| Assembly | Parts | Reason |\n| --- | --- | --- |\n' +
    staleAccepted.map(entry => `| ${escape(entry.assembly)} | ${entry.parts.map(escape).join(' ↔ ')} | ${escape(entry.reason)} |`).join('\n') + '\n\n';
  console.log(`::warning::${staleAccepted.length} accepted fit entry/entries matched no reported interference. See Stale accepted fits in the summary.`);
}
const interference = reports.some(r => r.unaccepted_findings.length > 0);
const incomplete = reports.some(r => r.outcome === 'incomplete' || r.pair_set_complete !== true);
const status = interference ? 'interference' : incomplete ? 'incomplete' : 'pass';
const reportPath = path.join(process.env.RUNNER_TEMP, 'burr-reports.json');
fs.writeFileSync(reportPath, JSON.stringify({ status, assemblies: reports, stale_accepted_fits: staleAccepted }, null, 2));
fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\nreport-path=${reportPath}\n`);
const extras = await hostedExtras({ token: process.env.BURR_TOKEN, repository,
  runId: process.env.GITHUB_RUN_ID, report: { status, assemblies: reports } });
console.log(`Burr hosted extras: ${extras.status}`);
const runUrl = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
summary += `\n[Workflow run](${runUrl}) · Burr reports proven interference only; unresolved geometry is shown separately.\n`;
if (summary.length > 60000) summary = summary.slice(0, 59000) + `\n\nReport truncated. See the JSON artifact in the [workflow run](${runUrl}).\n`;
fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (process.env.BURR_COMMENT === 'true' && event.pull_request) {
  try {
    let existing;
    for (let page = 1; ; page++) {
      const comments = await api(`issues/${event.pull_request.number}/comments?per_page=100&page=${page}`);
      existing = comments.find(c => c.user.login === 'github-actions[bot]' && c.body.startsWith('<!-- burr-action-summary -->'));
      if (existing || comments.length < 100) break;
    }
    await api(existing ? `issues/comments/${existing.id}` : `issues/${event.pull_request.number}/comments`, existing ? 'PATCH' : 'POST', { body: summary });
  } catch (error) { console.log(`::warning::Could not update Burr PR comment (${error.message}). The job summary is available; forks normally have read-only tokens.`); }
}
if ((interference && process.env.BURR_FAIL_INTERFERENCE === 'true') || (incomplete && process.env.BURR_FAIL_UNRESOLVED === 'true')) process.exitCode = 1;
