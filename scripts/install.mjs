import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

let version = process.env.BURR_VERSION;
const output = (key, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
if (process.argv[2] === 'resolve') {
  if (version === 'latest') {
    const response = await fetch('https://api.github.com/repos/fraylabs/burr/releases/latest', {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'User-Agent': 'burr-action' },
    });
    if (!response.ok) throw new Error(`Release lookup failed: ${response.status}`);
    version = (await response.json()).tag_name.replace(/^burr-v/, '');
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version must be x.y.z or latest');
  output('version', version);
  output('directory', path.join(process.env.RUNNER_TOOL_CACHE, 'burr', version, `${os.platform()}-${os.arch()}`));
} else {
  const directory = process.env.BURR_DIRECTORY;
  const binary = path.join(directory, 'burr');
  if (!fs.existsSync(binary)) {
    const target = { 'linux-x64': 'x86_64-unknown-linux-gnu', 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin' }[`${os.platform()}-${os.arch()}`];
    if (!target) throw new Error('Burr supports Linux x64 and macOS x64/arm64 runners');
    const name = `burr-${target}.tar.gz`;
    const base = `https://github.com/fraylabs/burr/releases/download/burr-v${version}/${name}`;
    const download = async url => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
      return Buffer.from(await response.arrayBuffer());
    };
    const archive = await download(base);
    const checksum = (await download(`${base}.sha256`)).toString().trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(checksum) || crypto.createHash('sha256').update(archive).digest('hex') !== checksum) throw new Error('Burr archive checksum mismatch');
    fs.mkdirSync(directory, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'burr-download-'));
    try {
      const file = path.join(temporary, name);
      fs.writeFileSync(file, archive);
      execFileSync('tar', ['-xzf', file, '-C', directory, 'burr', 'LICENSE']);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  const installed = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  if (installed !== version) throw new Error(`Expected Burr ${version}, found ${installed}`);
  console.log(`Burr ${installed} ready`);
}
