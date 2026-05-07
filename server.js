import express from 'express';
import dns from 'dns';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import cors from 'cors';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_FILE_NAMES = ['.env.local', '.env'];

loadProjectEnvFiles();
setPreferredDnsResultOrder();

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const CONFIG_PATH = path.join(__dirname, 'mainline-tool.config.json');
const DEFAULT_CONFIG = {
  sourceDir: '/home/wsl/Work_space/MTK_V/mainline_v_2025_oct_14238457',
  projectDir: '/home/wsl/Work_space/MTK_V/alps-release-v0.mp1.rc-default/alps',
  noteProjectKey: '',
  noteProjectKeys: [],
  manualStatuses: {},
};
const GMS_PATTERN = /(\/\/\[GMS\]\[\d+\]|begin-->|redmine|Redmine|end-->|\[GMS\])/;
const TEXT_EXTENSIONS = new Set([
  '.xml', '.txt', '.prop', '.mk', '.bp', '.csv', '.json', '.conf', '.cfg', '.ini',
  '.list', '.rc', '.md', '.java', '.kt', '.kts', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.gradle', '.proto', '.aidl', '.sh', '.yml',
  '.yaml', '.go', '.rs', '.s', '.asm', '.mf', '.pem', '.crt', '.cer', '.key'
]);
const BINARY_EXTENSIONS = new Set(['.apk', '.apex', '.jar', '.so', '.bin', '.img', '.dat', '.o', '.a']);
const ARCHIVE_PREVIEW_EXTENSIONS = new Set(['.apk', '.apks', '.apex', '.jar', '.srcjar']);
const PREVIEW_LIMIT = 5000;
const COMMAND_BUFFER_LIMIT = 1024 * 1024 * 100;
const BINARY_DUMP_BYTE_LIMIT = 64 * 1024;
const NOTE_DB_URL = (
  process.env.SUPABASE_SESSION_POOL_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.DATABASE_URL ||
  ''
).trim();
const NOTE_TABLE_NAME = 'header_notes';
const NOTE_CONTENT_MAX_LENGTH = 20000;

let notesDbPool = null;
let notesTableReady = false;
let notesTableReadyPromise = null;

function setPreferredDnsResultOrder() {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
}

function loadProjectEnvFiles() {
  ENV_FILE_NAMES.forEach((fileName) => {
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath)) {
      return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) {
        return;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (!key || process.env[key] !== undefined) {
        return;
      }

      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    });
  });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeJsonSync(CONFIG_PATH, DEFAULT_CONFIG, { spaces: 2 });
    return { ...DEFAULT_CONFIG };
  }

  const fileConfig = fs.readJsonSync(CONFIG_PATH);
  const noteProjectKey = typeof fileConfig.noteProjectKey === 'string' ? fileConfig.noteProjectKey.trim() : DEFAULT_CONFIG.noteProjectKey;
  const noteProjectKeys = normalizeNoteProjectKeys(fileConfig.noteProjectKeys, noteProjectKey);
  return {
    sourceDir: fileConfig.sourceDir || DEFAULT_CONFIG.sourceDir,
    projectDir: fileConfig.projectDir || DEFAULT_CONFIG.projectDir,
    noteProjectKey,
    noteProjectKeys,
    manualStatuses: fileConfig.manualStatuses || {},
  };
}

function saveConfig(config) {
  fs.writeJsonSync(CONFIG_PATH, config, { spaces: 2 });
}

function normalizeNoteProjectKeys(rawKeys = [], selectedKey = '') {
  const candidateKeys = Array.isArray(rawKeys) ? rawKeys : [];
  const normalized = candidateKeys
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);

  if (typeof selectedKey === 'string' && selectedKey.trim()) {
    normalized.unshift(selectedKey.trim());
  }

  return Array.from(new Set(normalized));
}

function getNextNoteTypeConfig(currentConfig, selectedKey) {
  const noteProjectKeys = normalizeNoteProjectKeys(currentConfig.noteProjectKeys, selectedKey);
  const nextSelectedKey = selectedKey && noteProjectKeys.includes(selectedKey)
    ? selectedKey
    : (noteProjectKeys[0] || '');

  return {
    ...currentConfig,
    noteProjectKey: nextSelectedKey,
    noteProjectKeys,
  };
}

function hasNoteDatabaseConfig() {
  return NOTE_DB_URL.length > 0;
}

function getDatabaseHostname(connectionString = '') {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return '';
  }
}

function isSupabaseDirectDatabaseHost(hostname = '') {
  return /^db\.[a-z0-9-]+\.supabase\.co$/i.test(hostname);
}

function getSessionPoolerGuidance() {
  return '当前网络不适合使用 Supabase 直连地址，请改用 Supabase Dashboard -> Connect -> Session pooler 里的连接串，并配置到 SUPABASE_SESSION_POOL_URL 或 SUPABASE_DB_URL。';
}

function toReadableDatabaseError(err) {
  const message = err?.message || '数据库连接失败';
  const hostname = getDatabaseHostname(NOTE_DB_URL);

  if (
    isSupabaseDirectDatabaseHost(hostname) &&
    (
      err?.code === 'ENETUNREACH' ||
      err?.code === 'EHOSTUNREACH' ||
      err?.code === 'ETIMEDOUT' ||
      message.includes('ENETUNREACH')
    )
  ) {
    return `${getSessionPoolerGuidance()} 当前配置主机: ${hostname}`;
  }

  return message;
}

function shouldUseDatabaseSsl(connectionString = '') {
  return /supabase\./i.test(connectionString) || /sslmode=require/i.test(connectionString);
}

function getNotesDbPool() {
  if (!hasNoteDatabaseConfig()) {
    throw new Error('未配置备注数据库连接，请设置 SUPABASE_SESSION_POOL_URL、SUPABASE_DB_URL 或 DATABASE_URL');
  }

  if (!notesDbPool) {
    notesDbPool = new Pool({
      connectionString: NOTE_DB_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      ssl: shouldUseDatabaseSsl(NOTE_DB_URL) ? { rejectUnauthorized: false } : undefined,
    });
  }

  return notesDbPool;
}

async function ensureNotesTable() {
  const pool = getNotesDbPool();
  if (notesTableReady) {
    return pool;
  }

  if (!notesTableReadyPromise) {
    notesTableReadyPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${NOTE_TABLE_NAME} (
            id BIGSERIAL PRIMARY KEY,
            project_key TEXT UNIQUE,
            source_dir TEXT NOT NULL,
            project_dir TEXT NOT NULL,
            note_content TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`
          ALTER TABLE ${NOTE_TABLE_NAME}
          ADD COLUMN IF NOT EXISTS project_key TEXT
        `);
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_${NOTE_TABLE_NAME}_project_key
          ON ${NOTE_TABLE_NAME} (project_key)
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_${NOTE_TABLE_NAME}_source_project
          ON ${NOTE_TABLE_NAME} (source_dir, project_dir)
        `);
      } finally {
        client.release();
      }

      notesTableReady = true;
      return pool;
    })().catch((err) => {
      notesTableReadyPromise = null;
      throw err;
    });
  }

  return notesTableReadyPromise;
}

async function withNotesDbSession(callback) {
  const pool = await ensureNotesTable();
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

function resolveNoteScope(input = {}) {
  const config = loadConfig();
  const projectKey = typeof input.projectKey === 'string' && input.projectKey.trim()
    ? input.projectKey.trim()
    : (config.noteProjectKey || '').trim();
  const sourceDir = typeof input.sourceDir === 'string' && input.sourceDir.trim()
    ? input.sourceDir.trim()
    : config.sourceDir;
  const projectDir = typeof input.projectDir === 'string' && input.projectDir.trim()
    ? input.projectDir.trim()
    : config.projectDir;

  if (!projectKey) {
    throw new Error('请先选择备注类型（noteProjectKey）');
  }

  if (!sourceDir || !projectDir) {
    throw new Error('备注关联的资源包路径和项目路径不能为空');
  }

  return { projectKey, sourceDir, projectDir };
}

function validateNoteContent(noteContent) {
  if (typeof noteContent !== 'string') {
    return 'noteContent 必须是字符串';
  }

  if (noteContent.length > NOTE_CONTENT_MAX_LENGTH) {
    return `备注内容不能超过 ${NOTE_CONTENT_MAX_LENGTH} 个字符`;
  }

  return null;
}

function validateNoteProjectKey(projectKey) {
  if (typeof projectKey !== 'string') {
    return 'projectKey 必须是字符串';
  }

  const trimmedProjectKey = projectKey.trim();
  if (!trimmedProjectKey) {
    return '备注类型不能为空';
  }

  if (trimmedProjectKey.length > 120) {
    return '备注类型长度不能超过 120 个字符';
  }

  return null;
}

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  });

  return arrayOfFiles;
}

function readFileHead(filePath, maxBytes = 2048) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function isSourceArchive(ext) {
  return ext === '.srcjar';
}

function isArchivePreviewExt(ext) {
  return ARCHIVE_PREVIEW_EXTENSIONS.has(ext);
}

function isTextFile(filePath, ext) {
  if (isSourceArchive(ext)) {
    return true;
  }

  if (BINARY_EXTENSIONS.has(ext)) {
    return false;
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return true;
  }

  const head = readFileHead(filePath);
  if (head.includes(0)) {
    return false;
  }

  let suspiciousBytes = 0;
  for (const byte of head) {
    const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
    if (isControl) {
      suspiciousBytes += 1;
    }
  }

  return head.length === 0 || suspiciousBytes / head.length < 0.05;
}

function areFilesIdentical(sourcePath, targetPath) {
  const sourceStat = fs.statSync(sourcePath);
  const targetStat = fs.statSync(targetPath);

  if (sourceStat.size !== targetStat.size) {
    return false;
  }

  const sourceBuffer = fs.readFileSync(sourcePath);
  const targetBuffer = fs.readFileSync(targetPath);
  return sourceBuffer.equals(targetBuffer);
}

function validateRelativePath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    return '缺少文件路径';
  }

  if (relativePath.includes('..') || path.isAbsolute(relativePath)) {
    return '非法文件路径';
  }

  return null;
}


function getGitRepoRoot(dirPath) {
  return execFileSync('git', ['-C', dirPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    maxBuffer: COMMAND_BUFFER_LIMIT,
  }).trim();
}

function getGitRemoteUrl(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      maxBuffer: COMMAND_BUFFER_LIMIT,
    }).trim();
  } catch {
    return '';
  }
}

function getFileGitHistory(projectDir, relativePath) {
  const repoRoot = getGitRepoRoot(projectDir);
  const absoluteFilePath = path.join(projectDir, relativePath);
  const repoRelativePath = path.relative(repoRoot, absoluteFilePath);

  if (!repoRelativePath || repoRelativePath.startsWith('..')) {
    throw new Error('当前项目路径不在 Git 仓库内');
  }

  const output = execFileSync(
    'git',
    [
      '-C',
      repoRoot,
      'log',
      '--follow',
      '--date=iso-strict',
      '--format=%H%x1f%an%x1f%ad%x1f%s',
      '--',
      repoRelativePath,
    ],
    {
      encoding: 'utf8',
      maxBuffer: COMMAND_BUFFER_LIMIT,
    }
  );

  const commits = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, subject] = line.split('\x1f');
      return {
        hash,
        shortHash: hash.slice(0, 10),
        author,
        date,
        subject,
      };
    });

  return {
    repoRoot,
    repoRelativePath,
    remoteUrl: getGitRemoteUrl(repoRoot),
    commits,
  };
}

function validateCommitHash(commitHash) {
  return typeof commitHash === 'string' && /^[0-9a-f]{7,40}$/i.test(commitHash);
}

function getFileGitCommitDetail(projectDir, relativePath, commitHash) {
  if (!validateCommitHash(commitHash)) {
    throw new Error('非法提交哈希');
  }

  const repoRoot = getGitRepoRoot(projectDir);
  const absoluteFilePath = path.join(projectDir, relativePath);
  const repoRelativePath = path.relative(repoRoot, absoluteFilePath);

  if (!repoRelativePath || repoRelativePath.startsWith('..')) {
    throw new Error('当前项目路径不在 Git 仓库内');
  }

  const metaOutput = execFileSync(
    'git',
    [
      '-C',
      repoRoot,
      'show',
      '--no-patch',
      '--date=iso-strict',
      '--format=%H%x1f%an%x1f%ad%x1f%s%x1f%b',
      commitHash,
    ],
    {
      encoding: 'utf8',
      maxBuffer: COMMAND_BUFFER_LIMIT,
    }
  ).trim();

  const [hash, author, date, subject, body = ''] = metaOutput.split('\x1f');
  const patch = execFileSync(
    'git',
    [
      '-C',
      repoRoot,
      'show',
      '--stat',
      '--patch',
      '--unified=3',
      '--format=',
      commitHash,
      '--',
      repoRelativePath,
    ],
    {
      encoding: 'utf8',
      maxBuffer: COMMAND_BUFFER_LIMIT,
    }
  );

  return {
    hash,
    shortHash: hash.slice(0, 10),
    author,
    date,
    subject,
    body: body.trim(),
    repoRelativePath,
    patch,
  };
}

function listArchiveEntries(filePath) {
  const output = execFileSync('unzip', ['-Z1', filePath], {
    encoding: 'utf8',
    maxBuffer: COMMAND_BUFFER_LIMIT,
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/'));
}

function readArchiveEntry(filePath, entry) {
  return execFileSync('unzip', ['-p', filePath, entry], {
    encoding: 'utf8',
    maxBuffer: COMMAND_BUFFER_LIMIT,
  });
}

function readSrcJarAsText(filePath) {
  const entries = listArchiveEntries(filePath);
  const chunks = [];

  entries.forEach((entry) => {
    const entryExt = path.extname(entry).toLowerCase();
    const treatAsText = TEXT_EXTENSIONS.has(entryExt) || entry === 'META-INF/MANIFEST.MF';
    if (!treatAsText) {
      return;
    }

    const content = readArchiveEntry(filePath, entry);
    chunks.push(`===== ${entry} =====\n${content}`);
  });

  return chunks.join('\n\n');
}

function readArchivePreview(filePath, ext) {
  const stat = fs.statSync(filePath);
  const lines = [
    `archive=${path.basename(filePath)}`,
    `type=${ext || '(unknown)'}`,
    `size=${stat.size} bytes`,
    '',
    '===== entries =====',
  ];

  try {
    const entries = listArchiveEntries(filePath);
    if (entries.length === 0) {
      lines.push('(empty archive)');
    } else {
      lines.push(...entries);
    }
  } catch (error) {
    lines.push(`无法读取归档内容: ${error.message}`);
  }

  return lines.join('\n');
}

function formatHexDump(buffer, startOffset = 0) {
  const lines = [];

  for (let offset = 0; offset < buffer.length; offset += 16) {
    const slice = buffer.subarray(offset, offset + 16);
    const hex = Array.from(slice, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    const ascii = Array.from(slice, (byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('');
    lines.push(`${(startOffset + offset).toString(16).toUpperCase().padStart(8, '0')}: ${hex.padEnd(47, ' ')}  ${ascii}`);
  }

  return lines.join('\n');
}

function readBinaryDump(filePath) {
  const stat = fs.statSync(filePath);
  const byteLimit = Math.min(stat.size, BINARY_DUMP_BYTE_LIMIT);
  const fd = fs.openSync(filePath, 'r');

  try {
    const buffer = Buffer.alloc(byteLimit);
    const bytesRead = fs.readSync(fd, buffer, 0, byteLimit, 0);
    const header = [
      `binary=${path.basename(filePath)}`,
      `size=${stat.size} bytes`,
      stat.size > byteLimit ? `预览前 ${byteLimit} bytes（文件过大，未展开全部十六进制内容）` : '已显示全部十六进制内容',
      '',
    ].join('\n');

    return `${header}${formatHexDump(buffer.subarray(0, bytesRead))}`;
  } finally {
    fs.closeSync(fd);
  }
}

function readComparableContent(filePath, ext) {
  if (isSourceArchive(ext)) {
    return readSrcJarAsText(filePath);
  }

  if (isArchivePreviewExt(ext)) {
    return readArchivePreview(filePath, ext);
  }

  if (isTextFile(filePath, ext)) {
    return fs.readFileSync(filePath, 'utf8');
  }

  return readBinaryDump(filePath);
}

function parseAaptBadging(filePath) {
  try {
    const output = execFileSync('aapt', ['dump', 'badging', filePath], {
      encoding: 'utf8',
      maxBuffer: COMMAND_BUFFER_LIMIT,
    });

    const versionCodeMatch = output.match(/versionCode='([^']+)'/);
    const versionNameMatch = output.match(/versionName='([^']+)'/);
    const sdkVersionMatch = output.match(/sdkVersion:'([^']+)'/);
    const targetSdkVersionMatch = output.match(/targetSdkVersion:'([^']+)'/);

    return {
      versionCode: versionCodeMatch?.[1] || '',
      versionName: versionNameMatch?.[1] || '',
      sdkVersion: sdkVersionMatch?.[1] || '',
      targetSdkVersion: targetSdkVersionMatch?.[1] || '',
    };
  } catch {
    return null;
  }
}

function pickApksInnerEntry(entries) {
  const preferredPatterns = [
    /^standalones\/standalone-arm64_v8a\.apex$/i,
    /^standalones\/standalone-arm64_v8a\.apk$/i,
    /^standalones\/.*\.(apex|apk)$/i,
    /\.(apex|apk)$/i,
  ];

  for (const pattern of preferredPatterns) {
    const matched = entries.find((entry) => pattern.test(entry));
    if (matched) {
      return matched;
    }
  }

  return null;
}

function parseApksBadging(filePath) {
  try {
    const entries = listArchiveEntries(filePath);
    const targetEntry = pickApksInnerEntry(entries);
    if (!targetEntry) {
      return null;
    }

    const extracted = execFileSync('unzip', ['-p', filePath, targetEntry], {
      maxBuffer: COMMAND_BUFFER_LIMIT,
    });
    const tempPath = path.join(os.tmpdir(), `mainline-tool-${process.pid}-${Date.now()}${path.extname(targetEntry) || '.apk'}`);

    try {
      fs.writeFileSync(tempPath, extracted);
      return parseAaptBadging(tempPath);
    } finally {
      fs.removeSync(tempPath);
    }
  } catch {
    return null;
  }
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function compareApkSdk(sourcePath, targetPath) {
  const sourceExt = path.extname(sourcePath).toLowerCase();
  const targetExt = path.extname(targetPath).toLowerCase();
  const sourceMeta = sourceExt === '.apks' ? parseApksBadging(sourcePath) : parseAaptBadging(sourcePath);
  const targetMeta = targetExt === '.apks' ? parseApksBadging(targetPath) : parseAaptBadging(targetPath);

  if (!sourceMeta || !targetMeta) {
    return null;
  }

  const sourceTargetSdk = toNumber(sourceMeta.targetSdkVersion);
  const targetTargetSdk = toNumber(targetMeta.targetSdkVersion);
  const sourceMinSdk = toNumber(sourceMeta.sdkVersion);
  const targetMinSdk = toNumber(targetMeta.sdkVersion);
  const sourceVersionCode = toNumber(sourceMeta.versionCode);
  const targetVersionCode = toNumber(targetMeta.versionCode);

  const hasLowerSignal =
    sourceVersionCode < targetVersionCode;
    // sourceTargetSdk < targetTargetSdk ||
    // sourceMinSdk < targetMinSdk;

  return {
    sourceMeta,
    targetMeta,
    canAutoMerge: !hasLowerSignal,
    requiresManual: hasLowerSignal,
  };
}

function formatApkMeta(meta) {
  if (!meta) {
    return '无法解析 APK 版本信息';
  }

  return `versionCode=${meta.versionCode || '-'}, versionName=${meta.versionName || '-'}, sdk=${meta.sdkVersion || '-'}, targetSdk=${meta.targetSdkVersion || '-'}`;
}

function applyManualStatus(relativePath, summary, manualStatuses) {
  const manualStatus = manualStatuses?.[relativePath];
  if (manualStatus !== 'danger' && manualStatus !== 'update') {
    return { ...summary, manualStatus: null };
  }

  if (summary.status === 'same') {
    return { ...summary, manualStatus: null };
  }

  const reasonPrefix = manualStatus === 'danger' ? '手动标记为人工接入' : '手动标记为可合入';
  return {
    ...summary,
    status: manualStatus,
    manualStatus,
    reason: `${reasonPrefix}。${summary.reason}`,
  };
}

function buildFileSummary(relativePath, fullPath, targetPath, manualStatuses) {
  const ext = path.extname(fullPath).toLowerCase();
  const targetExists = fs.existsSync(targetPath);
  const textFile = isTextFile(fullPath, ext);

  let summary = {
    ext,
    type: textFile ? 'text' : 'bin',
    status: 'update',
    reason: targetExists ? '可自动合入' : '目标文件不存在，将新增',
    targetExists,
    sourceContent: '',
    targetContent: '',
  };

  if (textFile && !isSourceArchive(ext)) {
    summary.sourceContent = fs.readFileSync(fullPath, 'utf8');
    const sourceHasGms = GMS_PATTERN.test(summary.sourceContent);
    let targetHasGms = false;

    if (targetExists) {
      summary.targetContent = fs.readFileSync(targetPath, 'utf8');
      targetHasGms = GMS_PATTERN.test(summary.targetContent);
    }

    if (sourceHasGms || targetHasGms) {
      summary.status = 'danger';
      summary.reason = '严禁自动覆盖：检测到本地或资源包存在 [GMS] 修改痕迹';
    } else if (targetExists && summary.sourceContent === summary.targetContent) {
      summary.status = 'same';
      summary.reason = '文件内容完全一致，无需合入';
    }
  } else if (targetExists && areFilesIdentical(fullPath, targetPath)) {
    summary.status = 'same';
    summary.reason = isSourceArchive(ext) ? '源码归档完全一致，无需合入' : textFile ? '文件内容完全一致，无需合入' : '二进制文件完全一致，无需合入';
  } else if ((ext === '.apk' || ext === '.apks') && targetExists) {
    const apkComparison = compareApkSdk(fullPath, targetPath);
    if (apkComparison?.canAutoMerge) {
      summary.reason = `资源 ${ext === '.apks' ? 'APKS' : 'APK'} 版本更新，允许合入。资源: ${formatApkMeta(apkComparison.sourceMeta)}；本地: ${formatApkMeta(apkComparison.targetMeta)}`;
    } else if (apkComparison?.requiresManual) {
      summary.status = 'danger';
      summary.reason = `资源 ${ext === '.apks' ? 'APKS' : 'APK'} 未明显高于本地或存在版本指标回退，需人工确认。资源: ${formatApkMeta(apkComparison.sourceMeta)}；本地: ${formatApkMeta(apkComparison.targetMeta)}`;
    } else {
      summary.reason = `${ext === '.apks' ? 'APKS' : 'APK'} 存在差异，但版本信息解析失败，建议人工确认后再决定是否合入`;
      summary.status = 'danger';
    }
  } else if (isSourceArchive(ext)) {
    summary.reason = targetExists ? '源码归档存在差异，可展开查看全部内容' : '目标文件不存在，将新增源码归档';
  } else if (!textFile) {
    summary.reason = targetExists ? '二进制文件存在差异，可查看完整转储内容' : '目标文件不存在，将新增二进制文件';
  }

  return applyManualStatus(relativePath, summary, manualStatuses);
}

function getConfigOrThrow() {
  const config = loadConfig();

  if (!fs.existsSync(config.sourceDir)) {
    throw new Error(`资源包路径不存在: ${config.sourceDir}`);
  }

  if (!fs.existsSync(config.projectDir)) {
    throw new Error(`项目路径不存在: ${config.projectDir}`);
  }

  return config;
}

app.get('/api/config', async (req, res) => {
  try {
    const config = loadConfig();
    res.json({
      sourceDir: config.sourceDir,
      projectDir: config.projectDir,
      noteProjectKey: config.noteProjectKey,
      noteProjectKeys: config.noteProjectKeys,
      manualStatuses: config.manualStatuses,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    const sourceDir = (req.body.sourceDir || '').trim();
    const projectDir = (req.body.projectDir || '').trim();
    const noteProjectKey = typeof req.body.noteProjectKey === 'string' ? req.body.noteProjectKey.trim() : '';
    const currentConfig = loadConfig();
    const noteProjectKeys = normalizeNoteProjectKeys(req.body.noteProjectKeys, noteProjectKey);

    if (!sourceDir || !projectDir) {
      return res.status(400).json({ error: '资源包路径和项目路径都不能为空' });
    }

    if (!fs.existsSync(sourceDir)) {
      return res.status(400).json({ error: `资源包路径不存在: ${sourceDir}` });
    }

    if (!fs.existsSync(projectDir)) {
      return res.status(400).json({ error: `项目路径不存在: ${projectDir}` });
    }

    const nextConfig = {
      sourceDir,
      projectDir,
      noteProjectKey: noteProjectKey && noteProjectKeys.includes(noteProjectKey) ? noteProjectKey : (noteProjectKeys[0] || ''),
      noteProjectKeys,
      manualStatuses: currentConfig.manualStatuses || {},
    };
    saveConfig(nextConfig);
    res.json(nextConfig);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/note-types', async (req, res) => {
  try {
    const projectKey = typeof req.body.projectKey === 'string' ? req.body.projectKey.trim() : '';
    const validationError = validateNoteProjectKey(projectKey);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const currentConfig = loadConfig();
    const nextConfig = getNextNoteTypeConfig(
      {
        ...currentConfig,
        noteProjectKeys: [...(currentConfig.noteProjectKeys || []), projectKey],
      },
      projectKey
    );

    saveConfig(nextConfig);
    res.json(nextConfig);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/note-types/select', async (req, res) => {
  try {
    const projectKey = typeof req.body.projectKey === 'string' ? req.body.projectKey.trim() : '';
    const currentConfig = loadConfig();

    if (projectKey && !currentConfig.noteProjectKeys.includes(projectKey)) {
      return res.status(400).json({ error: '所选备注类型不存在，请先新增后再使用' });
    }

    const nextConfig = getNextNoteTypeConfig(currentConfig, projectKey);
    saveConfig(nextConfig);
    res.json(nextConfig);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/note-types', async (req, res) => {
  try {
    const projectKey = typeof req.query.projectKey === 'string' ? req.query.projectKey.trim() : '';
    const validationError = validateNoteProjectKey(projectKey);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const currentConfig = loadConfig();
    if (!currentConfig.noteProjectKeys.includes(projectKey)) {
      return res.status(404).json({ error: '要删除的备注类型不存在' });
    }

    const remainingKeys = currentConfig.noteProjectKeys.filter((item) => item !== projectKey);
    const nextConfig = getNextNoteTypeConfig(
      {
        ...currentConfig,
        noteProjectKeys: remainingKeys,
      },
      currentConfig.noteProjectKey === projectKey ? '' : currentConfig.noteProjectKey
    );

    if (hasNoteDatabaseConfig()) {
      await withNotesDbSession(async (client) => {
        await client.query(
          `DELETE FROM ${NOTE_TABLE_NAME} WHERE project_key = $1`,
          [projectKey]
        );
      });
    }

    saveConfig(nextConfig);
    res.json({
      ...nextConfig,
      deletedProjectKey: projectKey,
    });
  } catch (err) {
    res.status(500).json({ error: toReadableDatabaseError(err) });
  }
});

app.get('/api/header-note', async (req, res) => {
  try {
    const scope = resolveNoteScope(req.query);
    const note = await withNotesDbSession(async (client) => {
      const { rows } = await client.query(
        `
          SELECT note_content, created_at, updated_at
          FROM ${NOTE_TABLE_NAME}
          WHERE project_key = $1
          LIMIT 1
        `,
        [scope.projectKey]
      );
      return rows[0] || null;
    });

    res.json({
      ...scope,
      noteContent: note?.note_content || '',
      createdAt: note?.created_at || null,
      updatedAt: note?.updated_at || null,
    });
  } catch (err) {
    res.status(hasNoteDatabaseConfig() ? 500 : 503).json({ error: toReadableDatabaseError(err) });
  }
});

app.post('/api/header-note', async (req, res) => {
  try {
    const noteContent = req.body.noteContent;
    const validationError = validateNoteContent(noteContent);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const scope = resolveNoteScope(req.body);
    const note = await withNotesDbSession(async (client) => {
      const { rows } = await client.query(
        `
          INSERT INTO ${NOTE_TABLE_NAME} (project_key, source_dir, project_dir, note_content)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (project_key)
          DO UPDATE SET
            source_dir = EXCLUDED.source_dir,
            project_dir = EXCLUDED.project_dir,
            note_content = EXCLUDED.note_content,
            updated_at = NOW()
          RETURNING id, note_content, created_at, updated_at
        `,
        [scope.projectKey, scope.sourceDir, scope.projectDir, noteContent]
      );

      return rows[0];
    });

    res.json({
      ok: true,
      ...scope,
      id: note.id,
      noteContent: note.note_content,
      createdAt: note.created_at,
      updatedAt: note.updated_at,
    });
  } catch (err) {
    res.status(hasNoteDatabaseConfig() ? 500 : 503).json({ error: toReadableDatabaseError(err) });
  }
});

app.post('/api/status-override', async (req, res) => {
  try {
    const relativePath = req.body.path;
    const status = req.body.status;
    const validationError = validateRelativePath(relativePath);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (status !== 'danger' && status !== 'update' && status !== null) {
      return res.status(400).json({ error: '状态只允许 danger、update 或 null' });
    }

    const config = loadConfig();
    const manualStatuses = { ...(config.manualStatuses || {}) };

    if (status === null) {
      delete manualStatuses[relativePath];
    } else {
      manualStatuses[relativePath] = status;
    }

    const nextConfig = { ...config, manualStatuses };
    saveConfig(nextConfig);
    res.json({ ok: true, manualStatuses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/status-override/reset', async (req, res) => {
  try {
    const config = loadConfig();
    const nextConfig = { ...config, manualStatuses: {} };
    saveConfig(nextConfig);
    res.json({ ok: true, manualStatuses: {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scan', async (req, res) => {
  try {
    let config = getConfigOrThrow();
    const resetManualStatuses = req.query.reset_manual === '1';

    if (resetManualStatuses && Object.keys(config.manualStatuses || {}).length > 0) {
      config = { ...config, manualStatuses: {} };
      saveConfig(config);
    }

    const sourceFiles = getAllFiles(config.sourceDir);
    const nextManualStatuses = { ...(config.manualStatuses || {}) };
    let manualStatusesChanged = false;

    const results = sourceFiles.map((fullPath) => {
      const relativePath = path.relative(config.sourceDir, fullPath);
      const targetPath = path.join(config.projectDir, relativePath);
      const summary = buildFileSummary(relativePath, fullPath, targetPath, config.manualStatuses);

       if (summary.status === 'same' && nextManualStatuses[relativePath]) {
        delete nextManualStatuses[relativePath];
        manualStatusesChanged = true;
      }

      return {
        path: relativePath,
        type: summary.type,
        status: summary.status,
        reason: summary.reason,
        manualStatus: summary.manualStatus,
        sourceContent: summary.sourceContent.slice(0, PREVIEW_LIMIT),
        targetContent: summary.targetContent.slice(0, PREVIEW_LIMIT),
        targetExists: summary.targetExists,
        truncated: summary.sourceContent.length > PREVIEW_LIMIT || summary.targetContent.length > PREVIEW_LIMIT,
      };
    });

    if (manualStatusesChanged) {
      saveConfig({ ...config, manualStatuses: nextManualStatuses });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/file-content', async (req, res) => {
  try {
    const relativePath = req.query.path;
    const validationError = validateRelativePath(relativePath);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const config = getConfigOrThrow();
    const sourcePath = path.join(config.sourceDir, relativePath);
    const targetPath = path.join(config.projectDir, relativePath);

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: '资源包文件不存在' });
    }

    const ext = path.extname(sourcePath).toLowerCase();
    const sourceContent = readComparableContent(sourcePath, ext);
    const targetContent = fs.existsSync(targetPath) ? readComparableContent(targetPath, ext) : '';

    res.json({
      sourceContent,
      targetContent,
      targetExists: fs.existsSync(targetPath),
      contentType: isTextFile(sourcePath, ext) ? 'text' : 'binary-dump',
      editable: isTextFile(sourcePath, ext) && !isSourceArchive(ext),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/git-history', async (req, res) => {
  try {
    const relativePath = req.query.path;
    const validationError = validateRelativePath(relativePath);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const config = getConfigOrThrow();
    const history = getFileGitHistory(config.projectDir, relativePath);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message || '读取提交记录失败' });
  }
});

app.get('/api/git-history/detail', async (req, res) => {
  try {
    const relativePath = req.query.path;
    const commit = req.query.commit;
    const validationError = validateRelativePath(relativePath);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const config = getConfigOrThrow();
    const detail = getFileGitCommitDetail(config.projectDir, relativePath, commit);
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message || '读取提交详情失败' });
  }
});

app.post('/api/file-content/save', async (req, res) => {
  try {
    const relativePath = req.body.path;
    const targetContent = req.body.targetContent;
    const validationError = validateRelativePath(relativePath);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (typeof targetContent !== 'string') {
      return res.status(400).json({ error: 'targetContent 必须是字符串' });
    }

    const config = getConfigOrThrow();
    const sourcePath = path.join(config.sourceDir, relativePath);
    const targetPath = path.join(config.projectDir, relativePath);

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: '资源包文件不存在' });
    }

    const ext = path.extname(sourcePath).toLowerCase();
    if (!isTextFile(sourcePath, ext) || isSourceArchive(ext)) {
      return res.status(400).json({ error: '当前文件不支持在页面内直接编辑保存' });
    }

    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, targetContent, 'utf8');
    const summary = buildFileSummary(relativePath, sourcePath, targetPath, config.manualStatuses);
    res.json({
      ok: true,
      item: {
        path: relativePath,
        type: summary.type,
        status: summary.status,
        reason: summary.reason,
        manualStatus: summary.manualStatus,
        sourceContent: summary.sourceContent.slice(0, PREVIEW_LIMIT),
        targetContent: summary.targetContent.slice(0, PREVIEW_LIMIT),
        targetExists: summary.targetExists,
        truncated: summary.sourceContent.length > PREVIEW_LIMIT || summary.targetContent.length > PREVIEW_LIMIT,
      },
      fullContent: {
        sourceContent: summary.sourceContent,
        targetContent: summary.targetContent,
        targetExists: summary.targetExists,
        contentType: isTextFile(sourcePath, ext) ? 'text' : 'binary-dump',
        editable: true,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/merge', async (req, res) => {
  const { filesToMerge = [] } = req.body;
  const log = [];

  try {
    const config = getConfigOrThrow();

    for (const relPath of filesToMerge) {
      const validationError = validateRelativePath(relPath);
      if (validationError) {
        log.push(`[SKIP] ${relPath || '<empty>'} - ${validationError}`);
        continue;
      }

      const src = path.join(config.sourceDir, relPath);
      const dest = path.join(config.projectDir, relPath);

      if (!fs.existsSync(src)) {
        log.push(`[SKIP] ${relPath} - 资源包文件不存在。`);
        continue;
      }

      const ext = path.extname(src).toLowerCase();
      const textFile = isTextFile(src, ext);

      if (fs.existsSync(dest) && areFilesIdentical(src, dest)) {
        log.push(`[SKIP] ${relPath} - 文件内容一致，跳过。`);
        continue;
      }

      if ((ext === '.apk' || ext === '.apks') && fs.existsSync(dest)) {
        const apkComparison = compareApkSdk(src, dest);
        if (!apkComparison) {
          log.push(`[SKIP] ${relPath} - ${ext === '.apks' ? 'APKS' : 'APK'} 版本信息解析失败，跳过自动合入。`);
          continue;
        }
        if (!apkComparison.canAutoMerge) {
          log.push(`[SKIP] ${relPath} - 资源 ${ext === '.apks' ? 'APKS' : 'APK'} 未明确高于本地，跳过自动合入，需人工确认。`);
          continue;
        }
      }

      if (textFile && !isSourceArchive(ext)) {
        const sourceContent = fs.readFileSync(src, 'utf8');
        if (GMS_PATTERN.test(sourceContent)) {
          log.push(`[SKIP] ${relPath} - 含有 GMS 标签，跳过。`);
          continue;
        }

        if (fs.existsSync(dest)) {
          const targetContent = fs.readFileSync(dest, 'utf8');
          if (GMS_PATTERN.test(targetContent)) {
            log.push(`[SKIP] ${relPath} - 本地文件含有 GMS 标签，跳过。`);
            continue;
          }
        }
      }

      await fs.ensureDir(path.dirname(dest));
      await fs.copy(src, dest, { overwrite: true });
      log.push(`[OK] ${relPath} - 合入成功。`);
    }

    res.json({ message: '合入任务结束', log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Mainline 后端服务运行在 http://localhost:${PORT}`);
});
