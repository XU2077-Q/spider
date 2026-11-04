const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILES = [
  'vitals.json', 'memory.json', 'learning.json', 'habits.json',
  'reflection.json', 'reminders.json', 'todos.json', 'work-buddy.json',
];
const CONFIRM_PHRASE = '删除喵伴';

function normalized(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function samePath(a, b) {
  return normalized(path.resolve(a)) === normalized(path.resolve(b));
}

function isInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function validDateName(name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(name);
  if (!match) return false;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === `${match[1]}-${match[2]}-${match[3]}`;
}

function validateAppRoot(appRoot, protectedPaths = []) {
  if (typeof appRoot !== 'string' || !path.isAbsolute(appRoot) || appRoot.includes('\0')) {
    throw new Error('应用目录无效');
  }
  if (appRoot.startsWith('\\\\') || appRoot.startsWith('\\\\?\\') || appRoot.slice(2).includes(':')) {
    throw new Error('拒绝 UNC、设备路径或备用数据流');
  }
  const root = path.resolve(appRoot);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('应用目录不能是链接');
  const real = fs.realpathSync(root);
  if (!samePath(real, root)) throw new Error('应用目录的真实路径不一致');
  if (samePath(root, path.parse(root).root)) throw new Error('不能移除磁盘根目录');
  if (path.basename(root).toLowerCase() !== 'spider-main') {
    throw new Error('目录名称不是 spider-main，已停止操作');
  }
  const automaticProtected = [
    process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA,
    process.env.TEMP, process.env.SystemRoot, process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ].filter(Boolean);
  for (const protectedPath of [...automaticProtected, ...protectedPaths]) {
    if (protectedPath && samePath(root, protectedPath)) throw new Error('拒绝移除受保护目录');
  }
  const packagePath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (pkg.name !== 'spider' || pkg.main !== 'main.js') throw new Error('Spider 应用标识不匹配');
  for (const required of ['main.js', 'preload.js', 'renderer', 'assets']) {
    if (!fs.existsSync(path.join(root, required))) throw new Error('Spider 应用文件不完整');
  }
  return real;
}

function copyRegularFile(source, destination) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`跳过不安全的数据文件：${path.basename(source)}`);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function exportUserData({ appRoot, destinationParent, now = () => new Date(), id = () => crypto.randomUUID() }) {
  const root = validateAppRoot(appRoot);
  if (typeof destinationParent !== 'string' || !path.isAbsolute(destinationParent)) throw new Error('备份位置无效');
  const parent = fs.realpathSync(destinationParent);
  if (isInside(root, parent)) throw new Error('备份必须保存在 Spider 文件夹之外');
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(parent, `Spider-backup-${stamp}-${id().slice(0, 8)}`);
  fs.mkdirSync(backupPath, { recursive: false });
  const exported = [];
  const dataDir = path.join(root, 'data');
  for (const name of DATA_FILES) {
    const source = path.join(dataDir, name);
    if (!fs.existsSync(source)) continue;
    copyRegularFile(source, path.join(backupPath, name));
    exported.push(name);
  }
  const diaryDir = path.join(dataDir, 'diary');
  if (fs.existsSync(diaryDir)) {
    const diaryBackup = path.join(backupPath, 'diary');
    fs.mkdirSync(diaryBackup);
    for (const name of fs.readdirSync(diaryDir)) {
      if (!validDateName(name)) continue;
      copyRegularFile(path.join(diaryDir, name), path.join(diaryBackup, name));
      exported.push(`diary/${name}`);
    }
  }
  fs.writeFileSync(path.join(backupPath, 'backup-manifest.json'), JSON.stringify({
    product: '喵伴 Spider', createdAt: now().toISOString(), files: exported,
    credentialsIncluded: false,
  }, null, 2), { flag: 'wx' });
  return { backupPath, exported };
}

// 固定命令：路径只从主进程设置的环境变量读取，不与任何用户文本拼接。
const RECYCLER_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$targetPid = [int]$env:SPIDER_UNINSTALL_PID
while (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }
$root = [IO.Path]::GetFullPath($env:SPIDER_UNINSTALL_ROOT)
if ([IO.Path]::GetFileName($root.TrimEnd('\')) -cne 'spider-main') { throw 'Unexpected folder name' }
if ([IO.Path]::GetPathRoot($root).TrimEnd('\') -eq $root.TrimEnd('\')) { throw 'Root folder refused' }
$package = Join-Path $root 'package.json'
if (!(Test-Path -LiteralPath $package -PathType Leaf)) { throw 'Spider marker missing' }
$manifest = Get-Content -LiteralPath $package -Raw | ConvertFrom-Json
if ($manifest.name -cne 'spider' -or $manifest.main -cne 'main.js') { throw 'Spider marker mismatch' }
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($root, 'OnlyErrorDialogs', 'SendToRecycleBin')
`;

function spawnRecycler({ appRoot, pid = process.pid, spawn, powerShellPath = 'powershell.exe' }) {
  const root = validateAppRoot(appRoot);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('进程号无效');
  if (typeof spawn !== 'function') throw new Error('缺少回收站辅助进程');
  const child = spawn(powerShellPath, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', RECYCLER_COMMAND,
  ], {
    detached: true, stdio: 'ignore', windowsHide: true, shell: false,
    env: { ...process.env, SPIDER_UNINSTALL_ROOT: root, SPIDER_UNINSTALL_PID: String(pid) },
  });
  if (!child || typeof child.unref !== 'function') throw new Error('回收站辅助进程启动失败');
  child.unref();
  return { root, command: RECYCLER_COMMAND };
}

module.exports = {
  CONFIRM_PHRASE, DATA_FILES, RECYCLER_COMMAND,
  validateAppRoot, exportUserData, spawnRecycler, isInside, validDateName,
};
