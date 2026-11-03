import { readFileSync, writeFileSync } from 'node:fs';

const files = {
  json: ['package.json', 'packages/core/package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json'],
  cargo: 'apps/desktop/src-tauri/Cargo.toml',
};
const current = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8')).version;
const arg = process.argv[2];
if (!arg) {
  console.log(current);
  process.exit(0);
}
const [maj, min, pat] = current.split('-')[0].split('.').map(Number);
const next =
  arg === 'major' ? `${maj + 1}.0.0` : arg === 'minor' ? `${maj}.${min + 1}.0` : arg === 'patch' ? `${maj}.${min}.${pat + 1}` : arg;
if (!/^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/.test(next)) {
  console.error(`Not a valid version: ${next}`);
  process.exit(1);
}
for (const f of files.json) {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  j.version = next;
  writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
writeFileSync(files.cargo, readFileSync(files.cargo, 'utf8').replace(/^version = ".*"$/m, `version = "${next}"`));
const log = readFileSync('CHANGELOG.md', 'utf8');
if (!log.includes(`## [${next}]`)) {
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync('CHANGELOG.md', log.replace('## [Unreleased]', `## [Unreleased]\n\n## [${next}] - ${date}`));
}
console.log(`${current} -> ${next}`);
