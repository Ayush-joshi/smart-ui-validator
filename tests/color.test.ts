import { describe, expect, it } from 'vitest';
import { parseColor, deltaE76 } from '../packages/core/src/color.js';

describe('Delta E Color Math', () => {
  it('should parse hex, rgb, and named colors correctly', () => {
    expect(parseColor('#ffffff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('rgb(61, 99, 221)')).toEqual({ r: 61, g: 99, b: 221, a: 1 });
    expect(parseColor('#3d63dd')).toEqual({ r: 61, g: 99, b: 221, a: 1 });
  });

  it('should calculate 0 distance for identical colors', () => {
    expect(deltaE76('#3d63dd', 'rgb(61, 99, 221)')).toBe(0);
    expect(deltaE76('white', '#ffffff')).toBe(0);
    expect(deltaE76('rgba(0,0,0,0)', 'transparent')).toBe(0);
  });

  it('should calculate large distance for white vs black', () => {
    const dist = deltaE76('white', 'black');
    expect(dist).toBeCloseTo(100, 1);
  });

  it('should calculate small distance for similar colors', () => {
    const dist = deltaE76('#3d63dd', '#4d73ed');
    expect(dist).toBeLessThan(10);
    expect(dist).toBeGreaterThan(0);
  });

  it('should penalize transparent vs solid colors', () => {
    expect(deltaE76('transparent', 'white')).toBeGreaterThanOrEqual(100);
  });

  it('rejects malformed colors instead of treating them as black', () => {
    expect(() => parseColor('not-a-color')).toThrow(/Unsupported color/);
  });
});
