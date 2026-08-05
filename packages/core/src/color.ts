export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(colorStr: string): RGBA {
  const s = colorStr.trim().toLowerCase();

  const names: Record<string, string> = {
    white: '#ffffff',
    black: '#000000',
    transparent: 'rgba(0,0,0,0)',
    red: '#ff0000',
    green: '#00ff00',
    blue: '#0000ff',
  };
  const resolved = names[s] || s;

  if (resolved.startsWith('#')) {
    const hex = resolved.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      const a = hex.length === 4 ? parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }

  const rgbMatch = resolved.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1]!, 10),
      g: parseInt(rgbMatch[2]!, 10),
      b: parseInt(rgbMatch[3]!, 10),
      a: rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]!) : 1,
    };
  }

  return { r: 0, g: 0, b: 0, a: 1 };
}

function pivotRgb(n: number): number {
  return n > 0.04045 ? Math.pow((n + 0.055) / 1.055, 2.4) : n / 12.92;
}

function pivotXyz(n: number): number {
  return n > 0.008856 ? Math.pow(n, 1 / 3) : 7.787 * n + 16 / 116;
}

export interface LAB {
  L: number;
  a: number;
  b: number;
}

export function rgbToLab(r: number, g: number, b: number): LAB {
  const rLinear = pivotRgb(r / 255);
  const gLinear = pivotRgb(g / 255);
  const bLinear = pivotRgb(b / 255);

  const x = rLinear * 0.4124 + gLinear * 0.3576 + bLinear * 0.1805;
  const y = rLinear * 0.2126 + gLinear * 0.7152 + bLinear * 0.0722;
  const z = rLinear * 0.0193 + gLinear * 0.1192 + bLinear * 0.9505;

  const xNormalized = x / 0.95047;
  const yNormalized = y / 1.0;
  const zNormalized = z / 1.08883;

  const fx = pivotXyz(xNormalized);
  const fy = pivotXyz(yNormalized);
  const fz = pivotXyz(zNormalized);

  const L = 116 * fy - 16;
  const labA = 500 * (fx - fy);
  const labB = 200 * (fy - fz);

  return { L, a: labA, b: labB };
}

export function deltaE76(color1: string, color2: string): number {
  const c1 = parseColor(color1);
  const c2 = parseColor(color2);

  if (c1.a === 0 && c2.a === 0) return 0;
  if ((c1.a === 0 && c2.a > 0) || (c2.a === 0 && c1.a > 0)) return 100;

  const lab1 = rgbToLab(c1.r, c1.g, c1.b);
  const lab2 = rgbToLab(c2.r, c2.g, c2.b);

  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;

  return Math.sqrt(dL * dL + da * da + db * db);
}
