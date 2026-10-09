// Выбор источника обновлений десктопа (desktop/updateFeed.cjs). Сеть подменена;
// LIVE=1 дополнительно проверяет реальный GitHub API репозитория с релизами.
const assert = require('assert');
const path = require('path');
const { pickFeedRelease, resolveFeedUrl } = require(path.join(__dirname, '..', '..', 'desktop', 'updateFeed.cjs'));

const rel = (tag, names, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: names.map((name) => ({ name })), ...extra });

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

(async () => {
  // Ровно та ситуация, что сломала автообновление: свежие релизы — только APK.
  const realWorld = [
    rel('v2.5.1', ['SimProxy-v2.5.1.apk']),
    rel('v2.5.0', ['SimProxy-v2.5.0.apk']),
    rel('v2.4.9', ['latest.yml', 'SimProxy-Setup-2.4.9.exe', 'SimProxy-Setup-2.4.9.exe.blockmap', 'SimProxy-2.4.9-portable.exe', 'SimProxy-v2.4.9.apk']),
    rel('v2.4.8', ['SimProxy-Setup-2.4.8.exe']),
  ];

  await t('skips newer APK-only releases and picks the newest one that has latest.yml', async () => {
    assert.strictEqual(pickFeedRelease(realWorld).tag_name, 'v2.4.9');
  });

  await t('takes the newest release when it does have latest.yml', async () => {
    const r = pickFeedRelease([rel('v2.6.0', ['latest.yml']), ...realWorld]);
    assert.strictEqual(r.tag_name, 'v2.6.0');
  });

  await t('ignores drafts and pre-releases even if they carry latest.yml', async () => {
    const list = [rel('v3.0.0-beta', ['latest.yml'], { prerelease: true }), rel('v2.9.9', ['latest.yml'], { draft: true }), ...realWorld];
    assert.strictEqual(pickFeedRelease(list).tag_name, 'v2.4.9');
  });

  await t('returns null when no release has latest.yml, and for garbage input', async () => {
    assert.strictEqual(pickFeedRelease([rel('v1', ['a.apk'])]), null);
    assert.strictEqual(pickFeedRelease([]), null);
    assert.strictEqual(pickFeedRelease(null), null);
    assert.strictEqual(pickFeedRelease([null, {}, { tag_name: 'v1' }]), null);
  });

  await t('resolveFeedUrl builds the release download directory URL', async () => {
    let asked;
    const url = await resolveFeedUrl({ owner: 'o', repo: 'r', fetchJson: async (u) => { asked = u; return realWorld; } });
    assert.strictEqual(url, 'https://github.com/o/r/releases/download/v2.4.9');
    assert.match(asked, /^https:\/\/api\.github\.com\/repos\/o\/r\/releases\?per_page=\d+$/);
  });

  await t('resolveFeedUrl encodes unusual tags and returns null when nothing matches', async () => {
    const url = await resolveFeedUrl({ owner: 'o', repo: 'r', fetchJson: async () => [rel('v2.5.0+build 1', ['latest.yml'])] });
    assert.strictEqual(url, 'https://github.com/o/r/releases/download/v2.5.0%2Bbuild%201');
    assert.strictEqual(await resolveFeedUrl({ owner: 'o', repo: 'r', fetchJson: async () => [] }), null);
  });

  await t('resolveFeedUrl propagates network errors (caller falls back to the default provider)', async () => {
    await assert.rejects(resolveFeedUrl({ owner: 'o', repo: 'r', fetchJson: async () => { throw new Error('HTTP 403'); } }), /HTTP 403/);
  });

  if (process.env.LIVE === '1') {
    await t('LIVE: the real repository resolves to a release that really serves latest.yml', async () => {
      const url = await resolveFeedUrl({ owner: 'sim-proxy-online', repo: 'vpn_app' });
      assert.ok(url, 'no release with latest.yml found');
      const res = await fetch(url + '/latest.yml', { redirect: 'follow' });
      assert.strictEqual(res.status, 200, url);
      const text = await res.text();
      assert.match(text, /^version: \d+\.\d+\.\d+/m);
      assert.match(text, /sha512: /);
      console.log('       feed:', url);
    });
  }

  console.log(`\n${passed} passed` + (failed ? `, ${failed} FAILED` : ''));
  process.exit(failed ? 1 : 0);
})();
