import React, { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  Edit3,
  Maximize2,
  Minimize2,
  FileArchive,
  FileCode,
  FileDigit,
  FileOutput,
  FileText,
  GitCommitHorizontal,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

const MAX_FULL_DIFF_LINES = 4000;
const MAX_FULL_DIFF_CHARS = 250000;
const VIRTUAL_ROW_HEIGHT = 28;
const VIRTUAL_OVERSCAN = 120;
const TRACE_CONTEXT_LINES = 2;
const GMS_TRACE_PATTERN = /(\/\/\[GMS\]\[\d+\]|begin-->|end-->|\[GMS\]|modify|redmine)/i;

function splitLines(content = '') {
  return content === '' ? [] : content.split('\n');
}

async function readJsonResponse(res, fallbackMessage) {
  const contentType = res.headers.get('content-type') || '';
  const rawText = await res.text();

  if (!contentType.includes('application/json')) {
    if (rawText.startsWith('<!DOCTYPE') || rawText.startsWith('<html')) {
      throw new Error('当前页面没有连到正确的后端服务，请重启前后端后重试');
    }
    throw new Error(fallbackMessage);
  }

  return JSON.parse(rawText || '{}');
}

async function copyTextWithFeedback(text, successMessage = '内容已复制') {
  try {
    await navigator.clipboard.writeText(text || '');
    alert(successMessage);
  } catch (err) {
    alert(`复制失败: ${err.message}`);
  }
}

function normalizeScanResultItem(item, indexFallback = 0) {
  return {
    id: item.id || indexFallback,
    ...item,
    size: item.type === 'bin' ? 'binary' : `${(item.sourceContent?.length || 0)}B`,
    mtime: new Date().toLocaleString(),
    content: item.sourceContent || '',
    target: { content: item.targetContent || '', exists: item.targetExists },
  };
}

function normalizeReferenceCompareConfig(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    rootDir: typeof config.rootDir === 'string' ? config.rootDir : '',
    month: typeof config.month === 'string' ? config.month : '',
  };
}

function summarizeScanResults(items = []) {
  return items.reduce((summary, item) => {
    if (item.status === 'same') {
      summary.sameCount += 1;
      return summary;
    }

    summary.visibleCount += 1;
    if (item.status === 'danger') {
      summary.dangerCount += 1;
    } else if (item.status === 'warning') {
      summary.warningCount += 1;
    } else if (item.status === 'update') {
      summary.updateCount += 1;
    }

    return summary;
  }, {
    visibleCount: 0,
    sameCount: 0,
    dangerCount: 0,
    warningCount: 0,
    updateCount: 0,
  });
}

function isManualReviewStatus(status) {
  return status === 'danger' || status === 'warning';
}

function getStatusBadgeLabel(status) {
  if (status === 'danger') return 'Danger';
  if (status === 'warning') return 'Warning';
  if (status === 'same' || status === 'safe') return 'Skip';
  return 'Ready';
}

function getStatusBadgeClass(status) {
  if (status === 'danger') return 'bg-red-500/20 text-red-400';
  if (status === 'warning') return 'bg-amber-500/20 text-amber-300';
  if (status === 'same' || status === 'safe') return 'bg-slate-500/15 text-slate-400';
  return 'bg-green-500/20 text-green-400';
}

function normalizeReferenceLine(line = '') {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function getNativeAdditionLineBlocks(referenceInfo) {
  return (referenceInfo?.nativeAdditions || []).flatMap((item) => {
    const blocks = Array.isArray(item.addedLineBlocks) && item.addedLineBlocks.length > 0
      ? item.addedLineBlocks
      : [];
    return blocks.map((block) => (
      block
        .map((line) => normalizeReferenceLine(line))
        .filter((line) => line.trim())
    )).filter((block) => block.length > 0);
  });
}

function tryMatchNativeAdditionBlock(rows, startIndex, block) {
  const matchedIndexes = [];
  let blockIndex = 0;
  let rowIndex = startIndex;

  while (rowIndex < rows.length && blockIndex < block.length) {
    const row = rows[rowIndex];
    const canHighlightRow = row.type === 'added' || row.type === 'changed';
    const rightText = normalizeReferenceLine(row.rightText || '');

    if (!canHighlightRow) {
      return null;
    }

    if (!rightText.trim()) {
      rowIndex += 1;
      continue;
    }

    if (rightText !== block[blockIndex]) {
      return null;
    }

    matchedIndexes.push(rowIndex);
    blockIndex += 1;
    rowIndex += 1;
  }

  return blockIndex === block.length ? matchedIndexes : null;
}

function buildNativeAdditionHighlightRows(rows = [], referenceInfo = null) {
  const blocks = getNativeAdditionLineBlocks(referenceInfo);
  const highlightedRows = new Set();

  if (blocks.length === 0) {
    return highlightedRows;
  }

  let searchStart = 0;

  blocks.forEach((block) => {
    for (let index = searchStart; index < rows.length; index += 1) {
      const matchedIndexes = tryMatchNativeAdditionBlock(rows, index, block);
      if (!matchedIndexes) {
        continue;
      }

      matchedIndexes.forEach((matchedIndex) => highlightedRows.add(matchedIndex));
      searchStart = matchedIndexes[matchedIndexes.length - 1] + 1;
      break;
    }
  });

  return highlightedRows;
}

function isBlankLine(line = '') {
  return line.trim() === '';
}

function getChangedSegments(currentText = '', otherText = '') {
  if (currentText === otherText) {
    return [{ text: currentText, changed: false }];
  }

  let prefix = 0;
  const maxPrefix = Math.min(currentText.length, otherText.length);
  while (prefix < maxPrefix && currentText[prefix] === otherText[prefix]) {
    prefix += 1;
  }

  let currentSuffix = currentText.length - 1;
  let otherSuffix = otherText.length - 1;
  while (currentSuffix >= prefix && otherSuffix >= prefix && currentText[currentSuffix] === otherText[otherSuffix]) {
    currentSuffix -= 1;
    otherSuffix -= 1;
  }

  const segments = [];
  const unchangedPrefix = currentText.slice(0, prefix);
  const changedCore = currentText.slice(prefix, currentSuffix + 1);
  const otherChangedCore = otherText.slice(prefix, otherSuffix + 1);
  const changedWidth = Math.max(changedCore.length, otherChangedCore.length, 1);
  const paddedChangedCore = changedCore.padEnd(changedWidth, ' ');
  const unchangedSuffix = currentText.slice(currentSuffix + 1);

  if (unchangedPrefix) segments.push({ text: unchangedPrefix, changed: false });
  if (paddedChangedCore) segments.push({ text: paddedChangedCore, changed: true });
  if (unchangedSuffix) segments.push({ text: unchangedSuffix, changed: false });

  return segments.length > 0 ? segments : [{ text: currentText, changed: true }];
}

function buildDiffRows(leftContent = '', rightContent = '') {
  const leftLines = splitLines(leftContent);
  const rightLines = splitLines(rightContent);
  const leftLen = leftLines.length;
  const rightLen = rightLines.length;
  const dp = Array.from({ length: leftLen + 1 }, () => Array(rightLen + 1).fill(0));

  for (let i = leftLen - 1; i >= 0; i -= 1) {
    for (let j = rightLen - 1; j >= 0; j -= 1) {
      if (leftLines[i] === rightLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;

  while (i < leftLen && j < rightLen) {
    if (leftLines[i] === rightLines[j]) {
      rows.push({
        type: 'same',
        leftNumber: i + 1,
        leftText: leftLines[i],
        rightNumber: j + 1,
        rightText: rightLines[j],
      });
      i += 1;
      j += 1;
      continue;
    }

    const removeScore = dp[i + 1][j];
    const addScore = dp[i][j + 1];

    if (
      removeScore === addScore &&
      i + 1 < leftLen &&
      j + 1 < rightLen &&
      leftLines[i + 1] === rightLines[j + 1] &&
      (
        getLineSimilarity(leftLines[i], rightLines[j]) >= 0.45 ||
        isBlankLineReplacement(leftLines[i], rightLines[j])
      )
    ) {
      rows.push({
        type: 'changed',
        leftNumber: i + 1,
        leftText: leftLines[i],
        rightNumber: j + 1,
        rightText: rightLines[j],
      });
      i += 1;
      j += 1;
    } else if (removeScore >= addScore) {
      rows.push({
        type: 'removed',
        leftNumber: i + 1,
        leftText: leftLines[i],
        rightNumber: null,
        rightText: '',
      });
      i += 1;
    } else {
      rows.push({
        type: 'added',
        leftNumber: null,
        leftText: '',
        rightNumber: j + 1,
        rightText: rightLines[j],
      });
      j += 1;
    }
  }

  while (i < leftLen) {
    rows.push({ type: 'removed', leftNumber: i + 1, leftText: leftLines[i], rightNumber: null, rightText: '' });
    i += 1;
  }

  while (j < rightLen) {
    rows.push({ type: 'added', leftNumber: null, leftText: '', rightNumber: j + 1, rightText: rightLines[j] });
    j += 1;
  }

  return normalizeDiffRows(rows);
}

function normalizeDiffRows(rows = []) {
  const normalized = [];
  let index = 0;

  while (index < rows.length) {
    const current = rows[index];

    if (current.type === 'removed' || current.type === 'added') {
      const blockRows = [];
      const removedBlock = [];
      const addedBlock = [];
      let cursor = index;

      while (cursor < rows.length && (rows[cursor].type === 'removed' || rows[cursor].type === 'added')) {
        const blockRow = { ...rows[cursor], blockOrder: cursor - index };
        blockRows.push(blockRow);
        if (blockRow.type === 'removed') {
          removedBlock.push(blockRow);
        } else {
          addedBlock.push(blockRow);
        }
        cursor += 1;
      }

      normalized.push(...mergeDiffBlock(blockRows, removedBlock, addedBlock));

      index = cursor;
      continue;
    }

    normalized.push(current);
    index += 1;
  }

  return normalized;
}

function getConfigLineKey(line = '') {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return null;
  }

  const makeMatch = trimmed.match(/^([A-Za-z0-9_.$(){}-]+)\s*(?::=|\+=|\?=|=)\s*/);
  if (makeMatch) {
    return `assign:${makeMatch[1]}`;
  }

  const xmlNameMatch = trimmed.match(/^<([A-Za-z0-9_.:-]+)\b[^>]*\bname=["']([^"']+)["']/);
  if (xmlNameMatch) {
    return `xml:${xmlNameMatch[1]}:${xmlNameMatch[2]}`;
  }

  return null;
}

function cleanDiffRow(row) {
  const { blockOrder, ...cleaned } = row;
  return cleaned;
}

function isCommentLine(line = '') {
  const trimmed = line.trim();
  return trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

function getLineSimilarity(leftText = '', rightText = '') {
  const left = leftText.trim();
  const right = rightText.trim();
  if (!left || !right) {
    return 0;
  }

  const leftIsComment = isCommentLine(left);
  const rightIsComment = isCommentLine(right);
  if (leftIsComment !== rightIsComment) {
    return 0;
  }

  const leftKey = getConfigLineKey(left);
  const rightKey = getConfigLineKey(right);
  if (leftKey || rightKey) {
    return leftKey && leftKey === rightKey ? 1 : 0;
  }

  let prefix = 0;
  const maxPrefix = Math.min(left.length, right.length);
  while (prefix < maxPrefix && left[prefix] === right[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < maxPrefix - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
  const union = new Set([...leftTokens, ...rightTokens]);
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const tokenScore = union.size === 0 ? 0 : intersection / union.size;
  const prefixScore = prefix / Math.max(left.length, right.length);
  const suffixScore = suffix / Math.max(left.length, right.length);

  return Math.max(tokenScore, prefixScore, suffixScore);
}

function isBlankLineReplacement(leftText = '', rightText = '') {
  return isBlankLine(leftText) !== isBlankLine(rightText);
}

function mergeDiffBlock(blockRows, removedBlock, addedBlock) {
  const matchedRemoved = new Set();
  const matchedAdded = new Set();
  const pairByOutputOrder = new Map();

  while (matchedRemoved.size < removedBlock.length && matchedAdded.size < addedBlock.length) {
    let bestPair = null;
    let bestScore = 0;

    removedBlock.forEach((removed, removedIndex) => {
      if (matchedRemoved.has(removedIndex)) return;

      addedBlock.forEach((added, addedIndex) => {
        if (matchedAdded.has(addedIndex)) return;
        const score = getLineSimilarity(removed.leftText, added.rightText);
        if (score > bestScore) {
          bestScore = score;
          bestPair = { removed, removedIndex, added, addedIndex };
        }
      });
    });

    if (!bestPair || bestScore < 0.45) {
      break;
    }

    matchedRemoved.add(bestPair.removedIndex);
    matchedAdded.add(bestPair.addedIndex);
    const outputOrder = removedBlock.length > addedBlock.length
      ? bestPair.removed.blockOrder
      : bestPair.added.blockOrder;
    pairByOutputOrder.set(outputOrder, {
      removed: bestPair.removed,
      added: bestPair.added,
    });
  }

  const removedIndexByOrder = new Map(removedBlock.map((row, rowIndex) => [row.blockOrder, rowIndex]));
  const addedIndexByOrder = new Map(addedBlock.map((row, rowIndex) => [row.blockOrder, rowIndex]));
  const output = [];

  blockRows.forEach((row) => {
    const paired = pairByOutputOrder.get(row.blockOrder);
    if (paired) {
      output.push({
        type: 'changed',
        leftNumber: paired.removed.leftNumber,
        leftText: paired.removed.leftText,
        rightNumber: paired.added.rightNumber,
        rightText: paired.added.rightText,
      });
      return;
    }

    if (row.type === 'removed') {
      const removedIndex = removedIndexByOrder.get(row.blockOrder);
      if (!matchedRemoved.has(removedIndex)) {
        output.push(cleanDiffRow(row));
      }
      return;
    }

    const addedIndex = addedIndexByOrder.get(row.blockOrder);
    if (!matchedAdded.has(addedIndex)) {
      output.push(cleanDiffRow(row));
    }
  });

  return output;
}

function buildLineByLineRows(leftContent = '', rightContent = '') {
  const leftLines = splitLines(leftContent);
  const rightLines = splitLines(rightContent);
  const maxLen = Math.max(leftLines.length, rightLines.length);
  const rows = [];

  for (let index = 0; index < maxLen; index += 1) {
    const hasLeft = index < leftLines.length;
    const hasRight = index < rightLines.length;
    const leftText = hasLeft ? leftLines[index] : '';
    const rightText = hasRight ? rightLines[index] : '';

    let type = 'same';
    if (hasLeft && !hasRight) {
      type = 'removed';
    } else if (!hasLeft && hasRight) {
      type = 'added';
    } else if (leftText !== rightText) {
      type = 'changed';
    }

    rows.push({
      type,
      leftNumber: hasLeft ? index + 1 : null,
      leftText,
      rightNumber: hasRight ? index + 1 : null,
      rightText,
    });
  }

  return rows;
}

function buildLightweightDiffRows(leftContent = '', rightContent = '') {
  return buildLineByLineRows(leftContent, rightContent);
}

function shouldUseLightweightDiff(leftContent = '', rightContent = '') {
  const totalChars = leftContent.length + rightContent.length;
  if (totalChars > MAX_FULL_DIFF_CHARS) {
    return true;
  }

  const totalLines = splitLines(leftContent).length + splitLines(rightContent).length;
  return totalLines > MAX_FULL_DIFF_LINES;
}

function getFileExtensionGroup(filePath = '') {
  const filename = filePath.split('/').pop() || filePath;
  return filename.includes('.') ? `.${filename.split('.').pop().toLowerCase()}` : '(no-ext)';
}

function buildTraceFocusedRows(leftContent = '', rightContent = '') {
  const leftLines = splitLines(leftContent);
  const rightLines = splitLines(rightContent);
  const maxLen = Math.max(leftLines.length, rightLines.length);
  const interestingIndexes = new Set();

  for (let index = 0; index < maxLen; index += 1) {
    const leftText = leftLines[index] ?? '';
    const rightText = rightLines[index] ?? '';
    if (!GMS_TRACE_PATTERN.test(leftText) && !GMS_TRACE_PATTERN.test(rightText)) {
      continue;
    }

    const start = Math.max(index - TRACE_CONTEXT_LINES, 0);
    const end = Math.min(index + TRACE_CONTEXT_LINES, maxLen - 1);
    for (let current = start; current <= end; current += 1) {
      interestingIndexes.add(current);
    }
  }

  const sortedIndexes = Array.from(interestingIndexes).sort((a, b) => a - b);
  const rows = [];
  let previousIndex = null;

  sortedIndexes.forEach((index) => {
    if (previousIndex !== null && index - previousIndex > 1) {
      rows.push({
        type: 'gap',
        leftNumber: null,
        leftText: '',
        rightNumber: null,
        rightText: '',
      });
    }

    const hasLeft = index < leftLines.length;
    const hasRight = index < rightLines.length;
    const leftText = hasLeft ? leftLines[index] : '';
    const rightText = hasRight ? rightLines[index] : '';
    const matchedTrace = GMS_TRACE_PATTERN.test(leftText) || GMS_TRACE_PATTERN.test(rightText);

    let type = 'same';
    if (hasLeft && !hasRight) {
      type = 'removed';
    } else if (!hasLeft && hasRight) {
      type = 'added';
    } else if (leftText !== rightText || matchedTrace) {
      type = 'changed';
    }

    rows.push({
      type,
      leftNumber: hasLeft ? index + 1 : null,
      leftText,
      rightNumber: hasRight ? index + 1 : null,
      rightText,
    });

    previousIndex = index;
  });

  return rows;
}

function DiffCell({
  lineNumber,
  text,
  rowType,
  otherText,
  emptyLabel,
  highlightTone = 'default',
  editable = false,
  onTextChange,
  onEditorKeyDown,
}) {
  const isPlaceholder = rowType === 'placeholder' || rowType === 'gap';
  const rowToneClass = rowType === 'added' || rowType === 'removed' || rowType === 'placeholder'
      ? 'bg-red-500/5'
      : '';
  const segments = rowType === 'changed'
    ? getChangedSegments(text, otherText)
    : [{ text, changed: rowType === 'added' || rowType === 'removed' }];
  const getSegmentClass = (segment) => {
    if (!segment.changed) {
      return 'text-slate-400';
    }

    if (rowType === 'added' || rowType === 'removed') {
      if (highlightTone === 'warning' && rowType === 'added') {
        return 'text-amber-100 bg-amber-500/20 rounded-sm';
      }
      return 'text-red-200 bg-red-500/15 rounded-sm';
    }

    if (highlightTone === 'warning') {
      return 'text-amber-100 bg-amber-500/20 rounded-sm';
    }

    return 'text-red-300 bg-red-500/15 rounded-sm';
  };

  return (
    <div className={`flex gap-4 px-4 py-1.5 min-h-8 items-start w-max min-w-full ${rowToneClass}`}>
      <span className="w-12 shrink-0 text-slate-700 text-right select-none text-[11px] pt-0.5 border-r border-slate-800/60 pr-2">
        {lineNumber ?? ''}
      </span>
      <span className="flex-1 whitespace-pre text-[13px] font-mono leading-relaxed text-slate-400 min-w-0">
        {isPlaceholder ? (
          <span className={rowType === 'placeholder' ? 'inline-block min-w-4 text-red-200/40' : 'text-slate-700'}>
            {emptyLabel || ' '}
          </span>
        ) : editable ? (
          <span className="relative block min-w-full">
            <span aria-hidden="true" className="block whitespace-pre text-[13px] font-mono leading-relaxed">
              {segments.map((segment, index) => (
                <span
                  key={`${lineNumber ?? 'x'}-edit-${index}`}
                  className={getSegmentClass(segment)}
                  style={{ pointerEvents: 'none' }}
                >
                  {segment.text || ' '}
                </span>
              ))}
            </span>
            <textarea
              data-edit-line-number={lineNumber ?? undefined}
              value={text}
              onChange={(event) => onTextChange?.(event.target.value)}
              onKeyDown={(event) => onEditorKeyDown?.(event)}
              rows={1}
              wrap="off"
              spellCheck={false}
              className="absolute inset-0 block w-full resize-none overflow-hidden bg-transparent p-0 font-mono text-[13px] leading-relaxed text-transparent caret-slate-100 selection:bg-blue-500/35 focus:outline-none"
              style={{ minHeight: '1.25rem' }}
            />
          </span>
        ) : (
          segments.map((segment, index) => (
            <span key={`${lineNumber ?? 'x'}-${index}`} className={getSegmentClass(segment)}>
              {segment.text || ' '}
            </span>
          ))
        )}
      </span>
    </div>
  );
}

function ComparePane({
  title,
  badge,
  rows,
  side,
  highlightRowIndexes = new Set(),
  paneRef,
  onScroll,
  editing = false,
  onLineChange,
  onLineKeyDown,
  virtualRange = null,
}) {
  const visibleRows = virtualRange ? rows.slice(virtualRange.start, virtualRange.end) : rows;
  const topSpacerHeight = virtualRange ? virtualRange.start * VIRTUAL_ROW_HEIGHT : 0;
  const bottomSpacerHeight = virtualRange ? Math.max(rows.length - virtualRange.end, 0) * VIRTUAL_ROW_HEIGHT : 0;
  const rowsContent = rows.length > 0 ? (
    <div style={virtualRange ? { minHeight: rows.length * VIRTUAL_ROW_HEIGHT } : undefined}>
      {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} />}
      {visibleRows.map((row, visibleIndex) => {
        const actualIndex = virtualRange ? virtualRange.start + visibleIndex : visibleIndex;
        return (
          <div
            key={actualIndex}
            data-diff-row-index={actualIndex}
            className="border-b border-slate-900/70"
          >
            {side === 'left' ? (
              <DiffCell
                lineNumber={row.leftNumber}
                text={row.leftText}
                rowType={row.type === 'added' ? 'placeholder' : row.type}
                otherText={row.rightText}
                emptyLabel={row.type === 'gap' ? '...' : ''}
                editable={editing && row.leftNumber !== null}
                onTextChange={(nextText) => onLineChange?.(row.leftNumber, nextText)}
                onEditorKeyDown={(event) => onLineKeyDown?.(row.leftNumber, event)}
              />
            ) : (
              <DiffCell
                lineNumber={row.rightNumber}
                text={row.rightText}
                rowType={row.type === 'removed' ? 'placeholder' : row.type}
                otherText={row.leftText}
                emptyLabel={row.type === 'gap' ? '...' : ''}
                highlightTone={highlightRowIndexes.has(actualIndex) ? 'warning' : 'default'}
              />
            )}
          </div>
        );
      })}
      {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight }} />}
    </div>
  ) : (
    <div className="px-4 py-3 text-slate-600">当前没有可显示内容</div>
  );

  return (
    <div className="flex-[1_1_0%] min-w-0 flex flex-col overflow-hidden bg-slate-900">
      <div className="flex items-center justify-between px-4 py-3 bg-slate-800 border-b border-slate-700 shrink-0">
        <span className="text-[12px] font-bold text-slate-300">{title}</span>
        {badge}
      </div>
      <div ref={paneRef} onScroll={onScroll} className="flex-1 overflow-auto custom-scrollbar">
        {rowsContent}
      </div>
    </div>
  );
}

function DiffOverviewBar({ rows, activeIndex, onJump }) {
  const diffRows = useMemo(() => (
    rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.type !== 'same')
  ), [rows]);

  return (
    <div className="w-5 shrink-0 bg-slate-950 border-x border-slate-800">
      <div className="relative h-full w-full bg-slate-950">
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-800" />
        {diffRows.map(({ row, index }) => {
          const top = rows.length <= 1 ? 0 : ((index + 0.5) / rows.length) * 100;
          const active = activeIndex === row.index;
          const title = row.leftNumber && row.rightNumber
            ? `跳转到差异行: 本地 ${row.leftNumber} / 资源 ${row.rightNumber}`
            : row.leftNumber
              ? `跳转到本地第 ${row.leftNumber} 行`
              : `跳转到资源第 ${row.rightNumber} 行`;

          return (
            <button
              key={`${row.type}-${index}`}
              type="button"
              title={title}
              onClick={() => onJump(row.index)}
              className={`absolute left-0 right-0 h-3 -translate-y-1/2 cursor-pointer bg-transparent ${
                active ? 'z-10' : 'z-0'
              }`}
              style={{ top: `${top}%` }}
            >
              <span
                className={`absolute left-0 right-0 top-1/2 h-[4px] -translate-y-1/2 border-y transition-all ${
                  active
                    ? 'bg-red-300 border-red-100 shadow-[0_0_0_1px_rgba(254,202,202,0.55)]'
                    : 'bg-red-500/85 border-red-300/40 hover:bg-red-400'
                }`}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CompareWorkspace({
  selectedDisplay,
  selectedDiffRows,
  activeDiffIndex,
  onJumpToDiff,
  leftPaneRef,
  rightPaneRef,
  onLeftScroll,
  onRightScroll,
  editingTarget,
  onEditLineChange,
  onEditLineKeyDown,
  virtualRange,
  expanded = false,
  onToggleExpand,
}) {
  const nativeAdditionHighlightRows = useMemo(
    () => buildNativeAdditionHighlightRows(selectedDiffRows, selectedDisplay?.referenceInfo),
    [selectedDiffRows, selectedDisplay?.referenceInfo]
  );
  const highlightSourceAdditions = nativeAdditionHighlightRows.size > 0;

  return (
    <div className="relative h-full min-h-0 flex-1 flex gap-0 overflow-hidden border border-slate-800 rounded-lg shadow-2xl">
      <ComparePane
        title="待合入资源包"
        badge={highlightSourceAdditions ? <span className="text-amber-300 text-[11px]">参考新增高亮</span> : <span className="text-blue-400 text-[11px]">GMS资源 Package</span>}
        rows={selectedDiffRows}
        side="right"
        highlightRowIndexes={nativeAdditionHighlightRows}
        paneRef={rightPaneRef}
        onScroll={onRightScroll}
        virtualRange={virtualRange}
      />
      <DiffOverviewBar
        rows={selectedDiffRows}
        activeIndex={activeDiffIndex}
        onJump={onJumpToDiff}
      />
      <ComparePane
        title="当前本地项目"
        badge={selectedDisplay.status === 'danger' ? <span className="bg-red-500/20 text-red-500 px-2 py-0.5 rounded text-[10px] border border-red-500/30">检测到冲突</span> : selectedDisplay.status === 'warning' ? <span className="bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded text-[10px] border border-amber-500/30">客制化参考</span> : null}
        rows={selectedDiffRows}
        side="left"
        paneRef={leftPaneRef}
        onScroll={onLeftScroll}
        editing={editingTarget}
        onLineChange={onEditLineChange}
        onLineKeyDown={onEditLineKeyDown}
        virtualRange={virtualRange}
      />
      <button
        onClick={onToggleExpand}
        className="absolute bottom-4 right-4 z-20 flex items-center gap-2 px-3 py-2 text-xs bg-slate-900/90 hover:bg-slate-800 text-white rounded-lg border border-slate-700 shadow-lg"
        title={expanded ? '退出放大查看' : '放大查看'}
      >
        {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        <span>{expanded ? '收起' : '放大查看'}</span>
      </button>
    </div>
  );
}

function CompareFullscreenOverlay({
  open,
  path,
  selectedDisplay,
  savingStatus,
  savingContent,
  historyLoading,
  canEditTarget,
  editingTarget,
  onToggleStatus,
  onOpenGitHistory,
  onStartEdit,
  onSaveEditedContent,
  onCancelEdit,
  onClose,
  children,
}) {
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/85 backdrop-blur-sm p-4">
      <div className="w-full h-full max-w-[96vw] max-h-[94vh] overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-2xl flex flex-col">
        <div className="px-5 py-3 border-b border-slate-800 bg-slate-900/90 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white truncate">{path}</div>
              <div className="text-[11px] text-slate-500">放大查看模式</div>
              {selectedDisplay?.reason && <div className="mt-1 text-xs text-slate-400 truncate">{selectedDisplay.reason}</div>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {selectedDisplay && (
                <DetailActionButtons
                  selectedDisplay={selectedDisplay}
                  savingStatus={savingStatus}
                  savingContent={savingContent}
                  historyLoading={historyLoading}
                  canEditTarget={canEditTarget}
                  editingTarget={editingTarget}
                  onToggleStatus={onToggleStatus}
                  onOpenGitHistory={onOpenGitHistory}
                  onStartEdit={onStartEdit}
                  onSaveEditedContent={onSaveEditedContent}
                  onCancelEdit={onCancelEdit}
                />
              )}
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-white rounded-lg border border-slate-700 flex items-center gap-2"
                title="收起"
              >
                <Minimize2 size={12} />
                收起
              </button>
            </div>
          </div>
        </div>
        <div className="flex-1 min-h-0 p-4 flex flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-screen bg-slate-900 text-white">
      <Loader2 className="w-12 h-12 animate-spin text-blue-500 mb-6" />
      <h2 className="text-2xl font-bold tracking-tight">正在扫描 GMS资源  资源包...</h2>
      <p className="text-slate-400 mt-2 font-mono">Scanning with current configured paths</p>
    </div>
  );
}

function NoteFullscreenOverlay({
  open,
  noteContent,
  noteError,
  noteLoading,
  noteSaving,
  onNoteChange,
  onNoteSave,
  onNoteRetry,
  onClose,
}) {
  if (!open) return null;

  const noteBusy = noteLoading || noteSaving;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/85 backdrop-blur-sm p-4">
      <div className="w-full h-full max-w-[92vw] max-h-[88vh] overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-2xl flex flex-col">
        <div className="px-5 py-3 border-b border-slate-800 bg-slate-900/90 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white">备注放大查看</div>
              <div className="text-[11px] text-slate-500">可在这里查看和编辑完整备注内容</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => copyTextWithFeedback(noteContent, '备注内容已复制')}
                disabled={noteBusy}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs font-medium text-slate-300 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Copy size={12} />
                复制
              </button>
              <button
                type="button"
                onClick={onNoteRetry}
                disabled={noteBusy}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs font-medium text-amber-200 transition hover:border-amber-400/40 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {noteLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                重试
              </button>
              <button
                type="button"
                onClick={onNoteSave}
                disabled={noteBusy || Boolean(noteError)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs font-medium text-slate-200 transition hover:border-emerald-400/40 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {noteBusy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                {noteLoading ? '加载中' : '保存'}
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-white rounded-lg border border-slate-700 flex items-center gap-2"
                title="收起"
              >
                <Minimize2 size={12} />
                收起
              </button>
            </div>
          </div>
        </div>
        {noteError ? (
          <div className="border-b border-amber-500/20 bg-amber-500/10 px-5 py-2 text-xs text-amber-100">
            {noteError}
          </div>
        ) : null}
        <div className="flex-1 min-h-0 p-4">
          <textarea
            value={noteContent || ''}
            onChange={onNoteChange}
            disabled={noteBusy}
            spellCheck={false}
            wrap="soft"
            className="h-full w-full resize-none rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm leading-6 text-red-400 font-mono outline-none transition placeholder:text-slate-500 focus:border-red-400/50 disabled:cursor-wait disabled:opacity-60"
            placeholder={noteLoading ? '正在读取备注...' : '输入需要保存到数据库的备注内容'}
          />
        </div>
      </div>
    </div>
  );
}

function NoteTypeManagerModal({
  open,
  activeType,
  noteTypeOptions,
  noteTypePending,
  newNoteTypeInput,
  onNewNoteTypeChange,
  onAdd,
  onDelete,
  onClose,
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4">
      <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">备注类型管理</h3>
            <p className="mt-1 text-xs text-slate-400">新增或删除 project_key，备注会按当前类型单独存储。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={noteTypePending}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 text-slate-400 transition hover:border-slate-500 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center gap-2">
            <input
              value={newNoteTypeInput}
              onChange={onNewNoteTypeChange}
              disabled={noteTypePending}
              className="h-10 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-amber-400/50 disabled:cursor-not-allowed disabled:opacity-60"
              placeholder="输入新的备注类型，例如 gms-mainline-v15"
            />
            <button
              type="button"
              onClick={onAdd}
              disabled={noteTypePending}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 transition hover:border-amber-400/40 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {noteTypePending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              新增
            </button>
          </div>

          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {noteTypeOptions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-400">
                还没有备注类型，请先新增一个。
              </div>
            ) : (
              noteTypeOptions.map((item) => (
                <div
                  key={item}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2.5 ${
                    item === activeType
                      ? 'border-amber-400/50 bg-amber-400/10'
                      : 'border-slate-800 bg-slate-950/60'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-100">{item}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{item === activeType ? '当前使用中' : '可切换使用'}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(item)}
                    disabled={noteTypePending}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs font-medium text-red-300 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Trash2 size={13} />
                    删除
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AppHeader({
  activeConfig,
  merging,
  noteProjectKeyInput,
  noteTypeOptions,
  noteContent,
  noteError,
  noteLoading,
  noteSaving,
  noteTypePending,
  onProjectKeyChange,
  onOpenNoteTypeManager,
  onOpenNoteExpand,
  onNoteChange,
  onNoteSave,
  onNoteRetry,
  onMergeAll,
}) {
  const noteBusy = noteLoading || noteSaving || noteTypePending;

  return (
    <header className="flex flex-col gap-4 px-6 py-4 bg-slate-900 border-b border-slate-800 shadow-xl shrink-0 xl:flex-row xl:items-center xl:justify-between">
      <div className="flex items-center gap-4 min-w-0">
        <div className="p-2.5 bg-indigo-600 rounded-xl shadow-lg shadow-indigo-500/20">
          <FileArchive size={24} className="text-white" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            GMS资源 自动合入助手
            <span className="text-[10px] bg-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded border border-indigo-500/30 font-medium">V2.0-OCT</span>
          </h1>
          <p className="text-xs text-slate-500 font-mono truncate">Target: {activeConfig.projectDir || '-'}</p>
        </div>
      </div>

      <div className="flex flex-col items-stretch gap-3 xl:flex-row xl:items-center xl:justify-end">
        <div className="flex min-h-15 flex-col justify-center gap-1 xl:w-[820px]">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs font-semibold tracking-[0.18em] text-amber-400">
              备注类型
            </span>
            <select
              value={noteProjectKeyInput || ''}
              onChange={onProjectKeyChange}
              disabled={noteBusy}
              className="h-10 w-[220px] shrink-0 rounded-lg border border-slate-700 bg-slate-950 px-3 text-xs text-amber-200 outline-none transition focus:border-amber-400/50 disabled:cursor-wait disabled:opacity-60"
            >
              <option value="">请选择备注类型</option>
              {noteTypeOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onOpenNoteTypeManager}
              disabled={noteBusy}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-300 transition hover:border-amber-400/40 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
              title="管理备注类型"
            >
              <Plus size={14} />
            </button>
            <span className="shrink-0 text-xs font-semibold tracking-[0.18em] text-red-400">
              备注
            </span>
            <div className="relative h-10 min-w-0 max-w-[50ch] flex-1">
              <textarea
                value={noteContent || ''}
                onChange={onNoteChange}
                disabled={noteBusy}
                spellCheck={false}
                rows={2}
                wrap="soft"
                className="h-10 w-full resize-none overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 pr-9 text-xs leading-5 text-red-400 font-mono outline-none transition placeholder:text-slate-500 focus:border-red-400/50 disabled:cursor-wait disabled:opacity-60 [&::-webkit-scrollbar]:hidden"
                placeholder={noteLoading ? '正在读取备注...' : '输入需要保存到数据库的备注内容'}
                style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
              />
              <button
                type="button"
                onClick={onOpenNoteExpand}
                disabled={noteBusy}
                className="absolute bottom-1 right-1 inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-700 bg-slate-900/90 text-slate-400 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                title="放大查看备注"
              >
                <Maximize2 size={11} />
              </button>
            </div>
            <button
              type="button"
              onClick={() => copyTextWithFeedback(noteContent, '备注内容已复制')}
              disabled={noteBusy}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-[11px] font-medium text-slate-300 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Copy size={12} />
              复制
            </button>
            <button
              type="button"
              onClick={onNoteSave}
              disabled={noteBusy || Boolean(noteError)}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-[11px] font-medium text-slate-200 transition hover:border-emerald-400/40 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {noteBusy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {noteLoading ? '加载中' : '保存'}
            </button>
          </div>
          {noteError ? (
            <div className="flex items-center gap-2 text-[11px] text-amber-200 xl:pl-[356px]">
              <span className="min-w-0 truncate">{noteError}</span>
              <button
                type="button"
                onClick={onNoteRetry}
                disabled={noteBusy}
                className="shrink-0 rounded border border-amber-400/30 px-2 py-0.5 text-amber-100 transition hover:border-amber-300/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                重试
              </button>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          disabled={merging || noteLoading}
          onClick={onMergeAll}
          className="flex h-15 items-center justify-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg font-bold transition-all shadow-lg shadow-blue-600/20 active:scale-95"
        >
          {merging ? <Loader2 className="animate-spin w-4 h-4" /> : <FileOutput size={18} />}
          执行代码合入
        </button>
      </div>
    </header>
  );
}

function PathConfigSection({
  sourceDirInput,
  projectDirInput,
  referenceCompareEnabled,
  referenceCompareRootInput,
  referenceCompareMonthInput,
  referenceCompareReport,
  activeConfig,
  configSaving,
  onSourceChange,
  onProjectChange,
  onReferenceCompareEnabledChange,
  onReferenceCompareRootChange,
  onReferenceCompareMonthChange,
  onSave,
}) {
  return (
    <section className="px-6 py-4 bg-slate-950 border-b border-slate-800 shrink-0">
      <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-widest text-slate-500">待合入资源包路径</span>
          <input value={sourceDirInput} onChange={onSourceChange} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500" placeholder="输入资源包目录" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-widest text-slate-500">当前本地项目路径</span>
          <input value={projectDirInput} onChange={onProjectChange} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500" placeholder="输入本地项目目录" />
        </label>
        <button disabled={configSaving} onClick={onSave} className="h-[42px] px-4 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg font-medium flex items-center gap-2">
          {configSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw size={16} />} 保存扫描
        </button>
      </div>
      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/35 px-4 py-3">
        <label className="flex items-center gap-2 text-xs font-semibold text-amber-200">
          <input
            type="checkbox"
            checked={referenceCompareEnabled}
            onChange={onReferenceCompareEnabledChange}
            className="h-4 w-4 rounded border-slate-600 bg-slate-950 accent-amber-500"
          />
          开启客制化参考对比
          <span className="text-[11px] font-normal text-slate-500">按月份目录识别上两月客制化差异和上月原生新增内容</span>
        </label>
        {referenceCompareEnabled && (
          <div className="mt-3 grid grid-cols-[1fr_180px] gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-widest text-slate-500">参考根目录</span>
              <input
                value={referenceCompareRootInput}
                onChange={onReferenceCompareRootChange}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-200 outline-none transition focus:border-amber-400/50"
                placeholder="/media/wsl/jixie/资源/"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-widest text-slate-500">当前月份</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{4}-\d{2}"
                value={referenceCompareMonthInput}
                onChange={onReferenceCompareMonthChange}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-200 outline-none transition focus:border-amber-400/50"
                placeholder="2026-05"
              />
            </label>
          </div>
        )}
        {referenceCompareReport?.enabled && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-amber-200">
              参考客制差异 {referenceCompareReport.customDiffCount || 0} 条
            </span>
            <span className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-amber-200">
              当前命中客制 {referenceCompareReport.customDiffMatchedCount || 0} 文件 / 黄色人工 {referenceCompareReport.customDiffWarningCount || 0}
            </span>
            <span className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-blue-200">
              参考原生新增 {referenceCompareReport.nativeAdditionCount || 0} 条
            </span>
            <span className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-blue-200">
              当前命中原生新增 {referenceCompareReport.nativeAdditionMatchedCount || 0} 文件
            </span>
            {(referenceCompareReport.warnings || []).map((warning) => (
              <span key={warning} className="rounded border border-red-500/20 bg-red-500/10 px-2 py-1 text-red-200">
                {warning}
              </span>
            ))}
          </div>
        )}
      <p className="mt-2 text-xs text-slate-500 font-mono">当前生效: Remark Type = {activeConfig.noteProjectKey || '-'} | Source = {activeConfig.sourceDir || '-'} | Project = {activeConfig.projectDir || '-'}</p>
      </div>
    </section>
  );
}

function FileSidebar({
  filter,
  visibleCount,
  manualReviewCount,
  dangerCount,
  warningCount,
  updateCount,
  searchTerm,
  onFilterChange,
  onSearchChange,
  groupedResults,
  expandedGroups,
  setExpandedGroups,
  selectedFile,
  onSelectFile,
  merging,
  onMergeGroup,
  scanning,
}) {
  return (
    <div className="w-80 border-r border-slate-800 flex flex-col bg-slate-900/30 shrink-0">
      <div className="p-4 bg-slate-900/50">
        <div className="grid grid-cols-4 gap-1 bg-slate-800 p-1 rounded-lg border border-slate-700 mb-3">
          <button onClick={() => onFilterChange('all')} className={`min-w-0 px-1.5 py-1.5 text-[11px] rounded-md transition-all ${filter === 'all' ? 'bg-slate-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}><span className="block leading-4">全部</span><span className="block font-mono text-[10px] opacity-80">{visibleCount}</span></button>
          <button onClick={() => onFilterChange('danger')} className={`min-w-0 px-1.5 py-1.5 text-[11px] rounded-md transition-all ${filter === 'danger' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}><span className="block leading-4">人工</span><span className="block font-mono text-[10px] opacity-80">{manualReviewCount}</span></button>
          <button onClick={() => onFilterChange('warning')} className={`min-w-0 px-1.5 py-1.5 text-[11px] rounded-md transition-all ${filter === 'warning' ? 'bg-amber-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}><span className="block leading-4">客制</span><span className="block font-mono text-[10px] opacity-80">{warningCount}</span></button>
          <button onClick={() => onFilterChange('update')} className={`min-w-0 px-1.5 py-1.5 text-[11px] rounded-md transition-all ${filter === 'update' ? 'bg-green-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}><span className="block leading-4">可合入</span><span className="block font-mono text-[10px] opacity-80">{updateCount}</span></button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-2.5 text-slate-500" size={14} />
          <input value={searchTerm} onChange={onSearchChange} placeholder="搜索文件路径..." className="w-full bg-slate-800 border border-slate-700 rounded-md py-2 pl-9 pr-4 text-xs focus:outline-none focus:border-blue-500 transition-colors placeholder:text-slate-600" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {scanning && groupedResults.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-500">
            <Loader2 className="w-6 h-6 animate-spin text-blue-400 mb-3" />
            <span className="text-xs">正在扫描文件...</span>
          </div>
        ) : groupedResults.length > 0 ? groupedResults.map((group) => (
          <div key={group.extension} className="border-b border-slate-800/40">
            <button onClick={() => setExpandedGroups((prev) => ({ ...prev, [group.extension]: !prev[group.extension] }))} className="w-full flex items-center justify-between px-4 py-3 bg-slate-900/40 hover:bg-slate-800/50 transition-colors text-left">
              <span className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                <ChevronRight size={14} className={`transition-transform ${expandedGroups[group.extension] ? 'rotate-90 text-blue-400' : 'text-slate-500'}`} />
                <span>{group.extension}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-[10px] text-slate-500 font-mono">{group.files.length}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => onMergeGroup(event, group)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      onMergeGroup(event, group);
                    }
                  }}
                  className={`px-2 py-1 rounded border text-[10px] font-semibold transition-colors ${
                    merging || group.files.every((item) => item.status !== 'update')
                      ? 'border-slate-700 text-slate-600 cursor-not-allowed'
                      : 'border-green-500/30 bg-green-500/10 text-green-300 hover:bg-green-500/20'
                  }`}
                >
                  合入本组
                </span>
              </span>
            </button>
            {expandedGroups[group.extension] && group.files.map((file) => (
              <div key={file.id} onClick={() => onSelectFile(file)} className={`group px-4 py-3 border-t border-slate-800/30 cursor-pointer transition-all ${selectedFile?.id === file.id ? 'bg-blue-600/10 border-l-4 border-l-blue-500' : 'hover:bg-slate-800/40 border-l-4 border-l-transparent'}`}>
                <div className="flex items-start gap-3">
                  <div className="mt-1">{file.type === 'bin' ? <FileDigit size={16} className="text-orange-400" /> : <FileCode size={16} className="text-blue-400" />}</div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[13px] font-medium truncate ${selectedFile?.id === file.id ? 'text-blue-400' : 'text-slate-300'}`}>{file.path.split('/').pop()}</p>
                    <p className="text-[10px] text-slate-500 truncate mt-0.5">{file.path}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-sm font-bold uppercase tracking-wider ${getStatusBadgeClass(file.status)}`}>
                        {getStatusBadgeLabel(file.status)}
                      </span>
                      <span className="text-[10px] text-slate-600 font-mono">{file.size}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )) : <div className="p-10 text-center text-slate-600 text-xs">{scanning ? '正在扫描...' : '没有找到匹配的文件'}</div>}
      </div>
    </div>
  );
}

function AppFooter({ visibleCount, sameCount, dangerCount, warningCount, updateCount }) {
  return (
    <footer className="px-6 py-2.5 bg-slate-900 border-t border-slate-800 flex justify-between items-center text-[11px] text-slate-500 font-mono shrink-0">
      <div className="flex items-center gap-6">
        <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-blue-500"></div> 扫描总数: {visibleCount}</span>
        <span className="flex items-center gap-1.5 text-slate-400"><div className="w-2 h-2 rounded-full bg-slate-500"></div> 相同文件: {sameCount}</span>
        <span className="flex items-center gap-1.5 text-red-400/80"><div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div> 风险拦截: {dangerCount}</span>
        <span className="flex items-center gap-1.5 text-amber-300/90"><div className="w-2 h-2 rounded-full bg-amber-400"></div> 客制参考: {warningCount}</span>
        <span className="flex items-center gap-1.5 text-green-400/80"><div className="w-2 h-2 rounded-full bg-green-500"></div> 安全可合入: {updateCount}</span>
      </div>
      <div className="flex items-center gap-4"><span className="bg-slate-800 px-2 py-0.5 rounded border border-slate-700">Session OK</span><span>{new Date().toLocaleTimeString()}</span></div>
    </footer>
  );
}

function OpenFileTabs({ openFiles, activePath, onSelect, onClose, onKeepOnlyActive }) {
  if (openFiles.length === 0) {
    return null;
  }

  return (
    <div className="px-4 pt-3 pb-2 border-b border-slate-800 bg-slate-950/80 shrink-0">
      <div className="flex items-center gap-2">
        <button
          onClick={onKeepOnlyActive}
          disabled={openFiles.length <= 1}
          className="shrink-0 px-3 py-2 text-[11px] rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          清除窗口
        </button>
        <div className="flex gap-2 overflow-x-auto custom-scrollbar min-w-0 flex-1">
        {openFiles.map((file) => {
          const isActive = file.path === activePath;
          return (
            <div
              key={file.path}
              className={`group flex items-center gap-2 min-w-0 max-w-xs rounded-lg border px-3 py-2 transition-colors ${
                isActive
                  ? 'bg-blue-500/18 border-blue-400/50 shadow-[0_0_0_1px_rgba(96,165,250,0.18)]'
                  : 'bg-slate-850 border-slate-700 hover:border-slate-500 hover:bg-slate-800/90'
              }`}
            >
              <button
                onClick={() => onSelect(file.path)}
                className="min-w-0 flex-1 text-left cursor-pointer"
                title={file.path}
              >
                <div className={`truncate text-[13px] font-semibold ${isActive ? 'text-blue-100' : 'text-slate-100'}`}>
                  {file.path.split('/').pop()}
                </div>
                <div className={`truncate text-[11px] ${isActive ? 'text-blue-100/85' : 'text-slate-300'}`}>{file.path}</div>
              </button>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(file.path);
                }}
                className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
                  isActive
                    ? 'border-blue-400/40 text-blue-200 hover:text-white hover:border-blue-300'
                    : 'border-slate-600 text-slate-300 hover:text-white hover:border-slate-400'
                }`}
                title="关闭"
              >
                x
              </button>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}

function DetailActionButtons({
  selectedDisplay,
  savingStatus,
  savingContent,
  historyLoading,
  canEditTarget,
  editingTarget,
  onToggleStatus,
  onOpenGitHistory,
  onStartEdit,
  onSaveEditedContent,
  onCancelEdit,
}) {
  return (
    <div className="flex gap-2 items-center flex-wrap justify-end">
      {isManualReviewStatus(selectedDisplay.status) ? (
        <button disabled={savingStatus || savingContent} onClick={() => onToggleStatus('update')} className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg">切回 Ready</button>
      ) : (
        <button disabled={savingStatus || savingContent} onClick={() => onToggleStatus('danger')} className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg">标记为 Danger</button>
      )}
      <button disabled={historyLoading} onClick={onOpenGitHistory} className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded-lg border border-slate-700 flex items-center gap-2">
        {historyLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCommitHorizontal size={12} />}
        提交记录
      </button>
      {canEditTarget && !editingTarget && (
        <button disabled={savingContent || savingStatus} onClick={onStartEdit} className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded-lg border border-slate-700 flex items-center gap-2">
          <Edit3 size={12} /> 编辑本地内容
        </button>
      )}
      {editingTarget && (
        <>
          <button disabled={savingContent} onClick={onSaveEditedContent} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg flex items-center gap-2">
            {savingContent ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save size={12} />} 保存修改
          </button>
          <button disabled={savingContent} onClick={onCancelEdit} className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded-lg border border-slate-700">
            取消编辑
          </button>
        </>
      )}
    </div>
  );
}

function renderCommitSubjectWithKeywordHighlight(subject = '') {
  const parts = String(subject).split(/(mainline|Package)/gi);
  return parts.map((part, index) => {
    const matched = /^(mainline|Package)$/i.test(part);
    return (
      <span
        key={`${subject}-${index}`}
        className={matched ? 'text-red-200 bg-red-500/20 rounded-sm px-0.5' : undefined}
      >
        {part}
      </span>
    );
  });
}

function GitPatchPreview({ detail, loading, error }) {
  if (loading) {
    return (
      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/70 px-4 py-4 text-sm text-slate-400 flex items-center gap-3">
        <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
        正在读取这笔提交的修改记录...
      </div>
    );
  }

  if (error) {
    return <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-4 text-sm text-red-300">{error}</div>;
  }

  if (!detail) {
    return null;
  }

  return (
    <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/70 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/70">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-mono text-blue-300 bg-blue-500/10 border border-blue-500/20 px-2 py-1 rounded">{detail.shortHash}</span>
          <span className="text-sm text-white">{renderCommitSubjectWithKeywordHighlight(detail.subject)}</span>
        </div>
        <div className="mt-2 flex items-center gap-4 flex-wrap text-[11px] text-slate-500 font-mono">
          <span>{detail.author}</span>
          <span>{detail.date}</span>
          <span className="break-all">{detail.hash}</span>
        </div>
        {detail.body && <div className="mt-3 whitespace-pre-wrap text-xs text-slate-400">{detail.body}</div>}
      </div>
      <div className="max-h-[42vh] overflow-auto custom-scrollbar bg-slate-950">
        <pre className="m-0 p-4 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words">
          {detail.patch.split('\n').map((line, index) => {
            const lineClass = line.startsWith('+++') || line.startsWith('---')
              ? 'text-blue-300'
              : line.startsWith('+')
                ? 'text-emerald-300'
                : line.startsWith('-')
                  ? 'text-red-300'
                  : line.startsWith('@@')
                    ? 'text-red-300'
                    : 'text-slate-400';

            return (
              <div key={`${detail.hash}-${index}`} className={lineClass}>
                {line || ' '}
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

function GitHistoryModal({
  open,
  path,
  loading,
  error,
  history,
  selectedCommitHash,
  detailLoading,
  detailError,
  commitDetail,
  onSelectCommit,
  onClose,
}) {
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-6">
      <div className="w-full max-w-5xl max-h-[85vh] overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-2xl">
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-800 bg-slate-900">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-white text-sm font-semibold">
              <GitCommitHorizontal size={16} className="text-blue-400" />
              <span>提交记录</span>
            </div>
            <div className="mt-1 text-xs text-slate-400 break-all">{path}</div>
            {history?.repoRelativePath && <div className="mt-1 text-[11px] text-slate-500 font-mono break-all">{history.repoRelativePath}</div>}
            {history?.remoteUrl && <div className="mt-1 text-[11px] text-slate-500 font-mono break-all">{history.remoteUrl}</div>}
          </div>
          <button onClick={onClose} className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-white rounded-lg border border-slate-700 shrink-0">
            关闭
          </button>
        </div>

        <div className="overflow-auto max-h-[calc(85vh-88px)] custom-scrollbar">
          {loading ? (
            <div className="px-6 py-10 text-sm text-slate-400 flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
              正在读取提交记录...
            </div>
          ) : error ? (
            <div className="px-6 py-10 text-sm text-red-300">{error}</div>
          ) : history?.commits?.length ? (
            <div className="divide-y divide-slate-800">
              {history.commits.map((commit) => (
                <div
                  key={commit.hash}
                  className={`px-5 py-4 transition-colors ${
                    selectedCommitHash === commit.hash ? 'bg-slate-900/60' : 'hover:bg-slate-900/30'
                  }`}
                >
                  <button
                    onClick={() => onSelectCommit(commit)}
                    className={`w-full text-left rounded-lg border px-3 py-3 transition-all cursor-pointer ${
                      selectedCommitHash === commit.hash
                        ? 'border-blue-500/30 bg-blue-500/10 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.12)]'
                        : 'border-transparent hover:border-slate-700/80 hover:bg-slate-900/50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 flex-wrap min-w-0">
                        <ChevronRight
                          size={14}
                          className={`shrink-0 transition-transform ${
                            selectedCommitHash === commit.hash ? 'rotate-90 text-blue-400' : 'text-slate-500'
                          }`}
                        />
                        <span className="text-xs font-mono text-blue-300 bg-blue-500/10 border border-blue-500/20 px-2 py-1 rounded">
                          {commit.shortHash}
                        </span>
                        <span className="text-sm text-white">{renderCommitSubjectWithKeywordHighlight(commit.subject)}</span>
                      </div>
                      <span className="text-[11px] text-slate-500 shrink-0">
                        {selectedCommitHash === commit.hash ? '收起' : '展开'}
                      </span>
                    </div>
                  </button>
                  <div className="mt-2 flex items-center gap-4 flex-wrap text-[11px] text-slate-500 font-mono px-3">
                    <span>{commit.author}</span>
                    <span>{commit.date}</span>
                    <span className="break-all">{commit.hash}</span>
                  </div>
                  {selectedCommitHash === commit.hash && (
                    <GitPatchPreview
                      detail={commitDetail}
                      loading={detailLoading}
                      error={detailError}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="px-6 py-10 text-sm text-slate-500">当前路径下没有找到这个文件的提交记录。</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [savingContent, setSavingContent] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [scanResults, setScanResults] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [openFilePaths, setOpenFilePaths] = useState([]);
  const [filter, setFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [fullContentMap, setFullContentMap] = useState({});
  const [expandedGroups, setExpandedGroups] = useState({});
  const [activeConfig, setActiveConfig] = useState({ sourceDir: '', projectDir: '', noteProjectKey: '', noteProjectKeys: [], referenceCompare: normalizeReferenceCompareConfig() });
  const [sourceDirInput, setSourceDirInput] = useState('');
  const [projectDirInput, setProjectDirInput] = useState('');
  const [referenceCompareEnabled, setReferenceCompareEnabled] = useState(false);
  const [referenceCompareRootInput, setReferenceCompareRootInput] = useState('');
  const [referenceCompareMonthInput, setReferenceCompareMonthInput] = useState('');
  const [referenceCompareReport, setReferenceCompareReport] = useState(null);
  const [noteProjectKeyInput, setNoteProjectKeyInput] = useState('');
  const [noteTypeOptions, setNoteTypeOptions] = useState([]);
  const [editingTarget, setEditingTarget] = useState(false);
  const [editableTargetContent, setEditableTargetContent] = useState('');
  const [pendingEditorSelection, setPendingEditorSelection] = useState(null);
  const [compareExpanded, setCompareExpanded] = useState(false);
  const [activeDiffIndex, setActiveDiffIndex] = useState(-1);
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);
  const [virtualViewportHeight, setVirtualViewportHeight] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [gitHistory, setGitHistory] = useState(null);
  const [selectedCommitHash, setSelectedCommitHash] = useState('');
  const [commitDetailLoading, setCommitDetailLoading] = useState(false);
  const [commitDetailError, setCommitDetailError] = useState('');
  const [commitDetail, setCommitDetail] = useState(null);
  const [headerNote, setHeaderNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteExpanded, setNoteExpanded] = useState(false);
  const [noteTypeManagerOpen, setNoteTypeManagerOpen] = useState(false);
  const [newNoteTypeInput, setNewNoteTypeInput] = useState('');
  const [noteTypePending, setNoteTypePending] = useState(false);
  const [scanning, setScanning] = useState(false);
  const leftPaneRef = useRef(null);
  const rightPaneRef = useRef(null);
  const syncingRef = useRef(false);

  const syncPane = (source, target) => {
    if (!source || !target) return;
    if (syncingRef.current) {
      syncingRef.current = false;
      return;
    }
    syncingRef.current = true;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
  };

  const applyScanResults = (normalized, preferredPath = null) => {
    setScanResults(normalized);
    setFullContentMap({});
    const nextSelected = preferredPath
      ? normalized.find((item) => item.path === preferredPath) || null
      : normalized.find((item) => item.status !== 'same') || null;
    const availablePaths = new Set(normalized.map((item) => item.path));
    setOpenFilePaths((previous) => {
      const filteredPaths = previous.filter((itemPath) => availablePaths.has(itemPath));
      if (nextSelected && !filteredPaths.includes(nextSelected.path)) {
        return [...filteredPaths, nextSelected.path];
      }
      return filteredPaths;
    });
    if (nextSelected) {
      const selectedGroup = getFileExtensionGroup(nextSelected.path);
      setExpandedGroups((prev) => ({ ...prev, [selectedGroup]: true }));
    }
    setSelectedFile(nextSelected);
  };

  const handleSelectFile = (file) => {
    setOpenFilePaths((previous) => (
      previous.includes(file.path) ? previous : [...previous, file.path]
    ));
    setSelectedFile(file);
    const selectedGroup = getFileExtensionGroup(file.path);
    setExpandedGroups((previous) => ({ ...previous, [selectedGroup]: true }));
  };

  const handleSelectOpenFile = (path) => {
    const matched = scanResults.find((item) => item.path === path);
    if (!matched) return;
    setSelectedFile(matched);
  };

  const handleCloseOpenFile = (path) => {
    setOpenFilePaths((previous) => {
      const index = previous.indexOf(path);
      const nextPaths = previous.filter((itemPath) => itemPath !== path);

      if (selectedFile?.path === path) {
        const fallbackPath = nextPaths[index] || nextPaths[index - 1] || null;
        const fallbackFile = fallbackPath ? scanResults.find((item) => item.path === fallbackPath) || null : null;
        setSelectedFile(fallbackFile);
      }

      return nextPaths;
    });
  };

  const handleKeepOnlyActiveOpenFile = () => {
    if (!selectedFile?.path) return;
    setOpenFilePaths([selectedFile.path]);
  };

  const fetchConfig = async () => {
    const res = await fetch('/api/config');
    const data = await readJsonResponse(res, '读取路径配置接口返回了非 JSON 响应，请检查后端服务');
    if (!res.ok) throw new Error(data.error || '读取路径配置失败');
    const referenceCompare = normalizeReferenceCompareConfig(data.referenceCompare);
    setActiveConfig({ ...data, referenceCompare });
    setSourceDirInput(data.sourceDir || '');
    setProjectDirInput(data.projectDir || '');
    setReferenceCompareEnabled(referenceCompare.enabled);
    setReferenceCompareRootInput(referenceCompare.rootDir);
    setReferenceCompareMonthInput(referenceCompare.month);
    setNoteProjectKeyInput(data.noteProjectKey || '');
    setNoteTypeOptions(data.noteProjectKeys || []);
    return { ...data, referenceCompare };
  };

  const fetchHeaderNote = async (config) => {
    const projectKey = config?.noteProjectKey || '';

    if (!projectKey) {
      setHeaderNote('');
      setNoteError('');
      return '';
    }

    try {
      setNoteLoading(true);
      setNoteError('');
      const query = new URLSearchParams({ projectKey });
      const res = await fetch(`/api/header-note?${query.toString()}`);
      const data = await readJsonResponse(res, '读取备注接口返回了非 JSON 响应，请检查后端服务');
      if (!res.ok) {
        throw new Error(data.error || '读取备注失败');
      }
      setHeaderNote(data.noteContent || '');
      return data.noteContent || '';
    } catch (err) {
      setNoteError(`备注读取失败，已保留当前显示内容。${err.message}`);
      return '';
    } finally {
      setNoteLoading(false);
    }
  };

  const fetchScanResults = async (preferredPath = null, options = {}) => {
    const query = options.resetManualStatuses ? '?reset_manual=1' : '';
    const res = await fetch(`/api/scan${query}`);
    const data = await readJsonResponse(res, '扫描接口返回了非 JSON 响应，请检查后端服务');
    if (!res.ok) throw new Error(data.error || '扫描失败');
    const items = Array.isArray(data) ? data : (data.items || []);
    setReferenceCompareReport(Array.isArray(data) ? null : data.referenceCompare || null);
    const normalized = items.map((item, index) => normalizeScanResultItem(item, index + 1));
    applyScanResults(normalized, preferredPath);
  };

  useEffect(() => {
    const init = async () => {
      try {
        setLoading(true);
        const config = await fetchConfig();
        await fetchHeaderNote(config);
        setLoading(false);
        try {
          setScanning(true);
          await fetchScanResults();
        } catch (scanErr) {
          alert(scanErr.message);
        } finally {
          setScanning(false);
        }
      } catch (err) {
        alert(err.message);
        setLoading(false);
      }
    };
    init();
  }, []);

  useEffect(() => {
    const fetchFullContent = async () => {
      if (!selectedFile || fullContentMap[selectedFile.path]) return;
      try {
        setContentLoading(true);
        const res = await fetch(`/api/file-content?path=${encodeURIComponent(selectedFile.path)}`);
        const data = await readJsonResponse(res, '读取文件内容接口返回了非 JSON 响应，请检查后端服务');
        if (!res.ok) throw new Error(data.error || '读取文件内容失败');
        setFullContentMap((prev) => ({
          ...prev,
          [selectedFile.path]: {
            sourceContent: data.sourceContent || '',
            targetContent: data.targetContent || '',
            targetExists: data.targetExists,
            contentType: data.contentType || 'text',
            editable: Boolean(data.editable),
          },
        }));
      } catch (err) {
        alert(`读取完整内容失败: ${err.message}`);
      } finally {
        setContentLoading(false);
      }
    };
    fetchFullContent();
  }, [fullContentMap, selectedFile]);

  const filteredResults = useMemo(() => {
    return scanResults.filter((item) => {
      if (item.status === 'same') return false;
      const matchesFilter = filter === 'all'
        || item.status === filter
        || (filter === 'danger' && isManualReviewStatus(item.status));
      return matchesFilter && item.path.toLowerCase().includes(searchTerm.toLowerCase());
    });
  }, [filter, scanResults, searchTerm]);

  const groupedResults = useMemo(() => {
    const groups = new Map();
    filteredResults.forEach((item) => {
      const extension = getFileExtensionGroup(item.path);
      if (!groups.has(extension)) groups.set(extension, []);
      groups.get(extension).push(item);
    });
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([extension, files]) => ({ extension, files }));
  }, [filteredResults]);

  useEffect(() => {
    setExpandedGroups((prev) => {
      const next = { ...prev };
      groupedResults.forEach((group) => {
        if (!(group.extension in next)) next[group.extension] = false;
      });
      return next;
    });
  }, [groupedResults]);

  const {
    visibleCount,
    sameCount,
    dangerCount,
    warningCount,
    updateCount,
  } = useMemo(() => summarizeScanResults(scanResults), [scanResults]);
  const manualReviewCount = dangerCount + warningCount;

  const selectedDisplay = useMemo(() => {
    if (!selectedFile) return null;
    const fullContent = fullContentMap[selectedFile.path];
    if (!fullContent) return selectedFile;
    return {
      ...selectedFile,
      contentType: fullContent.contentType || selectedFile.type,
      editable: Boolean(fullContent.editable),
      content: fullContent.sourceContent,
      target: {
        ...selectedFile.target,
        content: fullContent.targetContent,
        exists: fullContent.targetExists,
      },
    };
  }, [fullContentMap, selectedFile]);

  useEffect(() => {
    setEditingTarget(false);
    setEditableTargetContent(selectedDisplay?.target?.content || '');
    setPendingEditorSelection(null);
    setActiveDiffIndex(-1);
    setVirtualScrollTop(0);
    setHistoryOpen(false);
    setHistoryLoading(false);
    setHistoryError('');
    setGitHistory(null);
    setSelectedCommitHash('');
    setCommitDetailLoading(false);
    setCommitDetailError('');
    setCommitDetail(null);
  }, [selectedDisplay?.path]);

  const canCompareAsText = Boolean(selectedDisplay && (selectedDisplay.type === 'text' || selectedDisplay.contentType === 'binary-dump'));
  const canEditTarget = Boolean(selectedDisplay && isManualReviewStatus(selectedDisplay.status) && selectedDisplay.editable);

  const selectedDiffState = useMemo(() => {
    if (!canCompareAsText || !selectedDisplay) {
      return { rows: [], lightweight: false, traceFocused: false };
    }

    const leftContent = editingTarget ? editableTargetContent : selectedDisplay.target?.content || '';
    const rightContent = selectedDisplay.content || '';
    const lightweight = shouldUseLightweightDiff(leftContent, rightContent);
    const traceFocused = lightweight && selectedDisplay.status === 'danger' && selectedDisplay.reason.includes('[GMS]');

    return {
      rows: traceFocused
        ? buildTraceFocusedRows(leftContent, rightContent)
        : lightweight
          ? buildLightweightDiffRows(leftContent, rightContent)
          : buildDiffRows(leftContent, rightContent),
      lightweight,
      traceFocused,
    };
  }, [canCompareAsText, editableTargetContent, editingTarget, selectedDisplay]);

  const selectedDiffRows = selectedDiffState.rows;
  const useVirtualizedRows = selectedDiffState.lightweight && selectedDiffRows.length > 2000;

  const virtualRange = useMemo(() => {
    if (!useVirtualizedRows) {
      return null;
    }

    const visibleCount = Math.max(Math.ceil((virtualViewportHeight || 0) / VIRTUAL_ROW_HEIGHT), 1);
    const start = Math.max(Math.floor(virtualScrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN, 0);
    const end = Math.min(start + visibleCount + (VIRTUAL_OVERSCAN * 2), selectedDiffRows.length);
    return { start, end };
  }, [selectedDiffRows.length, useVirtualizedRows, virtualScrollTop, virtualViewportHeight]);

  const diffMarkerRows = useMemo(() => (
    selectedDiffRows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.type !== 'same' && row.type !== 'gap')
  ), [selectedDiffRows]);

  const updateActiveDiffIndexFromScroll = (scrollTop) => {
    if (diffMarkerRows.length === 0) {
      if (activeDiffIndex !== -1) setActiveDiffIndex(-1);
      return;
    }

    const pane = leftPaneRef.current;
    const viewportAnchor = scrollTop + ((pane?.clientHeight || 0) / 2);
    let nearestIndex = diffMarkerRows[0].index;
    let nearestDistance = Number.POSITIVE_INFINITY;

    diffMarkerRows.forEach(({ index }) => {
      const nodeMiddle = (index * VIRTUAL_ROW_HEIGHT) + (VIRTUAL_ROW_HEIGHT / 2);
      const distance = Math.abs(nodeMiddle - viewportAnchor);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    if (nearestIndex !== activeDiffIndex) {
      setActiveDiffIndex(nearestIndex);
    }
  };

  const handleJumpToDiff = (index) => {
    const leftPane = leftPaneRef.current;
    const rightPane = rightPaneRef.current;
    if (!leftPane || !rightPane) return;

    const targetTop = Math.max(
      (index * VIRTUAL_ROW_HEIGHT) - (leftPane.clientHeight / 2) + (VIRTUAL_ROW_HEIGHT / 2),
      0
    );
    leftPane.scrollTop = targetTop;
    rightPane.scrollTop = targetTop;
    setVirtualScrollTop(targetTop);
    setActiveDiffIndex(index);
  };

  const handleLeftPaneScroll = (event) => {
    syncPane(event.currentTarget, rightPaneRef.current);
    setVirtualScrollTop(event.currentTarget.scrollTop);
    setVirtualViewportHeight(event.currentTarget.clientHeight);
    updateActiveDiffIndexFromScroll(event.currentTarget.scrollTop);
  };

  const handleRightPaneScroll = (event) => {
    syncPane(event.currentTarget, leftPaneRef.current);
    setVirtualScrollTop(event.currentTarget.scrollTop);
    setVirtualViewportHeight(event.currentTarget.clientHeight);
    updateActiveDiffIndexFromScroll(event.currentTarget.scrollTop);
  };

  useEffect(() => {
    if (!canCompareAsText || editingTarget) return;
    const timer = window.requestAnimationFrame(() => {
      setVirtualViewportHeight(leftPaneRef.current?.clientHeight || 0);
      updateActiveDiffIndexFromScroll(leftPaneRef.current?.scrollTop || 0);
    });
    return () => window.cancelAnimationFrame(timer);
  }, [canCompareAsText, compareExpanded, editingTarget, selectedDiffRows]);

  const refreshCurrentFile = async () => {
    await fetchScanResults(selectedFile?.path || null);
  };

  const handleSaveConfig = async () => {
    try {
      setConfigSaving(true);
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceDir: sourceDirInput,
          projectDir: projectDirInput,
          referenceCompare: {
            enabled: referenceCompareEnabled,
            rootDir: referenceCompareRootInput,
            month: referenceCompareMonthInput,
          },
          noteProjectKey: noteProjectKeyInput,
          noteProjectKeys: noteTypeOptions,
        }),
      });
      const data = await readJsonResponse(res, '保存路径接口返回了非 JSON 响应，请检查后端服务');
      if (!res.ok) throw new Error(data.error || '保存路径失败');
      const referenceCompare = normalizeReferenceCompareConfig(data.referenceCompare);
      setActiveConfig({ ...data, referenceCompare, manualStatuses: {} });
      setReferenceCompareEnabled(referenceCompare.enabled);
      setReferenceCompareRootInput(referenceCompare.rootDir);
      setReferenceCompareMonthInput(referenceCompare.month);
      setNoteProjectKeyInput(data.noteProjectKey || '');
      setNoteTypeOptions(data.noteProjectKeys || []);
      await fetchHeaderNote(data);
      try {
        setScanning(true);
        await fetchScanResults(selectedFile?.path || null, { resetManualStatuses: true });
      } finally {
        setScanning(false);
      }
      alert('路径已保存并扫描完成。');
    } catch (err) {
      alert(`保存扫描失败: ${err.message}`);
    } finally {
      setConfigSaving(false);
    }
  };

  const handleRescan = async () => {
    try {
      setScanning(true);
      setActiveConfig((previous) => ({ ...previous, manualStatuses: {} }));
      await fetchScanResults(selectedFile?.path || null, { resetManualStatuses: true });
    } catch (err) {
      alert(`重新扫描失败: ${err.message}`);
    } finally {
      setScanning(false);
    }
  };

  const handleMergeFiles = async (filesToMerge, label = '选中文件') => {
    try {
      setMerging(true);
      if (filesToMerge.length === 0) {
        alert(`${label} 没有可自动合入的文件。`);
        return;
      }

      const res = await fetch('/api/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filesToMerge }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '合入失败');
      alert(`${label} 合入完成\n\n${data.log.join('\n')}`);
      await refreshCurrentFile();
    } catch (err) {
      alert(`合入失败: ${err.message}`);
    } finally {
      setMerging(false);
    }
  };

  const handleMergeAction = async () => {
    const filesToMerge = scanResults.filter((item) => item.status === 'update').map((item) => item.path);
    await handleMergeFiles(filesToMerge, '全部 Ready 文件');
  };

  const handleSaveHeaderNote = async () => {
    const effectiveProjectKey = noteProjectKeyInput.trim() || activeConfig.noteProjectKey || '';

    if (!effectiveProjectKey) {
      alert('请先选择备注类型，再保存备注。');
      return;
    }

    if (!activeConfig.sourceDir || !activeConfig.projectDir) {
      alert('当前还没有可用的扫描路径，无法保存备注。');
      return;
    }

    try {
      setNoteSaving(true);
      const res = await fetch('/api/header-note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectKey: effectiveProjectKey,
          sourceDir: activeConfig.sourceDir,
          projectDir: activeConfig.projectDir,
          noteContent: headerNote,
        }),
      });
      const data = await readJsonResponse(res, '保存备注接口返回了非 JSON 响应，请检查后端服务');
      if (!res.ok) throw new Error(data.error || '保存备注失败');
      setHeaderNote(data.noteContent || '');
      setNoteError('');
      alert('备注已保存到数据库。');
    } catch (err) {
      alert(`保存备注失败: ${err.message}`);
    } finally {
      setNoteSaving(false);
    }
  };

  const handleRetryHeaderNote = async () => {
    await fetchHeaderNote({
      ...activeConfig,
      noteProjectKey: noteProjectKeyInput || activeConfig.noteProjectKey,
    });
  };

  const applyNoteTypeConfig = (config) => {
    setActiveConfig((previous) => ({
      ...previous,
      noteProjectKey: config.noteProjectKey || '',
      noteProjectKeys: config.noteProjectKeys || [],
    }));
    setNoteProjectKeyInput(config.noteProjectKey || '');
    setNoteTypeOptions(config.noteProjectKeys || []);
  };

  const handleNoteTypeChange = async (event) => {
    const nextProjectKey = event.target.value;
    setNoteProjectKeyInput(nextProjectKey);
    setActiveConfig((previous) => ({ ...previous, noteProjectKey: nextProjectKey }));

    try {
      setNoteTypePending(true);
      const res = await fetch('/api/note-types/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectKey: nextProjectKey }),
      });
      const data = await readJsonResponse(res, '切换备注类型接口返回了非 JSON 响应，请检查后端服务');
      if (!res.ok) throw new Error(data.error || '切换备注类型失败');
      applyNoteTypeConfig(data);
      await fetchHeaderNote({
        noteProjectKey: data.noteProjectKey,
        sourceDir: activeConfig.sourceDir,
        projectDir: activeConfig.projectDir,
      });
    } catch (err) {
      alert(`切换备注类型失败: ${err.message}`);
      const config = await fetchConfig();
      await fetchHeaderNote(config);
    } finally {
      setNoteTypePending(false);
    }
  };

  const handleAddNoteType = async () => {
    const projectKey = newNoteTypeInput.trim();
    if (!projectKey) {
      alert('请先输入备注类型。');
      return;
    }

    try {
      setNoteTypePending(true);
      const res = await fetch('/api/note-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectKey }),
      });
      const data = await readJsonResponse(res, '新增备注类型接口返回了非 JSON 响应，请检查后端服务');
      if (!res.ok) throw new Error(data.error || '新增备注类型失败');
      applyNoteTypeConfig(data);
      setNewNoteTypeInput('');
      await fetchHeaderNote({
        noteProjectKey: data.noteProjectKey,
        sourceDir: activeConfig.sourceDir,
        projectDir: activeConfig.projectDir,
      });
    } catch (err) {
      alert(`新增备注类型失败: ${err.message}`);
    } finally {
      setNoteTypePending(false);
    }
  };

  const handleDeleteNoteType = async (projectKey) => {
    if (!projectKey) {
      return;
    }

    const confirmed = window.confirm(`确认删除备注类型“${projectKey}”吗？这会同时删除该类型下保存的备注内容。`);
    if (!confirmed) {
      return;
    }

    try {
      setNoteTypePending(true);
      const res = await fetch(`/api/note-types?projectKey=${encodeURIComponent(projectKey)}`, {
        method: 'DELETE',
      });
      const data = await readJsonResponse(res, '删除备注类型接口返回了非 JSON 响应，请检查后端服务');
      if (!res.ok) throw new Error(data.error || '删除备注类型失败');
      applyNoteTypeConfig(data);
      await fetchHeaderNote({
        noteProjectKey: data.noteProjectKey,
        sourceDir: activeConfig.sourceDir,
        projectDir: activeConfig.projectDir,
      });
    } catch (err) {
      alert(`删除备注类型失败: ${err.message}`);
    } finally {
      setNoteTypePending(false);
    }
  };

  const handleMergeGroup = async (event, group) => {
    event.stopPropagation();
    if (merging) return;
    const filesToMerge = group.files.filter((item) => item.status === 'update').map((item) => item.path);
    await handleMergeFiles(filesToMerge, `${group.extension} 类型文件`);
  };

  const applyLocalStatusOverride = (path, nextStatus) => {
    const updateReason = (currentReason = '') => {
      const strippedReason = currentReason
        .replace(/^手动标记为人工接入。/, '')
        .replace(/^手动标记为可合入。/, '');

      if (nextStatus === 'danger') {
        return `手动标记为人工接入。${strippedReason}`;
      }

      if (nextStatus === 'update') {
        return `手动标记为可合入。${strippedReason}`;
      }

      return strippedReason;
    };

    setScanResults((previous) => previous.map((item) => (
      item.path === path
        ? {
            ...item,
            status: nextStatus,
            manualStatus: nextStatus,
            reason: updateReason(item.reason),
          }
        : item
    )));

    setSelectedFile((previous) => (
      previous?.path === path
        ? {
            ...previous,
            status: nextStatus,
            manualStatus: nextStatus,
            reason: updateReason(previous.reason),
          }
        : previous
    ));
  };

  const handleToggleStatus = async (nextStatus) => {
    if (!selectedDisplay) return;
    try {
      flushSync(() => setSavingStatus(true));
      const res = await fetch('/api/status-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedDisplay.path, status: nextStatus }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '切换状态失败');
      applyLocalStatusOverride(selectedDisplay.path, nextStatus);
    } catch (err) {
      alert(`切换状态失败: ${err.message}`);
    } finally {
      setSavingStatus(false);
    }
  };

  const handleSaveEditedContent = async () => {
    if (!selectedDisplay) return;
    try {
      flushSync(() => setSavingContent(true));
      const res = await fetch('/api/file-content/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedDisplay.path, targetContent: editableTargetContent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存内容失败');
      setEditingTarget(false);
      if (data.item) {
        const normalizedItem = normalizeScanResultItem(data.item, selectedFile?.id || 1);
        setScanResults((previous) => previous.map((item) => (
          item.path === normalizedItem.path ? { ...item, ...normalizedItem } : item
        )));
        setSelectedFile((previous) => (
          previous?.path === normalizedItem.path ? { ...previous, ...normalizedItem } : previous
        ));
      }
      if (data.fullContent && selectedDisplay.path) {
        setFullContentMap((previous) => ({
          ...previous,
          [selectedDisplay.path]: data.fullContent,
        }));
      }
    } catch (err) {
      alert(`保存内容失败: ${err.message}`);
    } finally {
      setSavingContent(false);
    }
  };

  const handleEditLineChange = (lineNumber, nextText) => {
    if (!lineNumber) return;

    setEditableTargetContent((previousContent) => {
      const lines = splitLines(previousContent);
      const nextLines = [...lines];
      nextLines[lineNumber - 1] = nextText;
      return nextLines.join('\n');
    });
  };

  const handleEditLineKeyDown = (lineNumber, event) => {
    if (!lineNumber) return;

    const { key, currentTarget } = event;
    const { selectionStart, selectionEnd, value } = currentTarget;

    if (key === 'Enter') {
      event.preventDefault();
      setEditableTargetContent((previousContent) => {
        const lines = splitLines(previousContent);
        const currentLine = lines[lineNumber - 1] ?? '';
        const nextLines = [...lines];
        nextLines.splice(
          lineNumber - 1,
          1,
          currentLine.slice(0, selectionStart),
          currentLine.slice(selectionEnd)
        );
        return nextLines.join('\n');
      });
      setPendingEditorSelection({ lineNumber: lineNumber + 1, caret: 0 });
      return;
    }

    if (key === 'Backspace' && selectionStart === 0 && selectionEnd === 0) {
      if (lineNumber === 1 && value === '') {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      setEditableTargetContent((previousContent) => {
        const lines = splitLines(previousContent);
        const nextLines = [...lines];

        if (value === '') {
          nextLines.splice(lineNumber - 1, 1);
          return nextLines.join('\n');
        }

        const previousLine = nextLines[lineNumber - 2] ?? '';
        nextLines.splice(lineNumber - 2, 2, previousLine + value);
        return nextLines.join('\n');
      });
      const previousLineNumber = Math.max(lineNumber - 1, 1);
      const previousLineLength = splitLines(editableTargetContent)[previousLineNumber - 1]?.length ?? 0;
      setPendingEditorSelection({ lineNumber: previousLineNumber, caret: previousLineLength });
      return;
    }

    if (key === 'Delete' && selectionStart === value.length && selectionEnd === value.length) {
      const lines = splitLines(editableTargetContent);
      if (lineNumber >= lines.length) {
        return;
      }

      event.preventDefault();
      const currentLineLength = value.length;
      setEditableTargetContent((previousContent) => {
        const previousLines = splitLines(previousContent);
        const nextLines = [...previousLines];
        const nextLine = nextLines[lineNumber] ?? '';
        nextLines.splice(lineNumber - 1, 2, value + nextLine);
        return nextLines.join('\n');
      });
      setPendingEditorSelection({ lineNumber, caret: currentLineLength });
      return;
    }

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const lines = splitLines(editableTargetContent);
      const targetLineNumber = key === 'ArrowUp' ? lineNumber - 1 : lineNumber + 1;

      if (targetLineNumber < 1 || targetLineNumber > lines.length) {
        return;
      }

      event.preventDefault();
      const targetLineLength = lines[targetLineNumber - 1]?.length ?? 0;
      const caret = Math.min(selectionStart, targetLineLength);
      setPendingEditorSelection({ lineNumber: targetLineNumber, caret });
    }
  };

  useEffect(() => {
    if (!editingTarget || !pendingEditorSelection) return;
    const timer = window.requestAnimationFrame(() => {
      const textarea = leftPaneRef.current?.querySelector(
        `[data-edit-line-number="${pendingEditorSelection.lineNumber}"]`
      );
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(pendingEditorSelection.caret, pendingEditorSelection.caret);
      setPendingEditorSelection(null);
    });

    return () => window.cancelAnimationFrame(timer);
  }, [editingTarget, pendingEditorSelection, selectedDiffRows]);

  const handleOpenGitHistory = async () => {
    if (!selectedDisplay?.path) return;
    try {
      setHistoryOpen(true);
      setHistoryLoading(true);
      setHistoryError('');
      setSelectedCommitHash('');
      setCommitDetailLoading(false);
      setCommitDetailError('');
      setCommitDetail(null);
      const res = await fetch(`/api/git-history?path=${encodeURIComponent(selectedDisplay.path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '读取提交记录失败');
      setGitHistory(data);
    } catch (err) {
      setGitHistory(null);
      setHistoryError(err.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleSelectCommit = async (commit) => {
    if (!selectedDisplay?.path || !commit?.hash) return;

    if (selectedCommitHash === commit.hash) {
      setSelectedCommitHash('');
      setCommitDetailLoading(false);
      setCommitDetailError('');
      setCommitDetail(null);
      return;
    }

    try {
      setSelectedCommitHash(commit.hash);
      setCommitDetailLoading(true);
      setCommitDetailError('');
      setCommitDetail(null);
      const res = await fetch(`/api/git-history/detail?path=${encodeURIComponent(selectedDisplay.path)}&commit=${encodeURIComponent(commit.hash)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '读取提交详情失败');
      setCommitDetail(data);
    } catch (err) {
      setCommitDetail(null);
      setCommitDetailError(err.message);
    } finally {
      setCommitDetailLoading(false);
    }
  };

  if (loading) {
    return <LoadingScreen />;
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans">
      <AppHeader
        activeConfig={activeConfig}
        merging={merging}
        noteProjectKeyInput={noteProjectKeyInput}
        noteTypeOptions={noteTypeOptions}
        noteContent={headerNote}
        noteError={noteError}
        noteLoading={noteLoading}
        noteSaving={noteSaving}
        noteTypePending={noteTypePending}
        onProjectKeyChange={handleNoteTypeChange}
        onOpenNoteTypeManager={() => setNoteTypeManagerOpen(true)}
        onOpenNoteExpand={() => setNoteExpanded(true)}
        onNoteChange={(event) => setHeaderNote(event.target.value)}
        onNoteSave={handleSaveHeaderNote}
        onNoteRetry={handleRetryHeaderNote}
        onMergeAll={handleMergeAction}
      />
      <PathConfigSection
        sourceDirInput={sourceDirInput}
        projectDirInput={projectDirInput}
        referenceCompareEnabled={referenceCompareEnabled}
        referenceCompareRootInput={referenceCompareRootInput}
        referenceCompareMonthInput={referenceCompareMonthInput}
        referenceCompareReport={referenceCompareReport}
        activeConfig={activeConfig}
        configSaving={configSaving}
        onSourceChange={(e) => setSourceDirInput(e.target.value)}
        onProjectChange={(e) => setProjectDirInput(e.target.value)}
        onReferenceCompareEnabledChange={(e) => setReferenceCompareEnabled(e.target.checked)}
        onReferenceCompareRootChange={(e) => setReferenceCompareRootInput(e.target.value)}
        onReferenceCompareMonthChange={(e) => setReferenceCompareMonthInput(e.target.value)}
        onSave={handleSaveConfig}
      />
      <NoteTypeManagerModal
        open={noteTypeManagerOpen}
        activeType={noteProjectKeyInput}
        noteTypeOptions={noteTypeOptions}
        noteTypePending={noteTypePending}
        newNoteTypeInput={newNoteTypeInput}
        onNewNoteTypeChange={(event) => setNewNoteTypeInput(event.target.value)}
        onAdd={handleAddNoteType}
        onDelete={handleDeleteNoteType}
        onClose={() => {
          if (noteTypePending) return;
          setNoteTypeManagerOpen(false);
          setNewNoteTypeInput('');
        }}
      />
      <NoteFullscreenOverlay
        open={noteExpanded}
        noteContent={headerNote}
        noteError={noteError}
        noteLoading={noteLoading}
        noteSaving={noteSaving}
        onNoteChange={(event) => setHeaderNote(event.target.value)}
        onNoteSave={handleSaveHeaderNote}
        onNoteRetry={handleRetryHeaderNote}
        onClose={() => setNoteExpanded(false)}
      />

      <main className="flex flex-1 overflow-hidden">
        <FileSidebar
          filter={filter}
          visibleCount={visibleCount}
          manualReviewCount={manualReviewCount}
          dangerCount={dangerCount}
          warningCount={warningCount}
          updateCount={updateCount}
          searchTerm={searchTerm}
          onFilterChange={setFilter}
          onSearchChange={(e) => setSearchTerm(e.target.value)}
          groupedResults={groupedResults}
          expandedGroups={expandedGroups}
          setExpandedGroups={setExpandedGroups}
          selectedFile={selectedFile}
          onSelectFile={handleSelectFile}
          merging={merging}
          onMergeGroup={handleMergeGroup}
          scanning={scanning}
        />

        <div className="flex-1 flex flex-col bg-slate-950 overflow-hidden">
          <OpenFileTabs
            openFiles={openFilePaths
              .map((path) => scanResults.find((item) => item.path === path))
              .filter(Boolean)}
            activePath={selectedFile?.path || ''}
            onSelect={handleSelectOpenFile}
            onClose={handleCloseOpenFile}
            onKeepOnlyActive={handleKeepOnlyActiveOpenFile}
          />
          {selectedDisplay ? (
            <>
              <div className="px-6 py-4 bg-slate-900 border-b border-slate-800 flex items-start justify-between gap-4 shrink-0">
                <div className="flex flex-col min-w-0">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2 break-all">
                    {selectedDisplay.path}
                    {selectedDisplay.status === 'danger' && <ShieldAlert size={16} className="text-red-500 shrink-0" />}
                    {selectedDisplay.status === 'warning' && <ShieldAlert size={16} className="text-amber-300 shrink-0" />}
                  </h3>
                  <p className={`text-xs mt-1 ${selectedDisplay.status === 'danger' ? 'text-red-400 font-medium' : selectedDisplay.status === 'warning' ? 'text-amber-300 font-medium' : 'text-slate-400'}`}>{selectedDisplay.reason}</p>
                  {selectedDisplay.referenceInfo && (
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                      {selectedDisplay.referenceInfo.customDiffs?.map((item, index) => (
                        <span key={`custom-${item.month}-${index}`} className="rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-amber-200">
                          {item.month} 客制差异: {item.pair?.join(' vs ')}
                        </span>
                      ))}
                      {selectedDisplay.referenceInfo.nativeAdditions?.map((item, index) => (
                        <span key={`native-${item.month}-${index}`} className="rounded border border-blue-500/25 bg-blue-500/10 px-2 py-1 text-blue-200">
                          {item.month} 原生新增: {item.pair?.join(' -> ')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <DetailActionButtons
                    selectedDisplay={selectedDisplay}
                    savingStatus={savingStatus}
                    savingContent={savingContent}
                    historyLoading={historyLoading}
                    canEditTarget={canEditTarget}
                    editingTarget={editingTarget}
                    onToggleStatus={handleToggleStatus}
                    onOpenGitHistory={handleOpenGitHistory}
                    onStartEdit={() => setEditingTarget(true)}
                    onSaveEditedContent={handleSaveEditedContent}
                    onCancelEdit={() => {
                      setEditingTarget(false);
                      setEditableTargetContent(selectedDisplay.target?.content || '');
                    }}
                  />
                  <div className="flex gap-2 items-center">
                    {(contentLoading || savingStatus || savingContent) && <div className="text-xs text-blue-300 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> 页面实时刷新中</div>}
                    {selectedDiffState.traceFocused && <div className="text-xs text-red-300 flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded"><span className="w-2 h-2 rounded-full bg-red-400" /> 修改痕迹聚焦模式</div>}
                    {!selectedDiffState.traceFocused && selectedDiffState.lightweight && <div className="text-xs text-red-300 flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded"><span className="w-2 h-2 rounded-full bg-red-400" /> 大文件轻量对比模式</div>}
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 rounded border border-slate-700 text-[11px]"><Clock size={12} className="text-slate-500" /><span className="text-slate-400">资源日期:</span><span className="text-white font-mono">{selectedDisplay.mtime}</span></div>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-hidden flex flex-col p-5 gap-4">
                {!canCompareAsText ? (
                  <div className="flex-1 flex items-center justify-center border-2 border-dashed border-slate-800 rounded-xl bg-slate-900/20">
                    <div className="text-center max-w-2xl px-8">
                      <FileArchive size={80} className="mx-auto text-slate-700 mb-4 opacity-50" />
                      <h4 className="text-lg font-bold text-slate-400">当前文件正在准备比较内容</h4>
                    </div>
                  </div>
                ) : compareExpanded ? (
                  <div className="flex-1 flex items-center justify-center border border-slate-800 rounded-lg bg-slate-900/30 text-slate-500 text-sm">
                    当前对比已切换到放大查看窗口
                  </div>
                ) : (
                  <CompareWorkspace
                    selectedDisplay={selectedDisplay}
                    selectedDiffRows={selectedDiffRows}
                    activeDiffIndex={activeDiffIndex}
                    onJumpToDiff={handleJumpToDiff}
                    leftPaneRef={leftPaneRef}
                    rightPaneRef={rightPaneRef}
                    onLeftScroll={handleLeftPaneScroll}
                    onRightScroll={handleRightPaneScroll}
                    editingTarget={editingTarget}
                    onEditLineChange={handleEditLineChange}
                    onEditLineKeyDown={handleEditLineKeyDown}
                    virtualRange={virtualRange}
                    expanded={false}
                    onToggleExpand={() => setCompareExpanded(true)}
                  />
                )}

                <div className={`p-4 rounded-xl flex items-center justify-between border-2 shrink-0 ${selectedDisplay.status === 'danger' ? 'bg-red-500/5 border-red-500/20' : selectedDisplay.status === 'warning' ? 'bg-amber-500/5 border-amber-500/20' : selectedDisplay.status === 'safe' ? 'bg-red-500/5 border-red-500/20' : 'bg-green-500/5 border-green-500/20'}`}>
                  <div className="flex items-center gap-4">
                    <div className={`p-2 rounded-full ${selectedDisplay.status === 'danger' ? 'bg-red-500/20' : selectedDisplay.status === 'warning' ? 'bg-amber-500/20' : selectedDisplay.status === 'safe' ? 'bg-red-500/20' : 'bg-green-500/20'}`}>
                      {selectedDisplay.status === 'danger' ? <XCircle className="text-red-500" size={24} /> : selectedDisplay.status === 'warning' ? <ShieldAlert className="text-amber-300" size={24} /> : <CheckCircle2 className={`${selectedDisplay.status === 'safe' ? 'text-red-400' : 'text-green-500'}`} size={24} />}
                    </div>
                    <div>
                      <h4 className={`text-sm font-bold ${selectedDisplay.status === 'danger' ? 'text-red-400' : selectedDisplay.status === 'warning' ? 'text-amber-300' : selectedDisplay.status === 'safe' ? 'text-red-300' : 'text-green-400'}`}>
                        {selectedDisplay.status === 'danger' ? '当前文件处于人工接入状态' : selectedDisplay.status === 'warning' ? '当前文件命中客制化参考，禁止自动覆盖' : selectedDisplay.status === 'safe' ? '当前规则判定为无需自动合入' : '当前文件处于 Ready 状态'}
                      </h4>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-700">
              {scanning ? (
                <>
                  <Loader2 className="w-12 h-12 animate-spin text-blue-500 mb-4" />
                  <p className="text-sm font-medium text-slate-400">正在扫描文件，请稍候...</p>
                </>
              ) : (
                <>
                  <div className="bg-slate-900 p-8 rounded-full mb-4 border border-slate-800 shadow-inner"><FileText size={48} className="opacity-20" /></div>
                  <p className="text-sm font-medium">请从左侧列表选择待审核的文件</p>
                </>
              )}
            </div>
          )}
        </div>
      </main>

      <GitHistoryModal
        open={historyOpen}
        path={selectedDisplay?.path || ''}
        loading={historyLoading}
        error={historyError}
        history={gitHistory}
        selectedCommitHash={selectedCommitHash}
        detailLoading={commitDetailLoading}
        detailError={commitDetailError}
        commitDetail={commitDetail}
        onSelectCommit={handleSelectCommit}
        onClose={() => setHistoryOpen(false)}
      />

      <CompareFullscreenOverlay
        open={compareExpanded && canCompareAsText}
        path={selectedDisplay?.path || ''}
        selectedDisplay={selectedDisplay}
        savingStatus={savingStatus}
        savingContent={savingContent}
        historyLoading={historyLoading}
        canEditTarget={canEditTarget}
        editingTarget={editingTarget}
        onToggleStatus={handleToggleStatus}
        onOpenGitHistory={handleOpenGitHistory}
        onStartEdit={() => setEditingTarget(true)}
        onSaveEditedContent={handleSaveEditedContent}
        onCancelEdit={() => {
          setEditingTarget(false);
          setEditableTargetContent(selectedDisplay?.target?.content || '');
        }}
        onClose={() => setCompareExpanded(false)}
      >
        <CompareWorkspace
          selectedDisplay={selectedDisplay}
          selectedDiffRows={selectedDiffRows}
          activeDiffIndex={activeDiffIndex}
          onJumpToDiff={handleJumpToDiff}
          leftPaneRef={leftPaneRef}
          rightPaneRef={rightPaneRef}
          onLeftScroll={handleLeftPaneScroll}
          onRightScroll={handleRightPaneScroll}
          editingTarget={editingTarget}
          onEditLineChange={handleEditLineChange}
          onEditLineKeyDown={handleEditLineKeyDown}
          virtualRange={virtualRange}
          expanded
          onToggleExpand={() => setCompareExpanded(false)}
        />
      </CompareFullscreenOverlay>

      <AppFooter visibleCount={visibleCount} sameCount={sameCount} dangerCount={dangerCount} warningCount={warningCount} updateCount={updateCount} />

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #0f172a; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #475569; }
      ` }} />
    </div>
  );
}
