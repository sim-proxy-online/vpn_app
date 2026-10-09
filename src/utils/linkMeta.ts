/**
 * Параметры отдельного сервера в стиле Happ (https://www.happ.su/main/ru/dev-docs/app-management).
 *
 * В отличие от параметров всей подписки (appManagement.ts) эти задаются в самой ссылке сервера:
 *   vless://…#имя?serverDescription=SGFwcCB0aGUgYmVzdA==
 *   vmess://BASE64?serverDescription=…#имя
 *   host.example/path#имя?fragment=80-250,10-100,tlshello&resolve-address=cdn.example&host=site.example&insecure=1
 * а для JSON-конфигов — в поле верхнего уровня "meta": { "serverDescription": "…" }.
 *
 * Здесь параметры вырезаются из ссылки (иначе они попадают в имя сервера или ломают base64 у vmess://)
 * и накладываются на разобранный сервер. Значения проверяются: это та же ссылка сервера, которой провайдер
 * и так управляет сервером целиком, но мусор в описание или адрес попасть не должен.
 */
import type { ServerNode } from '../types';
import { normRange } from './appManagement';

export const MAX_DESCRIPTION = 30;

export interface LinkMeta {
  description?: string;
  /** Уже в нашем порядке «packets,length,interval» (см. normalizeHappFragment). */
  fragment?: string;
  resolveAddress?: string;
  host?: string;
  insecure?: boolean;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Base64 (обычный и url-safe, с «=» или без) в UTF-8 текст без управляющих символов; иначе undefined. */
function base64ToText(v: string): string | undefined {
  const s = v.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return undefined;
  try {
    const core = s.replace(/=+$/, '');
    const bin = atob(core + '='.repeat((4 - (core.length % 4)) % 4));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u001f\u007f�]/.test(text) ? undefined : text;
  } catch { return undefined; }
}

/**
 * Описание сервера: у Happ это base64, но провайдеры нередко кладут и обычный текст — берём оба.
 * Текст считается base64, только если декодируется в корректный печатный UTF-8; иначе это и есть описание.
 * Длина ограничена 30 символами (так в документации Happ).
 */
export function decodeDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let s = safeDecode(raw.trim());
  if (!s) return undefined;
  const forced = /^base64:/i.test(s);
  if (forced) s = s.slice(7).trim();
  const decoded = base64ToText(s);
  const text = decoded ?? (forced ? '' : s);
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? Array.from(clean).slice(0, MAX_DESCRIPTION).join('') : undefined;
}

/**
 * У Happ фрагментация сервера: «длина,интервал,пакеты» (80-250,10-100,tlshello); пакеты можно опустить.
 * У нас внутренний порядок «пакеты,длина,интервал» (см. getFragmentSpec) — приводим к нему.
 * Если «tlshello» стоит первым (наш порядок), оставшиеся два значения — длина и интервал.
 */
export function normalizeHappFragment(v: string): string | undefined {
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return undefined;
  let packets = 'tlshello';
  let rest = parts;
  const at = parts.findIndex((p) => p.toLowerCase() === 'tlshello');
  if (at >= 0) rest = parts.filter((_, i) => i !== at);
  else if (parts.length === 3) { packets = parts[2]; rest = parts.slice(0, 2); }
  if (rest.length !== 2) return undefined;
  if (!/^\d{1,2}(-\d{1,2})?$/.test(packets) && packets.toLowerCase() !== 'tlshello') return undefined;
  const length = normRange(rest[0], 1, 2000);
  const interval = normRange(rest[1], 0, 500);
  if (!length || !interval) return undefined;
  return `${packets.toLowerCase()},${length},${interval}`;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV6_RE = /^[0-9a-f:]{2,45}$/i;

function safeAddress(v: string): string | undefined {
  const s = v.trim();
  return HOST_RE.test(s) || IPV6_RE.test(s) ? s : undefined;
}

interface Pair { raw: string; key: string; value: string }

function pairsOf(query: string): Pair[] {
  return query.split('&').filter(Boolean).map((raw) => {
    const i = raw.indexOf('=');
    return i < 0 ? { raw, key: raw.toLowerCase(), value: '' } : { raw, key: raw.slice(0, i).toLowerCase(), value: raw.slice(i + 1) };
  });
}

// В запросе до «#» host и insecure — обычные параметры самой ссылки (ws Host, проверка сертификата), их не трогаем.
const FRAGMENT_KEYS = new Set(['serverdescription', 'fragment', 'resolve-address', 'host', 'insecure']);
const QUERY_KEYS = new Set(['serverdescription', 'fragment', 'resolve-address']);

/**
 * Вырезает параметры Happ из ссылки сервера. Остальная ссылка остаётся как была (кроме вырезанных пар),
 * имя сервера — без хвоста «?serverDescription=…».
 */
export function splitLinkMeta(link: string): { link: string; meta: LinkMeta } {
  const meta: LinkMeta = {};
  const hashAt = link.indexOf('#');
  let head = hashAt >= 0 ? link.slice(0, hashAt) : link;
  let frag = hashAt >= 0 ? link.slice(hashAt + 1) : undefined;

  const take = (list: Pair[], allowed: Set<string>): string[] => {
    const rest: string[] = [];
    for (const p of list) {
      if (!allowed.has(p.key)) { rest.push(p.raw); continue; }
      if (p.key === 'serverdescription') { if (meta.description === undefined) meta.description = decodeDescription(p.value); }
      else if (p.key === 'fragment') meta.fragment = normalizeHappFragment(safeDecode(p.value));
      else if (p.key === 'resolve-address') meta.resolveAddress = safeAddress(safeDecode(p.value));
      else if (p.key === 'host') meta.host = safeAddress(safeDecode(p.value));
      else if (p.key === 'insecure') meta.insecure = /^(1|true)$/i.test(safeDecode(p.value).trim());
    }
    return rest;
  };

  // Некоторые панели кодируют весь фрагмент целиком («Имя%3FserverDescription%3D…»): тогда «?» спрятан — раскодируем.
  if (frag !== undefined && !frag.includes('?') && /%3f(serverdescription|fragment|resolve-address|host|insecure)(=|%3d)/i.test(frag)) frag = safeDecode(frag);

  if (frag !== undefined) {
    const q = frag.indexOf('?');
    if (q >= 0) {
      const list = pairsOf(frag.slice(q + 1));
      if (list.some((p) => FRAGMENT_KEYS.has(p.key))) {
        const rest = take(list, FRAGMENT_KEYS);
        frag = frag.slice(0, q) + (rest.length ? '?' + rest.join('&') : '');
      }
    }
  }

  const hq = head.indexOf('?');
  if (hq >= 0) {
    const list = pairsOf(head.slice(hq + 1));
    if (list.some((p) => QUERY_KEYS.has(p.key))) {
      const rest = take(list, QUERY_KEYS);
      head = head.slice(0, hq) + (rest.length ? '?' + rest.join('&') : '');
    }
  }

  return { link: frag !== undefined ? `${head}#${frag}` : head, meta };
}

/**
 * Накладывает параметры на сервер. resolve-address — куда реально подключаться (фронтинг через CDN),
 * а исходный адрес ссылки остаётся именем для TLS (SNI), если оно не задано отдельно.
 * rawLink сохраняется исходным: им делятся и сравнивают сервер между обновлениями подписки.
 */
export function applyLinkMeta(node: ServerNode, meta: LinkMeta, rawLink?: string): ServerNode {
  const out: ServerNode = { ...node };
  if (rawLink) out.rawLink = rawLink;
  if (meta.description) out.description = meta.description;
  if (meta.fragment) out.fragment = meta.fragment;
  if (meta.host) out.host = meta.host;
  if (meta.insecure) out.allowInsecure = true;
  if (meta.resolveAddress && meta.resolveAddress !== out.address) {
    out.sni = out.sni || out.address;
    out.address = meta.resolveAddress;
  }
  return out;
}
