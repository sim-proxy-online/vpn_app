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
      { headers: { 'User-Agent': 'Petrovich-Desktop-Updater', Accept: 'application/vnd.github+json' }, timeout: timeoutMs },
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

// URL каталога загрузок нужного релиза либо null, если подходящего релиза нет.
// fetchJson подменяется в тестах.
async function resolveFeedUrl({ owner, repo, fetchJson = getJson }) {
  const list = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`);
  const r = pickFeedRelease(list);
  return r ? `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(r.tag_name)}` : null;
}

module.exports = { pickFeedRelease, resolveFeedUrl };
