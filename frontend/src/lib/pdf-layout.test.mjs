import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPdfSnapshotLayout } from './pdf-layout.mjs';

test('delivery-note snapshots always use a fixed A4-safe width instead of oversized max-content sizing', () => {
  const layout = buildPdfSnapshotLayout({ scrollWidth: 1600, offsetWidth: 1200 });

  assert.equal(layout.cloneWidth, 794);
  assert.equal(layout.wrapperWidth, 794);
  assert.equal(layout.allowOversize, false);
});
