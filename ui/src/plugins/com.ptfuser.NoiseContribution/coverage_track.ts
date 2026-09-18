import {clamp} from '../../base/math_utils';
import {
  rowHeightFromLayout,
  rowTopFromLayout,
  SLICE_GAP_PX,
  type Renderer,
} from '../../base/renderer';
import {
  ColorVariant,
  SliceTrack,
  type RowSchema,
  type SliceTrackAttrs,
} from '../../components/tracks/slice_track';
import type {TrackRenderer} from '../../public/track';

// Decorate only this plugin's track using the standard rendering callbacks.
// SliceTrack still owns data loading, layout, labels, selection and tooltips.
export function createCoverageTrack<T extends RowSchema>(
  attrs: SliceTrackAttrs<T>,
  pattern: CanvasPattern,
): TrackRenderer {
  let ratios: number[] = [];
  let hoveredId: number | undefined;
  const track = SliceTrack.create({
    ...attrs,
    // Our renderer draws the uncovered area instead of the default fade.
    fillRatio: () => 1,
    onSliceOver: (args) => {
      hoveredId = args.slice.id;
      attrs.onSliceOver?.(args);
    },
    onSliceOut: (args) => {
      hoveredId = undefined;
      attrs.onSliceOut?.(args);
    },
    onUpdatedSlices: (slices) => {
      ratios = slices.map(({row}) => clamp(attrs.fillRatio?.(row) ?? 1, 0, 1));
      if (attrs.onUpdatedSlices) return attrs.onUpdatedSlices(slices);
      const highlightedName = attrs.trace.timeline.highlightedSliceName;
      return slices.map(({id, title}) =>
        id === hoveredId || title === highlightedName
          ? ColorVariant.VARIANT
          : ColorVariant.BASE,
      );
    },
  });

  return {
    rootTableName: track.rootTableName,
    render: (context) => {
      const {renderer, ctx} = context;
      // A local adapter; never mutate the shared renderer or canvas methods.
      const decoratedRenderer: Renderer = {
        pushTransform: renderer.pushTransform.bind(renderer),
        resetTransform: renderer.resetTransform.bind(renderer),
        clear: renderer.clear.bind(renderer),
        clip: renderer.clip.bind(renderer),
        drawMarkers: renderer.drawMarkers.bind(renderer),
        drawStepArea: renderer.drawStepArea.bind(renderer),
        drawSlices: (buffers, layout, transform) => {
          renderer.drawSlices(buffers, layout, transform);
          // Draw before SliceTrack's labels and selection outlines, on both
          // Canvas2D and WebGL (whose canvas sits below the 2D overlay).
          ctx.save();
          try {
            ctx.fillStyle = pattern;
            for (let i = 0; i < buffers.count; i++) {
              const ratio = ratios[i] ?? 1;
              if (!Number.isFinite(ratio) || ratio >= 1) continue;
              const start =
                buffers.starts[i] * transform.scale + transform.offset;
              const end = buffers.ends[i] * transform.scale + transform.offset;
              if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
              // Compute coverage before viewport clipping, so panning doesn't
              // move the boundary within a frame. Preserve the inter-slice gap.
              const left = Math.max(start + (end - start) * ratio, 0);
              const right = Math.min(end - SLICE_GAP_PX, context.size.width);
              if (right <= left) continue;
              ctx.fillRect(
                left,
                rowTopFromLayout(layout, buffers.depths[i]),
                right - left,
                rowHeightFromLayout(layout, buffers.depths[i]),
              );
            }
          } finally {
            ctx.restore();
          }
        },
      };
      track.render({...context, renderer: decoratedRenderer});
    },
    getHeight: () => track.getHeight(),
    getSliceVerticalBounds: (depth) => track.getSliceVerticalBounds(depth),
    getTrackShellButtons: () => track.getTrackShellButtons(),
    getDataset: () => track.getDataset(),
    getSelectionDetails: (id) => track.getSelectionDetails(id),
    detailsPanel: (selection) => track.detailsPanel(selection),
    renderTooltip: () => track.renderTooltip(),
    getSnapPoint: (...args) => track.getSnapPoint(...args),
    onMouseMove: (event) => track.onMouseMove(event),
    onMouseOut: () => track.onMouseOut(),
    onMouseClick: (event) => track.onMouseClick(event),
    onMouseDoubleClick: (event) => track.onMouseDoubleClick(event),
  };
}
