import { describe, expect, it } from 'vitest';
import { countryName, isIpAddress, parseTrace } from './utils/publicIp';

const TRACE = [
  'fl=123f45', 'h=1.1.1.1', 'ip=198.51.100.24', 'ts=1790000000.123', 'visit_scheme=https',
  'uag=SimProxy', 'colo=FRA', 'sliver=none', 'http=http/2', 'loc=DE', 'tls=TLSv1.3', 'sni=plaintext', 'warp=off', 'gateway=off', 'rbi=off', 'kex=X25519',
].join('\n');

describe('parseTrace', () => {
  it('reads the address and the country out of a Cloudflare trace', () => {
    expect(parseTrace(TRACE)).toEqual({ ip: '198.51.100.24', country: 'DE' });
  });

  it('understands IPv6 and Windows line endings', () => {
    expect(parseTrace('ip=2001:db8::1\r\nloc=nl\r\n')).toEqual({ ip: '2001:db8::1', country: 'NL' });
  });

  it('a missing or odd country is empty, the address still counts', () => {
    expect(parseTrace('ip=203.0.113.7')).toEqual({ ip: '203.0.113.7', country: '' });
    expect(parseTrace('ip=203.0.113.7\nloc=XYZ')).toEqual({ ip: '203.0.113.7', country: '' });
  });

  it('no usable address means null: an HTML page, junk, an empty answer, a bad address', () => {
    expect(parseTrace('<html>blocked</html>')).toBeNull();
    expect(parseTrace('')).toBeNull();
    expect(parseTrace('ip=')).toBeNull();
    expect(parseTrace('ip=999.1.1.1')).toBeNull();
    expect(parseTrace('ip=<script>alert(1)</script>')).toBeNull();
    expect(parseTrace(undefined as unknown as string)).toBeNull();
  });
});

describe('isIpAddress', () => {
  it('accepts addresses and nothing else', () => {
    expect(isIpAddress('198.51.100.24')).toBe(true);
    expect(isIpAddress('2001:db8::1')).toBe(true);
    expect(isIpAddress('256.1.1.1')).toBe(false);
    expect(isIpAddress('example.org')).toBe(false);
    expect(isIpAddress('1.2.3')).toBe(false);
    expect(isIpAddress('')).toBe(false);
  });
});

describe('countryName', () => {
  it('gives the Russian name of the country', () => {
    expect(countryName('DE')).toBe('Германия');
    expect(countryName('nl')).toBe('Нидерланды');
    expect(countryName('FI')).toBe('Финляндия');
  });

  it('nothing for a bad code', () => {
    expect(countryName('')).toBe('');
    expect(countryName('X')).toBe('');
    expect(countryName('123')).toBe('');
  });
});
