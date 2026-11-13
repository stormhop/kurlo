import { describe, expect, it } from 'vitest';
import { horizontalWheelDelta, nextHorizontalScroll } from '../lib/horizontalWheel';

describe('horizontal wheel scrolling', () => {
  it('uses a sideways trackpad swipe as is', () => {
    expect(horizontalWheelDelta({ deltaX: 40, deltaY: 3, deltaMode: 0 }, 16, 600)).toBe(40);
  });

  it('turns a vertical mouse wheel into sideways scrolling', () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: -100, deltaMode: 0 }, 16, 600)).toBe(-100);
  });

  it('converts line and page wheel steps to pixels', () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 16, 600)).toBe(48);
    expect(horizontalWheelDelta({ deltaX: 1, deltaY: 0, deltaMode: 2 }, 16, 600)).toBe(600);
  });

  it('clamps to the text and leaves the wheel alone at the edges', () => {
    expect(nextHorizontalScroll(0, 1000, 600, 150)).toBe(150);
    expect(nextHorizontalScroll(350, 1000, 600, 150)).toBe(400);
    expect(nextHorizontalScroll(400, 1000, 600, 150)).toBeNull();
    expect(nextHorizontalScroll(0, 1000, 600, -50)).toBeNull();
    expect(nextHorizontalScroll(0, 600, 600, 50)).toBeNull();
  });
});
