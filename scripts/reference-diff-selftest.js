import assert from 'node:assert/strict';
import fs from 'fs-extra';
import { getAddedLineBlocks } from '../server.js';

function blocks(oldContent, newContent) {
  return getAddedLineBlocks(oldContent, newContent);
}

function flatten(blockList) {
  return blockList.flat();
}

assert.deepEqual(
  blocks('A\nB\nC', 'A\nX\nB\nY\nC'),
  [['X'], ['Y']],
  'separate inserted lines should stay in separate blocks'
);

assert.deepEqual(
  blocks('A\nMOVED\nB', 'MOVED\nA\nB'),
  [],
  'moved existing lines should not be treated as native additions'
);

assert.deepEqual(
  blocks('A\nREPEAT\nB', 'A\nREPEAT\nREPEAT\nB'),
  [['REPEAT']],
  'only surplus repeated lines should be treated as additions'
);

assert.deepEqual(
  blocks('A\nHEADER += \\\n    old.apk \\\nB', 'A\nHEADER += \\\n    old.apk \\\nB'),
  [],
  'unchanged repeated allow-list style blocks should not be highlighted'
);

const oldMainline = '/media/wsl/jixie/资源/2026-05/mainline_v_2026_apr_15122717/vendor/partner_modules/build/mainline_modules.mk';
const newMainline = '/media/wsl/jixie/资源/2026-05/mainline_v_2026_may_15605729/vendor/partner_modules/build/mainline_modules.mk';

if (fs.existsSync(oldMainline) && fs.existsSync(newMainline)) {
  const mainlineAddedLines = flatten(blocks(
    fs.readFileSync(oldMainline, 'utf8'),
    fs.readFileSync(newMainline, 'utf8')
  ));

  assert.equal(
    mainlineAddedLines.includes('    system/priv-app/DocumentsUIGoogle/DocumentsUIGoogle.apk \\'),
    false,
    'existing APK allow-list entries must not be treated as native additions'
  );
  assert.equal(
    mainlineAddedLines.includes('# Allow dexopt files that are side-effects of already allowlisted files.'),
    true,
    'real dexopt native addition block should be preserved'
  );
}

console.log('reference diff self-test passed');
