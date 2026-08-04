import { describe, it, expect } from 'vitest';
import {
  clampView,
  zoomAbout,
  viewTransform,
  formatZoom,
  FIT_VIEW,
  ZOOM_MIN,
  ZOOM_MAX,
  type View,
} from '../helpers/viewport';

/** A 400×300 frame, the shape a section canvas actually has. */
const W = 400;
const H = 300;

describe('viewport: clamping', () => {
  it('never zooms out past fit', () => {
    expect(clampView({ zoom: 0.2, panX: 0, panY: 0 }, W, H).zoom).toBe(ZOOM_MIN);
    expect(clampView({ zoom: 999, panX: 0, panY: 0 }, W, H).zoom).toBe(ZOOM_MAX);
  });

  // The failure this prevents is dragging the world off screen and being left
  // staring at the background with no idea which way to drag back.
  it('keeps the canvas covering the frame', () => {
    const v = clampView({ zoom: 2, panX: 5000, panY: 5000 }, W, H);
    expect(v.panX).toBe(0);
    expect(v.panY).toBe(0);

    const far = clampView({ zoom: 2, panX: -5000, panY: -5000 }, W, H);
    // At 2x the content is 800×600, so the furthest it can travel is one frame.
    expect(far.panX).toBe(-W);
    expect(far.panY).toBe(-H);
  });

  it('pins pan to zero at fit, where there is no overhang', () => {
    const v = clampView({ zoom: 1, panX: -80, panY: 40 }, W, H);
    expect(v).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });
});

describe('viewport: anchored zoom', () => {
  /** Where a viewport point currently sits in unzoomed content space. */
  const contentAt = (v: View, sx: number, sy: number) => ({
    x: (sx - v.panX) / v.zoom,
    y: (sy - v.panY) / v.zoom,
  });

  // Without anchoring, zooming in on a detail throws that detail off screen and
  // you have to pan back to it after every press.
  it('holds the anchored point still', () => {
    const start: View = { zoom: 1, panX: 0, panY: 0 };
    const anchor = { x: 120, y: 200 };
    const before = contentAt(start, anchor.x, anchor.y);
    const after = zoomAbout(start, 3, anchor.x, anchor.y, W, H);
    const now = contentAt(after, anchor.x, anchor.y);
    expect(now.x).toBeCloseTo(before.x, 6);
    expect(now.y).toBeCloseTo(before.y, 6);
  });

  it('holds it across repeated steps from an off-centre anchor', () => {
    let v: View = { ...FIT_VIEW };
    const anchor = { x: 310, y: 60 };
    const target = contentAt(v, anchor.x, anchor.y);
    for (let i = 0; i < 5; i++) {
      v = zoomAbout(v, v.zoom * 1.5, anchor.x, anchor.y, W, H);
      const now = contentAt(v, anchor.x, anchor.y);
      expect(now.x).toBeCloseTo(target.x, 4);
      expect(now.y).toBeCloseTo(target.y, 4);
    }
  });

  it('stays clamped while zooming out at a corner', () => {
    let v = zoomAbout({ ...FIT_VIEW }, 6, W, H, W, H);
    v = zoomAbout(v, 1, W, H, W, H);
    expect(v).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('respects the zoom bounds', () => {
    expect(zoomAbout({ ...FIT_VIEW }, 1000, 0, 0, W, H).zoom).toBe(ZOOM_MAX);
    expect(zoomAbout({ zoom: 4, panX: -100, panY: -100 }, 0.01, 0, 0, W, H).zoom).toBe(ZOOM_MIN);
  });
});

describe('viewport: presentation', () => {
  it('renders a transform the CSS origin agrees with', () => {
    expect(viewTransform({ zoom: 2.25, panX: -370, panY: -240.5 })).toBe(
      'translate(-370px, -240.5px) scale(2.25)',
    );
  });

  it('formats zoom for the readout', () => {
    expect(formatZoom(FIT_VIEW)).toBe('100%');
    expect(formatZoom({ zoom: 2.25, panX: 0, panY: 0 })).toBe('225%');
  });
});
