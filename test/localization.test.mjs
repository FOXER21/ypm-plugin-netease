// 使用独立 ESM 上下文加载真实插件，验证翻译不会改变接口参数或音乐元数据。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json")));
const dictionaries = Object.fromEntries(readdirSync(path.join(root, "locales")).map((name) => [
  name.slice(0, -5), JSON.parse(readFileSync(path.join(root, "locales", name))),
]));
const sourceKeys = new Set();
for (const file of ["index.js", "client.js", "models.js"]) {
  for (const match of readFileSync(path.join(root, file), "utf8").matchAll(/"([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)) {
    if (match[1] !== "playlists:全部:0") sourceKeys.add(match[1]);
  }
}
sourceKeys.add(manifest.name);
sourceKeys.add(manifest.description);
for (const entry of manifest.navigation) if (entry.title) sourceKeys.add(entry.title);
for (const item of manifest.settings || []) {
  sourceKeys.add(item.label); if (item.help) sourceKeys.add(item.help);
  for (const option of item.options || []) sourceKeys.add(option.label);
}

async function runtime(language = "en") {
  const store = new Map();
  const prompts = [], requests = [];
  let payload;
  const env = { language, status: 200, body: null, settings: {} };
  const context = vm.createContext({
    URL, URLSearchParams, AbortSignal, console,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
    host: {
      setting: (key) => env.settings[key] ?? "",
      t: (message) => dictionaries[env.language]?.[message] ?? message,
      storage: { get: (key) => store.get(key), set: (key, value) => store.set(key, value), remove: (key) => store.delete(key) },
      crypto: { md5: () => "fixture", aesEcbEncrypt: (_, text) => { payload = JSON.parse(text.split("-36cd479b6b5-")[1]); return "fixture"; } },
      signInPrompt: (value = {}) => prompts.push(value),
    },
    fetch: async (url) => {
      requests.push({ url, payload });
      const body = env.reply ? env.reply(payload, url) : env.body ?? (url.includes("/unikey") ? { code: 200, unikey: "fixture-qr" }
        : url.includes("/client/login") ? { code: -462 } : { code: 200, more: true, playlists: [] });
      return { ok: env.status === 200, status: env.status, headers: { getSetCookie: () => [] }, json: async () => body };
    },
  });
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    assert.ok(!path.relative(root, file).startsWith(".."));
    const mod = new vm.SourceTextModule(readFileSync(file, "utf8"), { context, identifier: file });
    modules.set(file, mod);
    return mod;
  }
  const main = load(path.join(root, "index.js"));
  await main.link((specifier, ref) => load(path.resolve(path.dirname(ref.identifier), specifier)));
  await main.evaluate();
  return { env, store, prompts, requests, plugin: main.namespace, models: modules.get(path.join(root, "models.js")).namespace, i18n: modules.get(path.join(root, "i18n.js")).namespace };
}

test("收藏专辑兼容音乐库的数组读取，保留分页参数且空页结束", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture-session" });
  r.store.set("account", { id: "42", name: "测试用户" });
  for (const offset of [0, 50]) {
    r.env.body = { code: 200, hasMore: offset === 0, data: [{
      id: offset + 1, name: "测试专辑", picUrl: "http://p1.music.126.net/cover.jpg",
      artists: [{ id: 3, name: "歌手" }], size: 12, publishTime: 1700000000000,
    }] };
    const albums = await r.plugin.savedAlbums({ offset });
    // 播放器音乐库直接按 List 读取，包括 hasMore 为 false 的最后一个非空页。
    assert.ok(Array.isArray(albums));
    assert.equal(albums.length, 1);
    assert.equal(albums[0].id, String(offset + 1));
    assert.equal(albums[0].saved, true);
    assert.equal(albums[0].artists[0].name, "歌手");
    assert.equal(albums[0].imageUrl, "https://p1.music.126.net/cover.jpg");
    assert.equal(r.requests.at(-1).payload.offset, offset);
    assert.equal(r.requests.at(-1).payload.limit, 50);
  }
  r.env.body = { code: 200, hasMore: false, data: [] };
  assert.equal((await r.plugin.savedAlbums({ offset: 100 })).length, 0);
  r.env.body = { code: 200 };
  assert.ok(Array.isArray(await r.plugin.savedAlbums({ offset: 0 })));
});

test("九种语言覆盖全部文案，动态占位符保持一致", () => {
  assert.deepEqual(Object.keys(dictionaries).sort(), ["de", "en", "es", "fr", "ja", "ko", "ru", "zh-CN", "zh-TW"].sort());
  for (const [locale, messages] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(messages).sort(), [...sourceKeys].sort(), locale);
    for (const [key, value] of Object.entries(messages)) {
      assert.ok(typeof value === "string" && value.length > 0, `${locale}: ${key}`);
      const slots = (text) => [...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
      assert.deepEqual(slots(value), slots(key), `${locale}: ${key}`);
      if (locale === "zh-CN") assert.equal(value, key);
      else if (locale !== "zh-TW" && locale !== "ja") assert.ok(!/[\u3400-\u9fff]/.test(value), `${locale}: ${key}`);
    }
  }
});

for (const locale of Object.keys(dictionaries)) {
  test(`${locale}：导航、分类、占位、错误和扫码提示均使用当前语言`, async () => {
    const r = await runtime(locale);
    const d = dictionaries[locale];
    const page = await r.plugin.browse({ page: "playlists:华语:0" });
    assert.equal(page.title, d["热门歌单"]);
    assert.equal(page.tabs[1].title, d["华语"]);
    assert.equal(page.tabs[1].page, "playlists:华语:0");
    assert.equal(r.requests[0].payload.cat, "华语");
    assert.equal(page.sections[1].links[0].title, d["下一页"]);
    assert.equal(r.models.track({}).name, d["未知歌曲"]);
    assert.equal(r.models.track({ name: "每日推荐" }).name, "每日推荐");
    await assert.rejects(r.plugin.liked({}), (e) => e.code === "signIn" && e.message === d["请先登录网易云音乐"]);
    await assert.rejects(r.plugin.signIn(), (e) => e.code === "failed");
    assert.ok(r.prompts.some((p) => p.text === d["请用网易云音乐 App 扫码，并在手机上确认登录"]));
    assert.ok(r.prompts.some((p) => p.qr === "https://music.163.com/login?codekey=fixture-qr"));
  });
}

test("切换语言立即生效，服务端占位符不被二次替换", async () => {
  const r = await runtime("en");
  assert.equal((await r.plugin.home()).title, "NetEase Cloud Music");
  r.env.language = "zh-TW";
  assert.equal((await r.plugin.home()).title, "網易雲音樂");
  r.env.language = "en";
  r.env.status = 503;
  await assert.rejects(r.plugin.home(), (e) => e.retryable && e.message.includes("HTTP 503"));
  r.env.status = 200;
  r.env.body = { code: 403, message: "服务端消息 {status}" };
  await assert.rejects(r.plugin.home(), (e) => e.message === "NetEase request failed (403): 服务端消息 {status}");
  assert.equal(r.i18n.t("网易云请求失败（{code}）：{message}", { code: 1, message: "$& {code}" }), "NetEase request failed (1): $& {code}");
});

test("README 互链、仓库安装地址和许可证一致", () => {
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const text = readFileSync(path.join(root, name), "utf8");
    assert.ok(text.includes("github.com/lymzzyh/ypm-plugin-netease"));
    assert.ok(text.includes(name === "README.md" ? "(README.zh-CN.md)" : "(README.md)"));
    assert.ok(text.includes("[MIT](LICENSE)"));
  }
  assert.ok(readFileSync(path.join(root, "LICENSE"), "utf8").startsWith("MIT License"));
});

test("音质设置优先于播放器默认值，空设置跟随播放器", async () => {
  const levels = { standard: "standard", high: "exhigh", lossless: "lossless", hires: "hires" };
  for (const [selected, expected] of Object.entries(levels)) {
    const r = await runtime("zh-CN");
    r.env.settings.quality = selected;
    r.env.reply = (payload) => ({ code: 200, data: [{ url: "https://m.music.126.net/fixture", level: payload.level }] });
    assert.equal((await r.plugin.stream({ id: "42", quality: "high" })).quality, expected);
    assert.equal(r.requests[0].payload.level, expected);
  }
  for (const selected of ["", "invalid"]) {
    const r = await runtime(); r.env.settings.quality = selected;
    r.env.reply = (payload) => ({ code: 200, data: [{ url: "https://m.music.126.net/fixture", level: payload.level }] });
    assert.equal((await r.plugin.stream({ id: "42", quality: "lossless" })).quality, "lossless");
  }
});

test("Hi-Res 无完整音频时按序降级，不返回试听，也不向上请求", async () => {
  const r = await runtime("zh-CN"); r.env.settings.quality = "hires";
  r.env.reply = (payload) => ({ code: 200, data: [payload.level === "exhigh" ? { url: "https://m.music.126.net/full", level: "exhigh" } : { url: "https://m.music.126.net/preview", freeTrialInfo: { start: 0 } }] });
  assert.equal((await r.plugin.stream({ id: "42" })).quality, "exhigh");
  assert.deepEqual(r.requests.map(q => q.payload.level), ["hires", "lossless", "exhigh"]);
  r.env.settings.quality = "standard"; r.requests.length = 0;
  await assert.rejects(r.plugin.stream({ id: "42" }), e => e.code === "unavailable");
  assert.deepEqual(r.requests.map(q => q.payload.level), ["standard"]);
});

test("登录失效和网络错误立即报告，不伪装成音质降级", async () => {
  const r = await runtime(); r.env.settings.quality = "hires";
  r.env.body = { code: 301 };
  await assert.rejects(r.plugin.stream({ id: "42" }), e => e.code === "signIn");
  assert.equal(r.requests.length, 1);
  r.requests.length = 0; r.env.status = 503;
  await assert.rejects(r.plugin.stream({ id: "42" }), e => e.retryable === true);
  assert.equal(r.requests.length, 1);
});

test("云盘要求登录；未登录不请求个人数据", async () => {
  const r = await runtime("zh-CN");
  await assert.rejects(r.plugin.browse({ page: "cloud" }), e => e.code === "signIn");
  assert.equal(r.requests.length, 0);
});

test("云盘分页保留歌曲编号、元数据和翻页位置", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture" }); r.store.set("account", { id: "42" });
  r.env.reply = (p, url) => {
    assert.ok(url.endsWith("/eapi/v1/cloud/get")); assert.equal(p.limit, 50);
    return { code: 200, count: 100, hasMore: p.offset === 0, data: Array.from({ length: 50 }, (_, i) => ({
      songId: String(1000 + p.offset + i), songName: "个人上传", artist: "原始歌手", album: "个人专辑", cover: "http://p1.music.126.net/cover.jpg",
      simpleSong: { id: 1, name: "公共曲库名称", dt: 180000, ar: [{ id: 2, name: "歌手" }], al: { id: 3, name: "专辑" }, privilege: { st: -200 }, noCopyrightRcmd: { type: 1 } },
    })) };
  };
  const page = await r.plugin.browse({ page: "cloud" });
  assert.equal(page.title, "我的云盘"); assert.equal(page.sections[0].tracks.length, 50);
  const t = page.sections[0].tracks[0];
  assert.equal(t.id, "1000"); assert.equal(t.name, "个人上传"); assert.equal(t.duration, 180000); assert.equal(t.unavailable, false);
  assert.equal(t.album.name, "个人专辑"); assert.equal(t.album.imageUrl, "https://p1.music.126.net/cover.jpg");
  assert.equal(page.sections[1].links[0].page, "cloud:50");
  const last = await r.plugin.browse({ page: "cloud:50" });
  assert.equal(r.requests.at(-1).payload.offset, 50);
  assert.equal(last.sections[1].links.length, 1); assert.equal(last.sections[1].links[0].page, "cloud:0");
});

test("云盘原始文件无需公共匹配；缺少编号不允许播放", async () => {
  const r = await runtime("zh-CN");
  const t = r.models.cloudTrack({ songId: "900001", fileName: "我的录音.flac", artist: "本人", album: "录音" });
  assert.equal(t.id, "900001"); assert.equal(t.name, "我的录音.flac"); assert.equal(t.artists[0].name, "本人"); assert.equal(t.unavailable, false);
  assert.equal(r.models.cloudTrack({ fileName: "无编号文件" }).unavailable, true);
  r.env.settings.quality = "lossless";
  r.env.reply = p => { assert.deepEqual(JSON.parse(p.ids), ["900001"]); return { code: 200, data: [{ url: "https://m.music.126.net/private-file", level: "lossless", type: "flac" }] }; };
  assert.equal((await r.plugin.stream({ id: t.id })).quality, "lossless");
});

test("空云盘、空末页与缺少 hasMore 时均正确停止分页", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture" }); r.store.set("account", { id: "42" });
  r.env.body = { code: 200, data: [], count: 0, hasMore: false };
  const empty = await r.plugin.browse({ page: "cloud" });
  assert.equal(empty.sections.length, 1); assert.equal(empty.sections[0].tracks.length, 0); assert.equal(empty.sections[0].empty, "云盘中还没有歌曲");
  r.env.body = { code: 200, data: [], hasMore: true };
  const last = await r.plugin.browse({ page: "cloud:50" });
  assert.equal(last.sections[1].links.length, 1); assert.equal(last.sections[1].links[0].title, "上一页");
  r.env.body = { code: 200, data: [{ songId: 1 }], count: 2 };
  assert.equal((await r.plugin.browse({ page: "cloud" })).sections[1].links[0].page, "cloud:1");
});

test("云盘参数和异常响应不会伪装成空音乐库", async () => {
  const r = await runtime();r.store.set("cookies", { MUSIC_U: "fixture" });r.store.set("account", { id: "42" });
  for (const page of ["cloud:-1", "cloud:abc", "cloud:9007199254740993", "cloud:0:1"]) await assert.rejects(r.plugin.browse({ page }), e => e.code === "unsupported");
  assert.equal(r.requests.length, 0);
  r.env.body = { code: 200, data: {} };
  await assert.rejects(r.plugin.browse({ page: "cloud" }), e => e.code === "failed");
  r.env.body = { code: 301 };
  await assert.rejects(r.plugin.browse({ page: "cloud" }), e => e.code === "signIn");
});

test("云盘可从发现页进入，新版宿主通过筛选标签翻页", async () => {
  const r = await runtime("zh-CN");
  r.env.body = { code: 200, playlists: [], more: false };
  assert.ok((await r.plugin.browse({})).tabs.some(t => t.page === "cloud" && t.title === "我的云盘"));
  r.store.set("cookies", { MUSIC_U: "fixture" });r.store.set("account", { id: "42" });
  r.env.body = { code: 200, data: [{ songId: 123 }], hasMore: true };
  const page = await r.plugin.browse({ page: "cloud" });
  assert.equal(page.filters[0][0].page, "cloud:1");
  assert.ok(page.tabs.some(t => t.page === "cloud" && t.selected));
  assert.ok(page.tabs.some(t => t.page === ""));
});
