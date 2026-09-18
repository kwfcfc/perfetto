// Local Perfetto UI plugin. Copy this directory into perfetto/ui/src/plugins/.
// API reference: google/perfetto main, com.example.Tracks.
import m from 'mithril';
import {ensureExists} from '../../base/assert';
import {HSLColor} from '../../base/color';
import {clamp} from '../../base/math_utils';
import {makeColorScheme} from '../../components/colorizer';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {TrackNode} from '../../public/workspace';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, NUM, NUM_NULL, STR} from '../../trace_processor/query_result';
import {createCoverageTrack} from './coverage_track';

const ARG_KEY = 'debug.Merging Stats.Noise Contribution (NC)';
const COUNT_ARG_KEY = 'debug.Merging Stats.Count';

const UNCOVERED_BACKGROUND = '#e5e7eb';
const UNCOVERED_DOTS = '#6b7280';

// Opaque stippling keeps uncovered areas distinct from pale NC colors.
function createUncoveredPattern(): {pattern: CanvasPattern; imageUrl: string} {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 4;
  const ctx = ensureExists(tile.getContext('2d'));
  ctx.fillStyle = UNCOVERED_BACKGROUND;
  ctx.fillRect(0, 0, 4, 4);
  ctx.fillStyle = UNCOVERED_DOTS;
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillRect(2, 2, 1, 1);
  return {
    pattern: ensureExists(ctx.createPattern(tile, 'repeat')),
    imageUrl: tile.toDataURL(),
  };
}

function coverageLegend(imageUrl: string): m.Children {
  return m('div', [
    m('span', {
      'aria-hidden': 'true',
      'style': {
        display: 'inline-block',
        width: '24px',
        height: '12px',
        marginRight: '6px',
        backgroundColor: UNCOVERED_BACKGROUND,
        backgroundImage: `url(${imageUrl})`,
        backgroundSize: '4px 4px',
      },
    }),
    'Dots: uncovered; solid color: NC of covered samples',
  ]);
}

// All frames on a track use its topmost frame's Count as a fixed denominator.
function coverageRatio(count: number, rootCount: number): number {
  if (
    !Number.isFinite(count) ||
    !Number.isFinite(rootCount) ||
    rootCount <= 0
  ) {
    return 0;
  }
  return clamp(count / rootCount, 0, 1);
}

// Fixed signed thresholds: nc=0.01 means 1%, not 0.01%.
function colorHex(nc: number | null): string {
  if (nc === null || !Number.isFinite(nc)) return '#9ca3af';
  if (nc < -0.01) return '#2166ac';
  if (nc < 0) return '#92c5de';
  if (nc < 0.001) return '#f7f7f7';
  if (nc < 0.01) return '#fddbc7';
  if (nc < 0.05) return '#f4a582';
  if (nc < 0.2) return '#d6604d';
  return '#b2182b';
}

export default class implements PerfettoPlugin {
  static readonly id = 'com.ptfuser.NoiseContribution';

  async onTraceLoad(trace: Trace): Promise<void> {
    const uncoveredPattern = createUncoveredPattern();
    await trace.engine.query(`
      CREATE PERFETTO TABLE nc_colored_frames AS
      SELECT id, track_id, ts, dur, depth,
        COALESCE(name, '[unnamed]') AS name,
        EXTRACT_ARG(arg_set_id, '${ARG_KEY}') AS nc,
        EXTRACT_ARG(arg_set_id, '${COUNT_ARG_KEY}') AS sample_count
      FROM slice
      WHERE EXTRACT_ARG(arg_set_id, '${COUNT_ARG_KEY}') IS NOT NULL
    `);

    const result = await trace.engine.query(`
      SELECT frames.track_id, MAX(frames.depth) AS max_depth,
        (
          SELECT root.sample_count
          FROM nc_colored_frames AS root
          WHERE root.track_id = frames.track_id
          ORDER BY root.depth, root.ts, root.id
          LIMIT 1
        ) AS root_count
      FROM nc_colored_frames AS frames
      GROUP BY frames.track_id ORDER BY frames.track_id
    `);
    for (
      const it = result.iter({track_id: NUM, max_depth: NUM, root_count: NUM});
      it.valid();
      it.next()
    ) {
      const uri = `com.ptfuser.NoiseContribution#${it.track_id}`;
      // Capture the value before advancing the query iterator.
      const rootCount = it.root_count;
      trace.tracks.registerTrack({
        uri,
        renderer: createCoverageTrack(
          {
            trace,
            uri,
            rootTableName: 'slice',
            initialMaxDepth: it.max_depth,
            dataset: new SourceDataset({
              src: `SELECT * FROM nc_colored_frames WHERE track_id = ${it.track_id}`,
              schema: {
                id: NUM,
                ts: LONG,
                dur: LONG,
                depth: NUM,
                name: STR,
                nc: NUM_NULL,
                sample_count: NUM,
              },
            }),
            colorizer: (row) => makeColorScheme(new HSLColor(colorHex(row.nc))),
            fillRatio: (row) => coverageRatio(row.sample_count, rootCount),
            tooltip: (slice) =>
              m('div', [
                m('div', slice.row.name),
                m('div', `Slice ID: ${slice.row.id}`),
                m(
                  'div',
                  `NC: ${
                    slice.row.nc === null
                      ? 'missing'
                      : `${(slice.row.nc * 100).toFixed(4)}%`
                  }`,
                ),
                m('div', `Count: ${slice.row.sample_count}`),
                m('div', `Root Count: ${rootCount}`),
                m(
                  'div',
                  `Coverage: ${(coverageRatio(slice.row.sample_count, rootCount) * 100).toFixed(2)}%`,
                ),
                coverageLegend(uncoveredPattern.imageUrl),
                m('div', `Merged duration: ${Number(slice.row.dur) / 1000} us`),
              ]),
          },
          uncoveredPattern.pattern,
        ),
      });
      trace.defaultWorkspace.addChildInOrder(
        new TrackNode({
          uri,
          name: `NC heatmap — track ${it.track_id}`,
        }),
      );
    }
  }
}
