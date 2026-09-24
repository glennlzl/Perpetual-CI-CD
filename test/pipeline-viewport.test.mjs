import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FRAME_INSET, INITIAL_PIPELINE_VIEWPORT, READABLE_ZOOM, STAGE_MIN_WIDTH, alignTop, createSheetViewport, entryViewport, focusViewport, revealViewport, stageBoxes, stageGap, uncoverViewport } from '../client/src/lib/pipeline-viewport.mjs';

// Lays cards out the way the canvas does: measured widths, one gap apart.
const row = (widths, gap = stageGap()) => {
  let x = 0;
  return widths.map((width, index) => { const box = { id: `stage-${index}`, x, width: Math.max(STAGE_MIN_WIDTH, width) }; x += box.width + gap; return box; });
};
const screen = (viewport, box) => ({ left: viewport.x + box.x * viewport.zoom, right: viewport.x + (box.x + box.width) * viewport.zoom });
// A 1280px window with the 48px icon sidebar leaves a 1232px canvas.
const CANVAS_1280 = 1280 - 48;
// Source, Build & Deploy, an unprovisioned Beta with its Sandbox badge, and an
// unconnected Production, at their measured intrinsic widths.
const DEFAULT_STAGES = [255, 273, 310, 255];

test('the default four stages fit whole at the entry zoom from a 1280px window', () => {
  const boxes = row(DEFAULT_STAGES), viewport = entryViewport(boxes, { width: CANVAS_1280 });
  assert.equal(viewport.x, FRAME_INSET.left);
  assert.equal(viewport.y, FRAME_INSET.top);
  assert.ok(viewport.zoom >= READABLE_ZOOM && viewport.zoom < 0.95, `zoom ${viewport.zoom}`);
  const production = screen(viewport, boxes.at(-1));
  assert.ok(production.right <= CANVAS_1280 - FRAME_INSET.right, `Production ends at ${production.right.toFixed(1)}px of ${CANVAS_1280}px`);
  // Minimum-width cards leave room for badges wider than the defaults.
  const minimum = 4 * STAGE_MIN_WIDTH + 3 * stageGap();
  assert.ok(minimum * READABLE_ZOOM + FRAME_INSET.left + FRAME_INSET.right <= CANVAS_1280 - 64, `${minimum}px of stages`);
});

test('large windows do not centre stages in empty space or enlarge controls', () => {
  assert.deepEqual(entryViewport(row(DEFAULT_STAGES), { width: 1440 - 48 }), { x: FRAME_INSET.left, y: FRAME_INSET.top, zoom: 1 });
  assert.deepEqual(entryViewport(row(DEFAULT_STAGES), { width: 2400 }), { x: FRAME_INSET.left, y: FRAME_INSET.top, zoom: 1 });
});

test('a pipeline that overflows by a little trims its insets rather than slice the last card', () => {
  const boxes = row(DEFAULT_STAGES), right = boxes.at(-1).x + boxes.at(-1).width;
  const width = Math.floor(right * READABLE_ZOOM + FRAME_INSET.left - 2);
  const viewport = entryViewport(boxes, { width });
  assert.equal(viewport.zoom, READABLE_ZOOM);
  const production = screen(viewport, boxes.at(-1));
  assert.ok(production.right <= width - 8 && viewport.x >= 8 && viewport.x < FRAME_INSET.left, `x ${viewport.x}`);
  assert.equal(entryViewport(boxes, { width: Math.floor(right * READABLE_ZOOM) }).x, FRAME_INSET.left, 'Beyond a trim, the frame starts at the inset.');
});

test('a longer pipeline keeps the readable zoom and leaves the rest to panning', () => {
  const boxes = row([255, 273, 310, 310, 255]), viewport = entryViewport(boxes, { width: CANVAS_1280 });
  assert.deepEqual(viewport, { x: FRAME_INSET.left, y: FRAME_INSET.top, zoom: READABLE_ZOOM });
  assert.ok(screen(viewport, boxes[0]).left >= FRAME_INSET.left, 'Source stays whole.');
});

test('a phone starts on the first stage at the zoom automatic framing settles on', () => {
  assert.deepEqual(INITIAL_PIPELINE_VIEWPORT, { x: FRAME_INSET.left, y: FRAME_INSET.top, zoom: READABLE_ZOOM });
  assert.equal(Object.isFrozen(INITIAL_PIPELINE_VIEWPORT), true);
  assert.deepEqual(entryViewport(row(DEFAULT_STAGES), { width: 390 }), INITIAL_PIPELINE_VIEWPORT);
  assert.deepEqual(entryViewport([], { width: 390 }), INITIAL_PIPELINE_VIEWPORT);
});

test('stage boxes come from measured React Flow nodes, falling back to the minimum width', () => {
  assert.deepEqual(stageBoxes([{ id: 'source', position: { x: 0, y: 0 }, measured: { width: 280, height: 90 } }, { id: 'build', position: { x: 344, y: 0 } }]), [{ id: 'source', x: 0, width: 280 }, { id: 'build', x: 344, width: STAGE_MIN_WIDTH }]);
});

test('Jump to stage keeps the entry row and shows the stage between its neighbours', () => {
  const boxes = row([255, 273, 310, 310, 310, 255]), width = CANVAS_1280;
  const middle = focusViewport(boxes, 'stage-3', { width, zoom: 0.5 });
  assert.equal(middle.y, FRAME_INSET.top, 'Cards keep the height they enter at.');
  assert.equal(middle.zoom, READABLE_ZOOM, 'An unreadable zoom is lifted to the floor.');
  const target = screen(middle, boxes[3]);
  assert.ok(Math.abs((target.left + target.right) / 2 - width / 2) < 1, 'The stage is centred.');
  assert.ok(screen(middle, boxes[2]).right > 0 && screen(middle, boxes[4]).left < width, 'Both neighbours show.');
  const last = focusViewport(boxes, 'stage-5', { width, zoom: 1.4 });
  assert.equal(last.zoom, 1);
  assert.ok(Math.abs(screen(last, boxes[5]).right - (width - FRAME_INSET.right)) < 1e-9, 'Production sits at the right inset with Gamma beside it, not alone mid-canvas.');
  assert.equal(focusViewport(boxes, 'stage-0', { width, zoom: READABLE_ZOOM }).x, FRAME_INSET.left, 'Source never pulls in past the left inset.');
  const entry = entryViewport(row(DEFAULT_STAGES), { width });
  assert.deepEqual(focusViewport(row(DEFAULT_STAGES), 'stage-3', { width, zoom: entry.zoom }), entry, 'A pipeline in view stays put.');
  assert.equal(focusViewport(boxes, 'missing', { width }), null);
});

test('a stage wider than a narrow canvas starts at its left edge', () => {
  const boxes = row([255, 720, 255]);
  const viewport = focusViewport(boxes, 'stage-1', { width: 390, zoom: READABLE_ZOOM });
  assert.equal(screen(viewport, boxes[1]).left, 8);
});

test('a sheet uncovers its stage with the smallest pan and never zooms', () => {
  const viewport = { x: 20, y: 32, zoom: 0.777 }, box = { x: 993, width: 256 };
  const visible = 1232 - 493;
  const next = uncoverViewport(viewport, box, { width: visible });
  assert.equal(next.zoom, viewport.zoom);
  assert.equal(next.y, viewport.y);
  assert.ok(Math.abs(screen(next, box).right - (visible - FRAME_INSET.right)) < 1e-9, 'Just enough to clear the sheet.');
  assert.equal(uncoverViewport(viewport, { x: 0, width: 256 }, { width: visible }), viewport, 'A stage already in view leaves the viewport alone.');
  const wide = uncoverViewport(viewport, { x: 993, width: 1200 }, { width: visible });
  assert.equal(screen(wide, { x: 993, width: 1200 }).left, FRAME_INSET.right, 'An oversized stage shows its start.');
  const behind = uncoverViewport({ x: -900, y: 32, zoom: 1 }, { x: 0, width: 256 }, { width: visible });
  assert.equal(screen(behind, { x: 0, width: 256 }).left, FRAME_INSET.right, 'A stage panned off to the left comes back into view.');
});

test('closing a sheet returns the frame it borrowed unless the viewer moved', () => {
  const sheet = createSheetViewport(), manual = { x: 60, y: 90, zoom: 0.777 };
  assert.equal(sheet.close(), null, 'Nothing to return without a sheet.');
  sheet.open(manual);
  sheet.open({ x: 0, y: 0, zoom: 1 });
  assert.equal(sheet.active, true);
  assert.deepEqual(sheet.close(), { restore: manual }, 'Switching stages inside a sheet keeps the first frame; a manual Fit view survives.');
  assert.equal(sheet.active, false);
  sheet.open(manual); sheet.moved();
  assert.equal(sheet.close(), null, 'A pan or zoom inside the sheet is kept.');
  sheet.open(manual); sheet.reframed();
  assert.deepEqual(sheet.close(), { frame: true }, 'A resize while open frames the widened canvas afresh.');
  sheet.moved(); sheet.reframed();
  assert.equal(sheet.active, false, 'Moves and reframes outside a sheet record nothing.');
});

test('a sheet opened while a restore is still animating borrows the restore target, not the frame in flight', async () => {
  const sheet = createSheetViewport(), viewer = { x: 60, y: 32, zoom: 0.92 }, uncovered = { x: -400, y: 32, zoom: 0.92 };
  const midFlight = { x: -170, y: 32, zoom: 0.92 };
  sheet.open(viewer);
  const closed = sheet.close();
  assert.deepEqual(closed, { restore: viewer });
  let land;
  const restoring = new Promise(resolve => { land = resolve; });
  sheet.animate(closed.restore, restoring);
  assert.equal(sheet.view(midFlight), viewer, 'While the restore animates, its target is the view.');
  sheet.open(midFlight);
  assert.deepEqual(sheet.close(), { restore: viewer }, 'The next close returns the viewer\'s frame, not the half-finished one.');
  land(true); await restoring; await null;
  assert.equal(sheet.view(midFlight), midFlight, 'Once the restore lands, the live viewport is the view again.');
  // A later flight replaces an earlier one; only its own landing clears it.
  const first = new Promise(() => {}), second = Promise.resolve(true);
  sheet.animate(viewer, first);
  sheet.animate(uncovered, second);
  assert.equal(sheet.view(midFlight), uncovered);
  await second; await null;
  assert.equal(sheet.view(midFlight), midFlight, 'An interrupted flight that never lands does not linger.');
  sheet.animate(viewer, new Promise(() => {}));
  sheet.moved();
  assert.equal(sheet.view(midFlight), midFlight, 'A drag or zoom cancels the flight.');
  sheet.animate(viewer, new Promise(() => {}));
  sheet.reframed();
  assert.equal(sheet.view(midFlight), midFlight, 'A reframe cancels the flight.');
});

test('keyboard focus pans just far enough to show the control and never zooms', () => {
  const viewport = { x: 20, y: 32, zoom: 0.92 }, size = { width: 1392, height: 700 };
  const stage = { x: 1500, y: 0, width: 256, height: 300 }, title = { x: 1516, y: 16, width: 60, height: 28 };
  const next = revealViewport(viewport, title, stage, size);
  assert.equal(next.zoom, viewport.zoom);
  assert.equal(next.y, viewport.y, 'A control already in view vertically keeps the row height.');
  assert.ok(Math.abs(next.x + (stage.x + stage.width) * viewport.zoom - (size.width - FRAME_INSET.right)) < 1e-9, 'The whole stage comes in at the right inset, not just its title.');
  assert.equal(revealViewport(next, { x: 1700, y: 16, width: 32, height: 32 }, stage, size), next, 'Tabbing within a visible stage leaves the canvas still.');
  const transition = { x: stage.x + stage.width + 16, y: 14, width: 32, height: 32 };
  const gap = revealViewport(viewport, transition, stage, size);
  assert.ok(gap.x + (transition.x + transition.width) * viewport.zoom <= size.width - FRAME_INSET.right + 1e-9, 'A transition control past its card is shown too.');
  const behind = revealViewport({ x: -2000, y: 32, zoom: 1 }, { x: 16, y: 16, width: 60, height: 28 }, { x: 0, y: 0, width: 256, height: 300 }, size);
  assert.equal(behind.x, FRAME_INSET.left, 'A stage panned off to the left comes back at the left inset.');
  const wide = { x: 0, y: 0, width: 2400, height: 300 }, far = { x: 2200, y: 16, width: 32, height: 32 };
  const minimal = revealViewport({ x: 20, y: 32, zoom: 1 }, far, wide, size);
  assert.equal(minimal.x + (far.x + far.width), size.width - FRAME_INSET.right, 'A stage wider than the canvas pans only to its control.');
  const low = { x: 16, y: 900, width: 200, height: 32 };
  const down = revealViewport({ x: 20, y: 32, zoom: 1 }, low, { x: 0, y: 0, width: 256, height: 1000 }, size);
  assert.equal(down.x, 20);
  assert.equal(down.y + low.y + low.height, size.height - 16, 'A control below a tall card scrolls up just into view.');
  assert.equal(revealViewport(viewport, title, stage, { width: 0, height: 0 }), viewport);
});

test('Fit view starts the row at the entry height when there is room above it', () => {
  assert.deepEqual(alignTop({ x: 300, y: 235, zoom: 1 }), { x: 300, y: FRAME_INSET.top, zoom: 1 });
  const tall = { x: 40, y: 12, zoom: 0.4 };
  assert.equal(alignTop(tall), tall, 'A fit that needs the height keeps its own inset.');
});

test('canvas pans are linear and recorded until they land, so a pan never dips the zoom', async () => {
  const app = await readFile(new URL('../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const panOptions = \(\) => \(\{ duration: matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 0 : 220, interpolate: 'linear' \}\);/);
  // Every setViewport given options animates, and every one of those is linear.
  const options = [...app.matchAll(/flow\.setViewport\([\w.]+, ([^()]*(?:\([^()]*\))?)\)/g)].map(match => match[1]);
  assert.ok(options.length >= 2, 'The shared pan and Jump to stage animate.');
  for (const option of options) assert.equal(option, 'panOptions()', `setViewport(…, ${option})`);
  assert.doesNotMatch(app, /setViewport\([^;]*\{ duration(?!: matchMedia)/, 'No pan passes a bare duration, which d3 interpolates by zooming out mid-flight.');
  assert.match(app, /const pan = useCallback\(next => \{ void sheetViewport\.animate\(next, flow\.setViewport\(next, panOptions\(\)\)\); \}/);
  assert.match(app, /if \(closed\?\.restore\) pan\(closed\.restore\);/, 'A restore is recorded until it lands.');
  assert.match(app, /const current = sheetViewport\.view\(flow\.getViewport\(\)\), next = uncoverViewport\(current,/, 'Uncovering starts from where the canvas is going.');
});

test('focus cannot scroll the renderer; keyboard focus pans the canvas instead', async () => {
  const app = await readFile(new URL('../client/src/App.jsx', import.meta.url), 'utf8');
  const css = (await readFile(new URL('../client/src/pipeline.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.delivery-app \.release-flow, \.delivery-app \.release-flow \.react-flow__renderer \{ overflow: clip; \}/, 'overflow: hidden is still programmatically scrollable.');
  assert.doesNotMatch(css, /react-flow__renderer \{ overflow: hidden/);
  assert.match(app, /element\.addEventListener\('focusin', reveal\)/);
  const reveal = app.slice(app.indexOf('const reveal = event =>'), app.indexOf("element.addEventListener('focusin', reveal)"));
  assert.match(reveal, /control\.matches\(':focus-visible'\)/, 'A pointer click never pans the canvas.');
  assert.match(reveal, /closest\('\.react-flow__node'\)/, 'Only controls inside a stage reveal it.');
  assert.match(reveal, /revealViewport\(current, box\(control\), box\(node\)/);
  assert.match(reveal, /takeView\(\);\n      pan\(next\);/, 'The viewer navigated, so automatic framing keeps their view.');
});

test('Jump to stage marks where it lands with the stage arrival ring', async () => {
  const app = await readFile(new URL('../client/src/App.jsx', import.meta.url), 'utf8');
  const css = (await readFile(new URL('../client/src/pipeline.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const jump = app.slice(app.indexOf('function focusStage('), app.indexOf('const zoomOut'));
  assert.match(jump, /\.then\(\(\) => arrive\(\[\{ stageId: id, key: `jump-\$\{\+\+jumps\.current\}` \}\]\)\)/, 'The ring replays after the pan lands, with a fresh key each jump.');
  assert.match(app, /\{arrival && <span key=\{arrival\} className="stage-arrival" aria-hidden="true" \/>\}/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{[^@]*\.delivery-app \.stage-arrival \{ animation: pipeline-arrival/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \.delivery-app \.stage-arrival \{ opacity: \.6; \}\n\}/, 'Without motion the ring shows still instead of pulsing.');
});

test('the canvas never draws an unreadable whole-pipeline fit before framing and keeps manual Fit view', async () => {
  const app = await readFile(new URL('../client/src/App.jsx', import.meta.url), 'utf8');
  const flow = /<ReactFlow [^>]*>/.exec(app)?.[0] || '';
  assert.match(flow, /defaultViewport=\{INITIAL_PIPELINE_VIEWPORT\}/);
  assert.doesNotMatch(flow, /\bfitView\b/, 'An initial fitView frame renders type at about 4px on a phone.');
  assert.match(app, /aria-label="Fit view"/);
  assert.match(app, /const fit = \(\) => \{\n    takeView\(\);\n    void flow\.fitView\(FIT_VIEW_OPTIONS\)\.then\(\(\) => \{\n      const fitted = flow\.getViewport\(\), next = alignTop\(fitted\);/, 'Fit view stays the registry fit, then starts at the entry row height.');
  assert.match(flow, /onMoveStart=\{onMoveStart\}/, 'A drag, wheel or pinch hands the view to the viewer.');
});

test('opening or closing a sheet or dialog never reframes the canvas', async () => {
  const app = await readFile(new URL('../client/src/App.jsx', import.meta.url), 'utf8');
  const canvas = app.slice(app.indexOf('function PipelineCanvas('), app.indexOf('function StageNewTest('));
  const frame = /const frame = useCallback\([\s\S]*?\n  \}, \[([^\]]*)\]\);/.exec(canvas);
  assert.ok(frame, 'frame');
  assert.doesNotMatch(frame[1], /selection|selectedStageId|sheet\b/, 'Automatic framing does not depend on what is selected.');
  assert.match(canvas, /observer\.observe\(section\.current\)/, 'The observed section keeps its size when a sheet narrows the flow viewport.');
  assert.match(canvas, /if \(!view\.current\.moved\) scheduleFrame\(\);/, 'A layout change keeps a view the viewer chose.');
  assert.match(app, /const MODAL_DIALOGS = new Set\(\['stage', 'rename-stage', 'remove-stage', 'transition'\]\);/, 'New stage, rename, delete and transition confirmations are centred dialogs.');
  assert.match(canvas, /const sheet = selection && !MODAL_DIALOGS\.has\(selection\.type\) \? selection : null;/);
  assert.match(canvas, /className=\{`pipeline-canvas\$\{sheet \? ' has-inspector' : ''\}/, 'Only a sheet narrows the canvas.');
  assert.doesNotMatch(canvas, /getViewportForBounds|readablePipelineViewport/);
});

test('automatic framing never renders canvas type below 11px, on desktop or a phone', async () => {
  const css = (await readFile(new URL('../client/src/pipeline.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const sizes = [...css.matchAll(/\.delivery-app \.(?:stage-[\w-]+|transition-[\w-]+|pipeline-stage)[^{]*\{[^}]*font-size: (\d+)px/g)].map(match => Number(match[1]));
  assert.ok(sizes.length > 0);
  // Badges and step rows use the registry's 12px text-xs; nothing on a card is smaller.
  for (const size of [12, ...sizes]) assert.ok(size * READABLE_ZOOM >= 11, `${size}px renders at ${(size * READABLE_ZOOM).toFixed(2)}px`);
  for (const width of [390, 1232, 1440]) assert.ok(entryViewport(row(DEFAULT_STAGES), { width }).zoom * 12 >= 11, `${width}px canvas`);
  assert.ok(focusViewport(row(DEFAULT_STAGES), 'stage-2', { width: 390, zoom: 0.2 }).zoom * 12 >= 11, 'Jump to stage frames at the same readable zoom.');
  const title = /\.delivery-app \.stage-header \{[^}]*font-size: (\d+)px/.exec(css)?.[1];
  assert.equal(Number(title), 18, 'Stage titles lead the card type scale.');
  const app = await readFile(new URL('../client/src/App.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /0\.85/);
});

test('cards, gaps and transition controls share one geometry', async () => {
  const css = (await readFile(new URL('../client/src/pipeline.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const stage = /\.delivery-app \.pipeline-stage \{([^}]*)\}/.exec(css)[1];
  assert.match(stage, new RegExp(`min-width: ${STAGE_MIN_WIDTH}px;`));
  assert.match(stage, new RegExp(`max-width: clamp\\(${STAGE_MIN_WIDTH}px, 70vw, 720px\\);`));
  assert.match(css, new RegExp(`\\.pipeline-loading-frame \\{[^}]*gap: ${stageGap()}px;`), 'Loading placeholders use the same gap.');
  assert.match(css, new RegExp(`@media \\(pointer: coarse\\) \\{[^@]*--transition-control-size: 52px;[^@]*\\.pipeline-loading-frame \\{ gap: ${stageGap(true)}px; \\}`));
  // Transition controls sit centred in the gap with room on both sides.
  for (const [coarse, control] of [[false, 32], [true, 52]]) {
    const clearance = (stageGap(coarse) - control) / 2;
    assert.ok(clearance >= 16, `${control}px controls keep ${clearance}px from each card`);
  }
  const app = await readFile(new URL('../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const TRANSITION_STYLE = \{ top: RAIL_TOP, left: `calc\(100% \+ \$\{STAGE_GAP \/ 2 \+ 1\}px\)` \};/, 'Controls are centred in the gap past the card border.');
  assert.match(app, /const STAGE_GAP = stageGap\(/);
});

test('the loading skeleton draws stages in one row at the entry framing', async () => {
  const loading = await readFile(new URL('../client/src/PipelineLoading.jsx', import.meta.url), 'utf8');
  assert.match(loading, /INITIAL_PIPELINE_VIEWPORT/);
  assert.match(loading, /className="pipeline-stage"/);
  assert.doesNotMatch(loading, /grid-cols/, 'A grid of cards shifts into a row when the canvas arrives.');
});
