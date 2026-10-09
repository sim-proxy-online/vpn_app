import { describe, expect, it } from 'vitest';
import { parseColorProfile, readableAccent, relativeLuminance } from './utils/providerColor';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// Тема VIOLET из документации Happ (сокращена до нужных ключей).
const VIOLET = {
  backgroundGradientRotationAngle: 37.1, serverRowBackgroundColor: '#21003D67', subsHeaderColor: '#42296DFF',
  profileWebPageIconColor: '#A2B8FFFF', buttonColor: '#9377FFFF', powerIconColor: '#3D2A7DFF',
  backgroundColors: ['#3D2A7DFF', '#6557BAFF', '#9377FF7F'], elipseColors: ['#00B460FF', '#CF72FFE0', '#FFDD00FF'],
};

describe('parseColorProfile', () => {
  it('takes the button colour of a Happ theme as the accent, without its alpha', () => {
    expect(parseColorProfile(JSON.stringify(VIOLET))).toEqual({ accent: '#9377ff' });
  });

  it('understands base64, with and without the "base64:" prefix', () => {
    expect(parseColorProfile(b64(JSON.stringify(VIOLET)))).toEqual({ accent: '#9377ff' });
    expect(parseColorProfile('base64:' + b64(JSON.stringify(VIOLET)))).toEqual({ accent: '#9377ff' });
  });

  it('"resetcolors" clears the colour', () => {
    expect(parseColorProfile('resetcolors')).toEqual({});
    expect(parseColorProfile('  ResetColors ')).toEqual({});
  });

  it('falls back to other keys when there is no button colour', () => {
    expect(parseColorProfile(JSON.stringify({ subsHeaderColor: '#00B460FF' }))).toEqual({ accent: '#00b460' });
    expect(parseColorProfile(JSON.stringify({ backgroundColors: ['#FF8800FF'] }))).toEqual({ accent: '#ff8800' });
  });

  it('almost transparent colours are skipped in favour of the next candidate', () => {
    expect(parseColorProfile(JSON.stringify({ buttonColor: '#FF000010', subsHeaderColor: '#00AAFFFF' }))).toEqual({ accent: '#00aaff' });
  });

  it('a colour that is too dark is lightened so it stays readable on the dark interface', () => {
    const out = parseColorProfile(JSON.stringify({ buttonColor: '#1A0033FF' }))!;
    expect(out.accent).toBeDefined();
    expect(out.accent).not.toBe('#1a0033');
    const v = parseInt(out.accent!.slice(1), 16);
    expect(relativeLuminance({ r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 })).toBeGreaterThanOrEqual(0.2);
  });

  it('a bright colour is left as it is', () => {
    expect(readableAccent('#00f0ff')).toBe('#00f0ff');
    expect(readableAccent('#ffffff')).toBe('#ffffff');
  });

  it('junk is rejected: not JSON, not an object, no usable colour, not hex, too long', () => {
    expect(parseColorProfile(undefined)).toBeNull();
    expect(parseColorProfile('')).toBeNull();
    expect(parseColorProfile('not json at all')).toBeNull();
    expect(parseColorProfile('[1,2,3]')).toBeNull();
    expect(parseColorProfile('{}')).toBeNull();
    expect(parseColorProfile(JSON.stringify({ buttonColor: 'red' }))).toBeNull();
    expect(parseColorProfile(JSON.stringify({ buttonColor: 'url(javascript:alert(1))' }))).toBeNull();
    expect(parseColorProfile(JSON.stringify({ buttonColor: 'expression(1)' }))).toBeNull();
    expect(parseColorProfile(JSON.stringify({ pad: 'x'.repeat(20000), buttonColor: '#9377FFFF' }))).toBeNull();
  });

  it('only a plain #rrggbb string can ever come out — nothing else reaches the styles', () => {
    for (const bad of ['#9377FF"; background:url(x)', '#9377FFFF;', '#12345', '#GGGGGG']) {
      expect(parseColorProfile(JSON.stringify({ buttonColor: bad }))).toBeNull();
    }
    expect(parseColorProfile(JSON.stringify(VIOLET))!.accent).toMatch(/^#[0-9a-f]{6}$/);
  });
});
