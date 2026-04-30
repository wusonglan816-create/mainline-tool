import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import cors from 'cors';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const CONFIG_PATH = path.join(__dirname, 'mainline-tool.config.json');
const DEFAULT_CONFIG = {
  sourceDir: '/home/wsl/Work_space/MTK_V/mainline_v_2025_oct_14238457',
  projectDir: '/home/wsl/Work_space/MTK_V/alps-release-v0.mp1.rc-default/alps',
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

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeJsonSync(CONFIG_PATH, DEFAULT_CONFIG, { spaces: 2 });
    return { ...DEFAULT_CONFIG };
  }

  const fileConfig = fs.readJsonSync(CONFIG_PATH);
  return {
    sourceDir: fileConfig.sourceDir || DEFAULT_CONFIG.sourceDir,
    projectDir: fileConfig.projectDir || DEFAULT_CONFIG.projectDir,
    manualStatuses: fileConfig.manualStatuses || {},
  };
}

function saveConfig(config) {
  fs.writeJsonSync(CONFIG_PATH, config, { spaces: 2 });
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
    const currentConfig = loadConfig();

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
      manualStatuses: currentConfig.manualStatuses || {},
    };
    saveConfig(nextConfig);
    res.json(nextConfig);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
