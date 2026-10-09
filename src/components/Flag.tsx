import { detectFlag } from '../data';

// Regional-indicator emoji (🇺🇸) → ISO-3166 alpha-2 ("us"). Windows can't render
// flag emojis (shows "US" letters), so we map them to bundled SVG images instead.
function emojiToIso2(emoji?: string): string | null {
  if (!emoji) return null;
  const ri = Array.from(emoji)
    .map((c) => c.codePointAt(0) || 0)
    .filter((c) => c >= 0x1f1e6 && c <= 0x1f1ff);
  if (ri.length < 2) return null;
  const a = String.fromCharCode(ri[0] - 0x1f1e6 + 65);
  const b = String.fromCharCode(ri[1] - 0x1f1e6 + 65);
  return (a + b).toLowerCase();
}

interface FlagProps {
  /** Emoji flag (e.g. node.flag). */
  flag?: string;
  /** Fallback: detect country from a server name/remark. */
  name?: string;
  /** Rendered height in px (width follows the 4:3 ratio). */
  size?: number;
  className?: string;
}

// Cross-platform country flag: renders a bundled SVG image (works on Windows,
// where flag emojis don't), falling back to the 🌐 globe emoji when the country
// is unknown.
export default function Flag({ flag, name, size = 28, className = '' }: FlagProps) {
  const emoji = flag && flag !== '🌐' ? flag : name ? detectFlag(name) : '';
  const iso = emojiToIso2(emoji);
  const width = Math.round((size * 4) / 3);

  if (!iso) {
    return (
      <span className={className} style={{ fontSize: Math.round(size * 0.92), lineHeight: 1 }}>
        🌐
      </span>
    );
  }

  return (
    <img
      src={`flags/${iso}.svg`}
      alt={iso.toUpperCase()}
      width={width}
      height={size}
      loading="lazy"
      draggable={false}
      className={`inline-block rounded-[3px] object-cover shadow-sm ${className}`}
      style={{ width, height: size }}
      onError={(e) => {
        // Missing SVG → fall back to a neutral globe glyph.
        const el = e.currentTarget;
        el.replaceWith(Object.assign(document.createElement('span'), { textContent: '🌐' }));
      }}
    />
  );
}
