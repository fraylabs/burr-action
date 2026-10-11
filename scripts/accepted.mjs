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
const selectorKey = selector => typeof selector === 'string' ? JSON.stringify({ name: selector }) :
  JSON.stringify(Object.fromEntries(Object.entries(selector).sort(([a], [b]) => a.localeCompare(b))));
const key = (assembly, parts) => JSON.stringify([assembly, parts.map(selectorKey).sort()]);
export const selectorLabel = selector => typeof selector === 'string' ? selector :
  [selector.name, selector['occurrence-name'], selector['occurrence-path']].filter(Boolean).join(' / ');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const generated = component => component.name !== partName(component) || /^occurrence:\d+$/.test(component.name || component.id || '');
const occurrenceName = component => {
  const explicit = component.occurrence_name || component.instance_name;
  if (explicit && !(explicit === component.name && generated(component))) return explicit;
  return !generated(component) ? component.name : undefined;
};
const occurrencePath = component => component.occurrence_path || component.instance_path;
const matches = (selector, component) => {
  if (typeof selector === 'string') return selector === partName(component);
  return (!selector.name || selector.name === partName(component)) &&
    (!selector['occurrence-name'] || selector['occurrence-name'] === occurrenceName(component)) &&
    (!selector['occurrence-path'] || (component.identity_stable !== false && selector['occurrence-path'] === occurrencePath(component)));
};
const pairMatches = (selectors, components) => components.length === 2 &&
  ((matches(selectors[0], components[0]) && matches(selectors[1], components[1])) ||
   (matches(selectors[0], components[1]) && matches(selectors[1], components[0])));
function inventory(report) {
  const components = new Map();
  for (const component of report.components || []) components.set(component.id ?? component.occurrence_index, component);
  for (const pair of [...report.findings, ...(report.contact_pairs || []), ...(report.unresolved_pairs || [])])
    for (const component of pair.components) components.set(component.id ?? component.occurrence_index, component);
  return { components: [...components.values()], complete: components.size === report.component_count };
}
function safety(parts, report, matchCount) {
  const known = inventory(report);
  if (matchCount > 1) return `entry lists one pair but matched ${matchCount}; ambiguous selectors; no findings accepted`;
  if (!known.complete) return 'complete part-name inventory unavailable; uniqueness not proven; no findings accepted';
  if (parts.some(selector => known.components.some(c => matches(selector, c) && c.identity_stable === false)))
    return 'source occurrence identity is unstable; no findings accepted';
  if (parts.some(selector => known.components.some(c => matches(selector, c) &&
      (!nonempty(partName(c)) || /^occurrence:\d+$/.test(partName(c))))))
    return 'only occurrence indices available, not stable names; no findings accepted';
  if (parts.some(selector => known.components.filter(c => matches(selector, c)).length !== 1))
    return 'part names/selectors are not unique in this assembly; no findings accepted';
  return null;
}
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
    if (!Array.isArray(entry.parts) || entry.parts.length !== 2) error('parts must contain exactly two selectors');
    for (const selector of entry.parts) {
      if (typeof selector === 'string') { if (!nonempty(selector)) error('empty part name'); continue; }
      if (!selector || typeof selector !== 'object' || Array.isArray(selector) || !Object.keys(selector).length ||
          Object.keys(selector).some(field => !['name', 'occurrence-name', 'occurrence-path'].includes(field)) ||
          Object.values(selector).some(value => !nonempty(value))) error('invalid part selector');
    }
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
  for (const report of reports) {
    report.accepted_fits = [];
    report.unaccepted_findings = [];
    report.accepted_entry_matches = entries.filter(entry => entry.assembly === report.model_path).map(entry => {
      const count = report.findings.filter(finding => pairMatches(entry.parts, finding.components)).length;
      entry.matched ||= count > 0;
      return { parts: entry.parts, reason: entry.reason, matched_pairs: count, listed_pairs: 1,
        warning: count ? safety(entry.parts, report, count) : null };
    });
    for (const finding of report.findings) {
      const matching = report.accepted_entry_matches.filter(entry => pairMatches(entry.parts, finding.components));
      if (matching.length > 1) for (const entry of matching) entry.warning = 'multiple policy entries match this finding; no findings accepted';
    }
    for (const finding of report.findings) {
      const policies = report.accepted_entry_matches.filter(entry => pairMatches(entry.parts, finding.components));
      if (policies.length !== 1 || policies[0].warning) { report.unaccepted_findings.push(finding); continue; }
      const entry = entries.find(e => e.assembly === report.model_path && pairMatches(e.parts, finding.components));
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
  const omitted = [];
  for (const report of reports) for (const finding of report.findings) {
    const parts = finding.components.map(component => {
      if (component.identity_stable === true && nonempty(occurrencePath(component))) return { 'occurrence-path': occurrencePath(component) };
      if (component.identity_stable === undefined && nonempty(occurrencePath(component))) return { name: partName(component), 'occurrence-path': occurrencePath(component) };
      if (nonempty(occurrenceName(component))) return { name: partName(component), 'occurrence-name': occurrenceName(component) };
      return partName(component);
    });
    const count = report.findings.filter(pair => pairMatches(parts, pair.components)).length;
    const warning = safety(parts, report, count);
    if (warning) { omitted.push(`${report.model_path}: ${finding.components.map(partName).join(' ↔ ')}: ${warning}`); continue; }
    const matchKey = key(report.model_path, parts);
    const volume = finding.overlap_volume_mm3;
    const measured = typeof volume === 'number' && Number.isFinite(volume) && volume >= 0;
    const existing = entries.get(matchKey);
    if (!existing) entries.set(matchKey, { assembly: report.model_path, parts,
      ...(measured ? { 'max-overlap-mm3': volume } : {}), reason: 'REVIEW REQUIRED: explain why this overlap is intended' });
    else if (measured) existing['max-overlap-mm3'] = Math.max(existing['max-overlap-mm3'] ?? 0, volume);
  }
  return '# Draft only. Review every pair and replace every reason before committing.\n' +
    '# Only uniquely selectable pairs are emitted. No CI acceptance is changed.\n' +
    omitted.map(message => '# Omitted ambiguous pair: ' + message.replace(/[\r\n]/g, ' ')).join('\n') + (omitted.length ? '\n' : '') +
    stringify([...entries.values()]);
}
