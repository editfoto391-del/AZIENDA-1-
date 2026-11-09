import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPdfSnapshotLayout, getPdfImageLayout } from './pdf-layout.mjs';

test('delivery-note snapshots always use a fixed A4-safe width instead of oversized max-content sizing', () => {
  const layout = buildPdfSnapshotLayout({ scrollWidth: 1600, offsetWidth: 1200 });

  assert.equal(layout.cloneWidth, 794);
  assert.equal(layout.wrapperWidth, 794);
  assert.equal(layout.allowOversize, false);
});

test('A4-sized delivery notes fit on one page despite pixel rounding', () => {
  const layout = getPdfImageLayout(794, 1123);

  assert.equal(layout.pageCount, 1);
  assert.equal(layout.height, 297);
  assert.ok(layout.width < 210);
});

test('genuinely long documents retain all content across the required A4 pages', () => {
  const layout = getPdfImageLayout(794, 1800);

  assert.equal(layout.pageCount, 2);
  assert.equal(layout.height, (1800 * 210) / 794);
});
