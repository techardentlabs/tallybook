import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_CREATE,
  OPEN_NONE,
  addCompanyEntry,
  companyBootTarget,
  companyEntryLabel,
  companyFileFor,
  companyIdFromFile,
  emptyCompanyIndex,
  isCompanyFile,
  markCompanyOpened,
  migrateCompanyIndex,
  nextCompanyId,
  parseCompanyIndex,
  recentCompanyEntry,
  removeCompanyEntry,
  requestCompanyOpen,
  serializeCompanyIndex,
  sortedCompanyEntries,
  takeCompanyOpenRequest,
  updateCompanyEntry,
  type CompanyIndex,
} from '../src/index.ts';

function two(): CompanyIndex {
  let idx = emptyCompanyIndex();
  idx = addCompanyEntry(idx, { id: '100000', name: 'Zed Traders', file: 'tallybook.db', last_opened: null });
  idx = addCompanyEntry(idx, { id: '100001', name: 'Alpha Co', file: 'companies/100001.db', last_opened: null });
  return idx;
}

test('company files are derived from the number and validated', () => {
  assert.equal(companyFileFor('100001', 'path'), 'companies/100001.db');
  assert.equal(companyFileFor('100001', 'key'), 'company-100001');
  assert.throws(() => companyFileFor('../x', 'path'), /not valid/);
  assert.ok(isCompanyFile('companies/100001.db', 'path', 'tallybook.db'));
  assert.ok(isCompanyFile('tallybook.db', 'path', 'tallybook.db'));
  assert.ok(!isCompanyFile('companies/../evil.db', 'path', 'tallybook.db'));
  assert.ok(!isCompanyFile('/etc/passwd', 'path', 'tallybook.db'));
  assert.ok(isCompanyFile('default', 'key', 'default'));
  assert.ok(isCompanyFile('company-100002', 'key', 'default'));
  assert.ok(!isCompanyFile('companies', 'key', 'default'));
  assert.equal(companyIdFromFile('companies/100007.db'), '100007');
  assert.equal(companyIdFromFile('company-100008'), '100008');
  assert.equal(companyIdFromFile('tallybook.db'), null);
});

test('missing index registers the legacy database as the first company', () => {
  const r = migrateCompanyIndex(null, 'tallybook.db');
  assert.equal(r.changed, true);
  assert.deepEqual(r.index.companies, [{ id: '100000', name: '', file: 'tallybook.db', last_opened: null }]);
  assert.equal(nextCompanyId(r.index), '100001');
  assert.equal(companyEntryLabel(r.index.companies[0]), 'Company 100000');
});

test('fresh install has an empty index and starts with company creation', () => {
  const r = migrateCompanyIndex(null, null);
  assert.equal(r.changed, false);
  assert.equal(r.index.companies.length, 0);
  assert.equal(nextCompanyId(r.index), '100000');
  assert.deepEqual(companyBootTarget(r.index), { kind: 'create' });
});

test('an existing index is kept as is and the legacy file is not re-added', () => {
  const stored = serializeCompanyIndex(two());
  const r = migrateCompanyIndex(stored, 'tallybook.db');
  assert.equal(r.changed, false);
  assert.deepEqual(r.index, two());
  const removed = removeCompanyEntry(two(), '100000');
  const again = migrateCompanyIndex(serializeCompanyIndex(removed), 'tallybook.db');
  assert.deepEqual(again.index.companies.map((c) => c.id), ['100001']);
});

test('a corrupt index is rebuilt from the legacy file and company files on disk', () => {
  const r = migrateCompanyIndex('{not json', 'tallybook.db', ['companies/100003.db', 'companies/100001.db', 'companies/100000.db']);
  assert.equal(r.changed, true);
  assert.deepEqual(
    r.index.companies.map((c) => [c.id, c.file]),
    [
      ['100000', 'tallybook.db'],
      ['100001', 'companies/100001.db'],
      ['100003', 'companies/100003.db'],
      ['100004', 'companies/100000.db'],
    ]
  );
});

test('parse drops invalid and duplicate entries and unknown open requests', () => {
  const idx = parseCompanyIndex({
    version: 1,
    companies: [
      { id: '100000', name: ' A ', file: 'a', last_opened: '2026-01-01T00:00:00Z', fy_start: '2026-04-01', fy_end: 'bad' },
      { id: '100000', name: 'dup', file: 'b' },
      { id: 'x', name: 'bad id', file: 'c' },
      { id: '100002', name: 'same file', file: 'a' },
      { id: '100003', file: 'd' },
      null,
    ],
    open_next: '999',
  });
  assert.ok(idx);
  assert.deepEqual(idx.companies, [
    { id: '100000', name: 'A', file: 'a', last_opened: '2026-01-01T00:00:00Z', fy_start: '2026-04-01' },
    { id: '100003', name: '', file: 'd', last_opened: null },
  ]);
  assert.equal(idx.open_next, null);
  assert.equal(parseCompanyIndex('nope'), null);
  assert.equal(parseCompanyIndex({ companies: 'x' }), null);
});

test('serialize and parse round trip', () => {
  const idx = requestCompanyOpen(two(), '100001');
  assert.deepEqual(parseCompanyIndex(serializeCompanyIndex(idx)), idx);
});

test('add rejects duplicate numbers and files', () => {
  assert.throws(() => addCompanyEntry(two(), { id: '100001', name: 'X', file: 'companies/x.db', last_opened: null }), /already exists/);
  assert.throws(() => addCompanyEntry(two(), { id: '100009', name: 'X', file: 'tallybook.db', last_opened: null }), /already in use/);
  assert.throws(() => addCompanyEntry(two(), { id: 'abc', name: 'X', file: 'y', last_opened: null }), /not valid/);
  assert.equal(nextCompanyId(two()), '100002');
});

test('update syncs name and period and ignores blanks', () => {
  let idx = updateCompanyEntry(two(), '100000', { name: '  Zed Traders Pvt Ltd ', fy_start: '2026-04-01', fy_end: '2027-03-31' });
  idx = updateCompanyEntry(idx, '100000', { name: '', fy_start: 'nope' });
  const e = idx.companies[0];
  assert.equal(e.name, 'Zed Traders Pvt Ltd');
  assert.equal(e.fy_start, '2026-04-01');
  assert.equal(e.fy_end, '2027-03-31');
  assert.throws(() => updateCompanyEntry(idx, '1', { name: 'x' }), /not in list/);
});

test('sorted by name, recent by last opened', () => {
  let idx = two();
  assert.deepEqual(sortedCompanyEntries(idx).map((c) => c.name), ['Alpha Co', 'Zed Traders']);
  assert.equal(recentCompanyEntry(idx), undefined);
  idx = markCompanyOpened(idx, '100000', '2026-02-01T00:00:00Z');
  idx = markCompanyOpened(idx, '100001', '2026-01-01T00:00:00Z');
  assert.equal(recentCompanyEntry(idx)?.id, '100000');
  assert.throws(() => markCompanyOpened(idx, 'zz'), /not in list/);
});

test('boot target: one company opens directly, several show the list', () => {
  const one = removeCompanyEntry(two(), '100001');
  assert.deepEqual(companyBootTarget(one), { kind: 'open', id: '100000' });
  assert.deepEqual(companyBootTarget(two()), { kind: 'select' });
  assert.deepEqual(companyBootTarget(two(), '100001'), { kind: 'open', id: '100001' });
  assert.deepEqual(companyBootTarget(two(), 'gone'), { kind: 'select' });
  assert.deepEqual(companyBootTarget(one, OPEN_NONE), { kind: 'select' });
  assert.deepEqual(companyBootTarget(two(), OPEN_CREATE), { kind: 'create' });
  assert.deepEqual(companyBootTarget(emptyCompanyIndex(), OPEN_NONE), { kind: 'create' });
});

test('open requests are one-shot', () => {
  const idx = requestCompanyOpen(two(), '100001');
  assert.equal(idx.open_next, '100001');
  const t = takeCompanyOpenRequest(idx);
  assert.equal(t.request, '100001');
  assert.equal(t.index.open_next, null);
  assert.equal(takeCompanyOpenRequest(t.index).request, null);
  assert.equal(requestCompanyOpen(two(), OPEN_CREATE).open_next, OPEN_CREATE);
  assert.throws(() => requestCompanyOpen(two(), '42'), /not in list/);
  assert.equal(removeCompanyEntry(idx, '100001').open_next, null);
});
