import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, stringify } from 'yaml';

// Burr appends " #N" to repeated definitions. Keep authored suffixes intact.
export const partName = component => {
  const name = component.name || component.definition_name || component.id;
  const definition = component.definition_name;
  return definition && name.startsWith(`${definition} #`) && /^\d+$/.test(name.slice(definition.length + 2))
    ? definition : name;
};
const key = (assembly, parts) => JSON.stringify([assembly, [...parts].sort()]);
const relativeFile = value => typeof value === 'string' && value.length > 0 &&
  !value.includes('\\') && !path.posix.isAbsolute(value) &&
  value.split('/').every(segment => segment && segment !== '.' && segment !== '..');

export function readAccepted(workspace, filename) {
  if (!relativeFile(filename)) throw new Error('accepted-fits must be a relative file path inside the checkout');
  const location = path.join(workspace, filename);
  if (!fs.existsSync(location)) return [];
  const resolved = fs.realpathSync(location);
  if (!resolved.startsWith(workspace + path.sep) || !fs.statSync(resolved).isFile())
    throw new Error('accepted-fits must be a file inside the checkout');
  if (fs.statSync(resolved).size > 1024 * 1024) throw new Error('accepted-fits exceeds 1 MiB');
  const document = parseDocument(fs.readFileSync(resolved, 'utf8'), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid accepted-fits YAML: ${document.errors[0].message}`);
  const entries = document.toJS({ maxAliasCount: 0 });
  if (!Array.isArray(entries)) throw new Error('accepted-fits must contain a YAML list');
  const seen = new Set();
  return entries.map((entry, index) => {
    const error = message => { throw new Error(`accepted-fits entry ${index + 1}: ${message}`); };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) error('expected an entry');
    if (Object.keys(entry).some(field => !['assembly', 'parts', 'max-overlap-mm3', 'reason'].includes(field))) error('unknown field');
    if (!relativeFile(entry.assembly)) error('assembly must be a relative checkout path');
    if (!Array.isArray(entry.parts) || entry.parts.length !== 2 || entry.parts.some(p => typeof p !== 'string' || !p.trim())) error('parts must contain exactly two nonempty Burr part names');
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) error('reason is required');
    if (entry.reason.startsWith('REVIEW REQUIRED:')) error('replace the draft reason after reviewing the fit');
    const maximum = entry['max-overlap-mm3'];
    if (maximum !== undefined && (typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum < 0)) error('max-overlap-mm3 must be a finite nonnegative number');
    const matchKey = key(entry.assembly, entry.parts);
    if (seen.has(matchKey)) error('duplicate assembly and part pair');
    seen.add(matchKey);
    return { ...entry, matchKey, matched: false };
  });
}

export function classifyAccepted(reports, entries) {
  const lookup = new Map(entries.map(entry => [entry.matchKey, entry]));
  for (const report of reports) {
    report.accepted_fits = [];
    report.unaccepted_findings = [];
    for (const finding of report.findings) {
      const entry = lookup.get(key(report.model_path, finding.components.map(partName)));
      if (!entry) { report.unaccepted_findings.push(finding); continue; }
      entry.matched = true;
      const volume = finding.overlap_volume_mm3;
      const measured = typeof volume === 'number' && Number.isFinite(volume) && volume >= 0;
      const maximum = entry['max-overlap-mm3'];
      if (measured && maximum !== undefined && volume > maximum) {
        report.unaccepted_findings.push({ ...finding, message: `${finding.message} Accepted fit grew: ${volume} mm³ exceeds ${maximum} mm³.`, accepted_fit_grew: true });
      } else {
        report.accepted_fits.push({ ...finding, accepted_reason: entry.reason,
          acceptance: measured ? 'accepted by the repo' : 'accepted by the repo, not measured',
          ...(maximum !== undefined ? { max_overlap_mm3: maximum, volume_limit_enforced: measured } : {}) });
      }
    }
  }
  return entries.filter(entry => !entry.matched).map(({ matchKey, matched, ...entry }) => entry);
}

export function acceptedDraft(reports) {
  const entries = new Map();
  for (const report of reports) for (const finding of report.findings) {
    const parts = finding.components.map(partName).sort();
    const matchKey = key(report.model_path, parts);
    const volume = finding.overlap_volume_mm3;
    const measured = typeof volume === 'number' && Number.isFinite(volume) && volume >= 0;
    const existing = entries.get(matchKey);
    if (!existing) entries.set(matchKey, { assembly: report.model_path, parts,
      ...(measured ? { 'max-overlap-mm3': volume } : {}), reason: 'REVIEW REQUIRED: explain why this overlap is intended' });
    else if (measured) existing['max-overlap-mm3'] = Math.max(existing['max-overlap-mm3'] ?? 0, volume);
  }
  return '# Draft only. Review every pair and replace every reason before committing.\n' +
    '# Repeated occurrences of these part names share this policy. No CI acceptance is changed.\n' +
    stringify([...entries.values()]);
}
