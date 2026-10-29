// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rgb = { r: number; g: number; b: number };
type Rgba = Rgb & { a: number };

const normalTextMinimumContrast = 4.5;
const stylesheet = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function readRootTokens(css: string): Map<string, string> {
  const rootBlock = /:root\s*\{([^}]*)\}/.exec(css);
  if (!rootBlock?.[1]) {
    throw new Error('styles.css has no :root token block.');
  }

  const tokens = new Map<string, string>();
  for (const declaration of rootBlock[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = declaration[1];
    const value = declaration[2];
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.trim());
    }
  }

  return tokens;
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const channels = hex[1];
    return {
      r: Number.parseInt(channels.slice(0, 2), 16),
      g: Number.parseInt(channels.slice(2, 4), 16),
      b: Number.parseInt(channels.slice(4, 6), 16),
      a: 1
    };
  }

  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value);
  if (rgba?.[1] && rgba[2] && rgba[3] && rgba[4]) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: Number(rgba[4])
    };
  }

  throw new Error(`Unsupported color token value: ${value}`);
}

function token(tokens: Map<string, string>, name: string): Rgba {
  const value = tokens.get(name);
  if (value === undefined) {
    throw new Error(`styles.css is missing the ${name} token.`);
  }

  return parseColor(value);
}

function over(foreground: Rgba, background: Rgb): Rgb {
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a)
  };
}

function relativeLuminance(color: Rgb): number {
  const linear = [color.r, color.g, color.b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('styles.css design tokens', () => {
  const tokens = readRootTokens(stylesheet);
  const page = token(tokens, '--bg');
  const panel = over(token(tokens, '--panel'), page);
  const card = over({ r: 255, g: 255, b: 255, a: 0.66 }, panel);
  // body paints radial-gradient(rgba(216, 95, 56, 0.18)) over #f7f1e8 at the top-left corner.
  const heroGlow = over({ r: 216, g: 95, b: 56, a: 0.18 }, { r: 247, g: 241, b: 232 });

  const surfaces: ReadonlyArray<{ name: string; color: Rgb }> = [
    { name: 'page background', color: page },
    { name: 'panel', color: panel },
    { name: 'card', color: card },
    { name: 'hero glow', color: heroGlow }
  ];

  it.each(surfaces)('keeps ink readable on the $name', ({ color }) => {
    expect(contrastRatio(token(tokens, '--ink'), color)).toBeGreaterThanOrEqual(normalTextMinimumContrast);
  });

  it.each(surfaces)('keeps muted text readable on the $name', ({ color }) => {
    expect(contrastRatio(token(tokens, '--muted'), color)).toBeGreaterThanOrEqual(normalTextMinimumContrast);
  });

  it.each(surfaces)('keeps accent text (eyebrow, slug) readable on the $name', ({ color }) => {
    expect(contrastRatio(token(tokens, '--accent'), color)).toBeGreaterThanOrEqual(normalTextMinimumContrast);
  });

  it('keeps primary button text readable on the accent', () => {
    expect(contrastRatio(token(tokens, '--on-accent'), token(tokens, '--accent'))).toBeGreaterThanOrEqual(
      normalTextMinimumContrast
    );
  });

  it('keeps danger button text readable on the danger color', () => {
    expect(contrastRatio(token(tokens, '--on-accent'), token(tokens, '--danger'))).toBeGreaterThanOrEqual(
      normalTextMinimumContrast
    );
  });

  it.each([
    { name: 'accent badge', foreground: '--accent', background: '--accent-soft' },
    { name: 'muted badge', foreground: '--muted', background: '--muted-soft' },
    { name: 'health badge', foreground: '--success', background: '--success-soft' },
    { name: 'warning notice', foreground: '--warning-ink', background: '--warning-soft' }
  ])('keeps $name text readable on its tinted background', ({ foreground, background }) => {
    const tinted = over(token(tokens, background), panel);
    expect(contrastRatio(token(tokens, foreground), tinted)).toBeGreaterThanOrEqual(normalTextMinimumContrast);
  });

  it.each(['--success', '--error'])('keeps %s status text readable on the panel', (name) => {
    expect(contrastRatio(token(tokens, name), panel)).toBeGreaterThanOrEqual(normalTextMinimumContrast);
  });
});
