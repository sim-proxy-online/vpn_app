// Выбор источника обновлений для electron-updater.
//
// Провайдер github в electron-updater берёт latest.yml из ПОСЛЕДНЕГО релиза репозитория.
// В этом репозитории релизы выходят и без десктопных файлов (например v2.5.0 и v2.5.1 —
// только APK): releases/latest/download/latest.yml отвечает 404, и автообновление у всех
// пользователей Windows молча перестаёт работать до следующего десктопного релиза.
//
// Поэтому вместо «последнего релиза» ищем самый свежий релиз, в котором latest.yml
// действительно есть, и направляем updater на его каталог загрузок (generic-провайдер).
const https = require('https');

function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Petrovich-Desktop-Updater SimProxy-Desktop-Updater', Accept: 'application/vnd.github+json' }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > 4 * 1024 * 1024) { req.destroy(new Error('response too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Самый свежий (GitHub отдаёт от новых к старым) опубликованный не-пре-релиз, у которого
// среди файлов есть latest.yml.
function pickFeedRelease(releases) {
  if (!Array.isArray(releases)) return null;
  for (const r of releases) {
    if (!r || r.draft || r.prerelease || !r.tag_name) continue;
    if (Array.isArray(r.assets) && r.assets.some((a) => a && a.name === 'latest.yml')) return r;
  }
  return null;
}

const apiUrl = (owner, repo) => `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`;

// Тег как «свежесть» при равных датах публикации: посегментное сравнение,
// чтобы v2.10.0 > v2.9.0 (лексикографически — наоборот).
function compareTags(a, b) {
  const seg = (t) => String(t || '').replace(/^v/i, '').split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pa = seg(a);
  const pb = seg(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// URL каталога загрузок нужного релиза либо null, если подходящего релиза нет.
// repos — несколько репозиториев-источников (например, vpn_app + petrovich): их
// списки сливаются в один «от новых к старым» и берётся самый свежий релиз с
// latest.yml среди них. Сбой одного репозитория (лимит API, 404) не ломает
// проверку — остаётся тот, что ответил; падают оба — бросаем ошибку, и вызывающий
// остаётся на настройках по умолчанию.
// fetchJson подменяется в тестах.
async function resolveFeedUrl({ owner, repo, repos, fetchJson = getJson }) {
  const sources = Array.isArray(repos) && repos.length ? repos : [{ owner, repo }];
  if (sources.length === 1) {
    const s = sources[0];
    const list = await fetchJson(apiUrl(s.owner, s.repo));
    const r = pickFeedRelease(list);
    return r ? `https://github.com/${s.owner}/${s.repo}/releases/download/${encodeURIComponent(r.tag_name)}` : null;
  }

  const settled = await Promise.allSettled(
    sources.map((s) => fetchJson(apiUrl(s.owner, s.repo)).then((releases) => ({ ...s, releases })))
  );
  const ok = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (!ok.length) throw settled.find((x) => x.status === 'rejected').reason;

  const merged = ok.flatMap((s) => (Array.isArray(s.releases) ? s.releases : [])
    .filter((r) => r && typeof r === 'object' && r.tag_name)
    .map((r) => ({ ...r, owner: s.owner, repo: s.repo })));
  // GitHub отдаёт каждый список от новых к старым; между репозиториями сравниваем
  // дату публикации, при равенстве — тег. sort стабилен: при полном равенстве
  // остаётся порядок репозиториев из sources.
  merged.sort((a, b) =>
    (Date.parse(b.published_at || b.created_at || '') || 0) - (Date.parse(a.published_at || a.created_at || '') || 0)
    || compareTags(b.tag_name, a.tag_name));
  const r = pickFeedRelease(merged);
  return r ? `https://github.com/${r.owner}/${r.repo}/releases/download/${encodeURIComponent(r.tag_name)}` : null;
}

module.exports = { pickFeedRelease, resolveFeedUrl };
