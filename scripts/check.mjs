import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const workspace = fs.realpathSync(process.env.GITHUB_WORKSPACE);
process.chdir(workspace);
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
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
    if ((result.status === 0) !== (report.outcome === 'pass') || (result.status === 1) !== (report.outcome === 'fail')) throw new Error('Burr exit code and report disagree');
    report.model_path = file;
  } catch (error) {
    report = { model_path: file, outcome: 'incomplete', pair_set_complete: false, findings: [], incomplete_reasons: [{ code: 'check_error', message: error.message }] };
  }
  reports.push(report);
  console.log(`${file}: ${report.outcome}; ${report.findings.length} interference(s), ${(report.unresolved_pairs || []).length} unresolved pair(s)`);
}
const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/\r?\n/g, ' ').replace(/`/g, '&#96;');
const pair = item => item.components.map(c => escape(c.name || c.definition_name || c.id)).join(' ↔ ');
const table = items => ['| Parts | Reason |', '| --- | --- |', ...items.slice(0, 100).map(item => `| ${pair(item)} | ${escape(item.message)} |`), ...(items.length > 100 ? [`\n${items.length - 100} more pairs in the JSON report.`] : [])].join('\n');
let summary = '<!-- burr-action-summary -->\n## Burr assembly checks\n\n';
if (!reports.length) summary += 'No matching STEP/STP assemblies to check.\n';
for (const report of reports) {
  const unresolved = report.unresolved_pairs || [];
  const contacts = report.contact_pairs || [];
  const complete = report.pair_set_complete === true;
  summary += `### ${escape(report.model_path)}\n\n**${report.outcome === 'fail' ? 'Interference found' : complete && report.outcome === 'pass' ? 'Pass' : 'Incomplete — not a pass'}** · ${report.findings.length} interference(s) · ${unresolved.length} unresolved pair(s) · ${contacts.length} contact pair(s)\n\n`;
  if (report.findings.length) summary += table(report.findings) + '\n\n';
  if (unresolved.length) summary += '**Unresolved pairs**\n\n' + table(unresolved) + '\n\n';
  for (const reason of report.incomplete_reasons || []) summary += `- ${escape(reason.code)}: ${escape(reason.message)}\n`;
  if (contacts.length) summary += `\n<details><summary>Contact pairs (${contacts.length})</summary>\n\n${table(contacts)}\n\n</details>\n\n`;
}
const interference = reports.some(r => r.findings.length > 0);
const incomplete = reports.some(r => r.outcome === 'incomplete' || r.pair_set_complete !== true);
const status = interference ? 'interference' : incomplete ? 'incomplete' : 'pass';
const reportPath = path.join(process.env.RUNNER_TEMP, 'burr-reports.json');
fs.writeFileSync(reportPath, JSON.stringify({ status, assemblies: reports }, null, 2));
fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\nreport-path=${reportPath}\n`);
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
