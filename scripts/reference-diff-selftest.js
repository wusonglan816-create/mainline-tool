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
  blocks('A\nREAD_PRIVILEGED_PHONE_STATE\nB', 'A\nB\nREAD_PRIVILEGED_PHONE_STATE'),
  [['READ_PRIVILEGED_PHONE_STATE']],
  'reordered permission lines on the new side should be highlighted as monthly native diff'
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

const oldPrivappPermissions = '/media/wsl/jixie/资源/2026-06/gms-oem-V-15-202605/partner_gms/etc/permissions/privapp-permissions-google-product.xml';
const newPrivappPermissions = '/media/wsl/jixie/资源/2026-06/gms-oem-V-15-202606/partner_gms/etc/permissions/privapp-permissions-google-product.xml';

if (fs.existsSync(oldPrivappPermissions) && fs.existsSync(newPrivappPermissions)) {
  const privappAddedLines = flatten(blocks(
    fs.readFileSync(oldPrivappPermissions, 'utf8'),
    fs.readFileSync(newPrivappPermissions, 'utf8')
  ));

  assert.equal(
    privappAddedLines.includes('        <permission name="android.permission.READ_PRIVILEGED_PHONE_STATE"/>'),
    true,
    'READ_PRIVILEGED_PHONE_STATE should be highlighted when it appears on the new side of the monthly diff'
  );
}

console.log('reference diff self-test passed');
