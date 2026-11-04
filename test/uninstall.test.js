const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CONFIRM_PHRASE, RECYCLER_COMMAND, validateAppRoot,
  exportUserData, spawnRecycler, validDateName,
} = require('../agent/uninstall');

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-uninstall-test-'));
  const root = path.join(parent, 'spider-main');
  fs.mkdirSync(path.join(root, 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'data', 'diary'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'spider', main: 'main.js' }));
  fs.writeFileSync(path.join(root, 'main.js'), '// test');
  fs.writeFileSync(path.join(root, 'preload.js'), '// test');
  return { parent, root };
}

test('validates only an identified Spider application directory', () => {
  const { root, parent } = fixture();
  assert.equal(validateAppRoot(root), fs.realpathSync(root));
  assert.throws(() => validateAppRoot(parent), /spider-main/);
  assert.throws(() => validateAppRoot(path.parse(root).root), /无效|根目录|spider-main/);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'other', main: 'main.js' }));
  assert.throws(() => validateAppRoot(root), /标识不匹配/);
});

test('exports allowlisted data and dated diaries without credentials', () => {
  const { root, parent } = fixture();
  fs.writeFileSync(path.join(root, 'data', 'vitals.json'), '{"energy":85}');
  fs.writeFileSync(path.join(root, 'data', 'unknown.txt'), 'keep out of export');
  fs.writeFileSync(path.join(root, 'data', 'diary', '2026-11-04.md'), '# demo');
  fs.writeFileSync(path.join(root, 'data', 'diary', 'notes.md'), 'not exported');
  fs.writeFileSync(path.join(root, 'config.local.json'), '{"apiKey":"secret"}');
  const result = exportUserData({
    appRoot: root, destinationParent: parent,
    now: () => new Date('2026-11-04T01:02:03Z'), id: () => '12345678-test',
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backupPath, 'vitals.json'))).energy, 85);
  assert.equal(fs.readFileSync(path.join(result.backupPath, 'diary', '2026-11-04.md'), 'utf8'), '# demo');
  assert.equal(fs.existsSync(path.join(result.backupPath, 'config.local.json')), false);
  assert.equal(fs.existsSync(path.join(result.backupPath, 'unknown.txt')), false);
  assert.equal(fs.existsSync(path.join(result.backupPath, 'diary', 'notes.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'vitals.json')), true);
});

test('backup cannot be placed inside the application directory', () => {
  const { root } = fixture();
  assert.throws(() => exportUserData({ appRoot: root, destinationParent: root }), /之外/);
});

test('recycler is dry-run testable and never interpolates the root into commands', () => {
  const { root } = fixture();
  let call;
  const child = { unref() { this.detached = true; } };
  const result = spawnRecycler({
    appRoot: root, pid: 1234,
    spawn(...args) { call = args; return child; },
  });
  assert.equal(result.root, fs.realpathSync(root));
  assert.equal(call[1].includes('-ExecutionPolicy'), false);
  assert.equal(call[1].includes('-File'), false);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].detached, true);
  assert.equal(call[2].env.SPIDER_UNINSTALL_ROOT, fs.realpathSync(root));
  assert.equal(call[2].env.SPIDER_UNINSTALL_PID, '1234');
  assert.equal(RECYCLER_COMMAND.includes(root), false);
  assert.match(RECYCLER_COMMAND, /SendToRecycleBin/);
  assert.doesNotMatch(RECYCLER_COMMAND, /rmdir|Remove-Item|DeleteDirectory\([^)]*DeletePermanently/);
  assert.equal(child.detached, true);
});

test('calendar names and confirmation phrase are strict', () => {
  assert.equal(CONFIRM_PHRASE, '删除喵伴');
  assert.equal(validDateName('2026-11-04.md'), true);
  assert.equal(validDateName('2026-02-30.md'), false);
  assert.equal(validDateName('../secret.md'), false);
});
