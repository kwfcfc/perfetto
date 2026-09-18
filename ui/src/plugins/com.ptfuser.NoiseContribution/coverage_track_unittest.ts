import {vi} from 'vitest';
import {HSLColor} from '../../base/color';
import type {Renderer} from '../../base/renderer';
import {makeColorScheme} from '../../components/colorizer';
import {ColorVariant, SliceTrack} from '../../components/tracks/slice_track';
import type * as SliceTrackModule from '../../components/tracks/slice_track';
import type {Trace} from '../../public/trace';
import type {TrackRenderContext} from '../../public/track';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG} from '../../trace_processor/query_result';
import {createCoverageTrack} from './coverage_track';

vi.mock('../../components/tracks/slice_track', async (importOriginal) => ({
  ...(await importOriginal<typeof SliceTrackModule>()),
  SliceTrack: {create: vi.fn()},
}));

function setup(ratio: number, offset = 0, depth = 0) {
  const slice = {
    id: 1,
    title: 'frame',
    subtitle: '',
    count: 1,
    colorScheme: makeColorScheme(new HSLColor('#2166ac')),
    fillRatio: 1,
    row: {ts: 0n},
  };
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
  };
  const renderer: Renderer = {
    pushTransform: vi.fn(),
    resetTransform: vi.fn(),
    clear: vi.fn(),
    clip: vi.fn(),
    drawMarkers: vi.fn(),
    drawStepArea: vi.fn(),
    drawSlices: vi.fn(),
  };
  const fakeTrack = {
    rootTableName: 'slice',
    onMouseClick: vi.fn(() => true),
    render: vi.fn((context: TrackRenderContext) => {
      const attrs = vi.mocked(SliceTrack.create).mock.lastCall![0];
      attrs.onUpdatedSlices?.([slice]);
      context.renderer.drawSlices(
        {
          starts: new Float32Array([0]),
          ends: new Float32Array([100]),
          depths: new Uint16Array([depth]),
          colors: new Uint32Array([0]),
          patterns: new Uint8Array([0]),
          count: 1,
        },
        {paddingTop: 3, firstRowHeight: 18, rowHeight: 3},
        {scale: 1, offset},
      );
    }),
  };
  vi.mocked(SliceTrack.create).mockReturnValue(
    fakeTrack as unknown as ReturnType<typeof SliceTrack.create>,
  );
  const pattern = {} as CanvasPattern;
  const track = createCoverageTrack(
    {
      trace: {timeline: {}} as Trace,
      uri: 'test',
      dataset: new SourceDataset({src: 'slice', schema: {ts: LONG}}),
      fillRatio: () => ratio,
    },
    pattern,
  );
  track.render({
    ctx,
    renderer,
    size: {width: 100, height: 100},
  } as unknown as TrackRenderContext);
  return {track, fakeTrack, ctx, renderer, pattern, slice};
}

test('patterns only the uncovered area after drawing the base slices', () => {
  const {ctx, renderer, pattern} = setup(0.25);
  expect(ctx.fillRect).toHaveBeenCalledExactlyOnceWith(25, 3, 74, 18);
  expect(ctx.fillStyle).toBe(pattern);
  expect(ctx.save).toHaveBeenCalledTimes(1);
  expect(ctx.restore).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(renderer.drawSlices).mock.invocationCallOrder[0],
  ).toBeLessThan(ctx.fillRect.mock.invocationCallOrder[0]);
});

test('uses the full frame for coverage when the viewport clips its left edge', () => {
  const {ctx} = setup(0.5, -40);
  expect(ctx.fillRect).toHaveBeenCalledExactlyOnceWith(10, 3, 49, 18);
});

test('respects collapsed row geometry', () => {
  const {ctx} = setup(0.5, 0, 2);
  expect(ctx.fillRect).toHaveBeenCalledExactlyOnceWith(50, 24, 49, 3);
});

test('leaves fully covered frames solid', () => {
  expect(setup(1).ctx.fillRect).not.toHaveBeenCalled();
});

test('preserves hover highlighting and click handling', () => {
  const {track, fakeTrack, slice} = setup(0.5);
  const attrs = vi.mocked(SliceTrack.create).mock.lastCall![0];
  expect(attrs.onUpdatedSlices?.([slice])).toEqual([ColorVariant.BASE]);
  attrs.onSliceOver?.({slice});
  expect(attrs.onUpdatedSlices?.([slice])).toEqual([ColorVariant.VARIANT]);
  attrs.onSliceOut?.({slice});
  expect(attrs.onUpdatedSlices?.([slice])).toEqual([ColorVariant.BASE]);
  const event = {x: 0, y: 0} as Parameters<
    NonNullable<typeof track.onMouseClick>
  >[0];
  expect(track.onMouseClick?.(event)).toBe(true);
  expect(fakeTrack.onMouseClick).toHaveBeenCalledWith(event);
});
