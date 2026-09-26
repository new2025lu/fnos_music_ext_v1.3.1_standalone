/*
 * fnmusic-ext 运行时扩展前端（独立脚本，不依赖飞牛任何内部 chunk）
 * 通过 React fiber 树自省拿到播放器 store（飞牛新前端已不再挂到 window），
 * 复用旧方案验证过的 track 对象结构，改调新 store 的 addAndPlayTrack 播放。
 */
(function () {
  "use strict";

  var store = null;
  var storeReady = false;
  var storeError = "";

  /* ---------------- 工具 ---------------- */
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function norm(v, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (v && v[keys[i]] != null && v[keys[i]] !== "") return v[keys[i]];
    }
    return "";
  }
  function toast(msg) {
    var t = document.getElementById("fnExtToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "fnExtToast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  /* ---------------- 播放器 store 自省（React fiber） ---------------- */
  function isStore(o) {
    // 飞牛自定义 store：实例只有 state/get/getState/setState/subscribe，
    // actions（含 addAndPlayTrack）挂在 getState() 返回的 state 上
    if (!o || typeof o.getState !== "function") return false;
    try {
      var st = o.getState();
      if (st && typeof st.addAndPlayTrack === "function") return true;
    } catch (e) {}
    return typeof o.addAndPlayTrack === "function";
  }
  function isStoreRef(o) {
    return o && o.current && isStore(o.current);
  }
  function unwrapStore(v) {
    if (isStore(v)) return v;
    if (isStoreRef(v)) return v.current;
    return null;
  }
  function fiberLike(n) {
    return !!n && (n.child !== undefined || n.stateNode !== undefined ||
      n.memoizedState !== undefined || n.memoizedProps !== undefined ||
      n.return !== undefined || n.tag !== undefined);
  }
  function derefFiber(node) {
    // React18 createRoot: container.__reactContainer$<id> = FiberRoot, FiberRoot.current = HostRoot fiber
    var n = node, guard = 0;
    while (n && !fiberLike(n) && n.current && guard < 6) { n = n.current; guard++; }
    return n;
  }
  function getRootFiber() {
    var rootEl = document.getElementById("root") || document.body;
    if (!rootEl) return null;
    var keys = [];
    for (var k in rootEl) { if (k.indexOf("__react") === 0) keys.push(k); }
    for (var i = 0; i < keys.length; i++) {
      var f = derefFiber(rootEl[keys[i]]);
      if (fiberLike(f)) return f;
    }
    return null;
  }
  function unwrapStoreDeep(v) {
    var s = unwrapStore(v);
    if (s) return s;
    if (v && typeof v === "object" && !Array.isArray(v) && v.current) {
      var s2 = unwrapStore(v.current);
      if (s2) return s2;
    }
    return null;
  }
  function scanForStore() {
    var root = getRootFiber();
    if (!root) { storeError = "no root fiber"; return null; }
    var found = null, seen = [], queue = [root];
    while (queue.length && !found) {
      var f = queue.shift();
      if (!f || seen.indexOf(f) !== -1) continue;
      seen.push(f);
      try {
        // 1. memoizedProps（含 storeRef/playerRef 等命名 ref，或任意 {current:store}）
        var p = f.memoizedProps;
        if (p && typeof p === "object") {
          for (var k in p) {
            var s = unwrapStoreDeep(p[k]);
            if (s) { found = s; break; }
          }
        }
        // 2. hooks memoizedState 链表：useRef(store) 的 memoizedState = {current:store}
        if (!found) {
          var hook = f.memoizedState;
          var hg = 0;
          while (hook && hg < 120) {
            var s3 = unwrapStoreDeep(hook.memoizedState);
            if (s3) { found = s3; break; }
            hook = hook.next;
            hg++;
          }
        }
        // 3. stateNode（类组件直接持有 store）
        if (!found && f.stateNode && isStore(f.stateNode)) found = f.stateNode;
      } catch (e) {}
      if (found) break;
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    storeError = found ? "" : "scanned " + seen.length + " fibers, no store";
    return found;
  }
  function captureStore() {
    if (store) return store;
    var s = scanForStore();
    if (s) { store = s; storeReady = true; }
    return s;
  }
  function waitStore(cb, tries) {
    tries = tries || 0;
    if (captureStore()) { cb(store); return; }
    if (tries > 60) { cb(null); return; }
    setTimeout(function () { waitStore(cb, tries + 1); }, 500);
  }

  /* ---------------- track 构造（复用旧方案已验证结构 + 补 url） ---------------- */
  function buildTrack(song) {
    var guid = norm(song, ["guid", "id", "trackId", "trackGUID"]) || "";
    var title = norm(song, ["title", "name", "songName", "trackName"]) || "在线歌曲";
    var artist = norm(song, ["artist", "artistName", "singer"]) || "群星";
    var album = norm(song, ["album", "albumName"]) || "精选专辑";
    var cover = norm(song, ["cover_url", "coverUrl", "coverURL", "cover"]);
    if (!cover && guid) cover = "/music/api/v1/static/cover?coverId=" + encodeURIComponent(guid);
    var dur_s = parseFloat(norm(song, ["duration_s", "durationSec"])) || 0;
    if (!dur_s && song.duration) dur_s = (song.duration > 1000 ? song.duration / 1000 : song.duration);
    dur_s = dur_s || 240;
    var dur_ms = Math.round(dur_s * 1000);
    var ext = (norm(song, ["ext", "format"]) || "mp3").toLowerCase();
    var src = norm(song, ["source"]) || (guid.split(":")[1]) || "kw";
    var isLossless = ["flac", "wav", "ape", "wv", "aiff", "m4a"].indexOf(ext) !== -1;
    var size = parseInt(norm(song, ["size", "file_size", "fileSize"]), 10);
    if (!size) size = isLossless && dur_s > 0 ? Math.round(dur_s * 1200000) : 31457280;
    var streamUrl = "/music/api/v1/track/stream?guid=" + encodeURIComponent(guid);
    var audioSpec = {
      path: "online/" + src + "/" + guid + "." + ext, format: ext, codec: ext, container: ext,
      duration: dur_ms, size: size, channel: 2, sampleRate: 44100,
      bitrate: isLossless ? 1411000 : 320000
    };
    if (["flac", "wav", "aiff"].indexOf(ext) !== -1) audioSpec.bitDepth = 16;
    var track = {
      id: guid, guid: guid, title: title, name: title,
      artist: artist, artists: [{ name: artist, guid: guid + ":artist" }],
      album: { name: album, guid: guid + ":album", coverId: guid },
      albumName: album,
      duration: dur_ms, durationMs: dur_ms, duration_ms: dur_ms, duration_s: dur_s,
      audioSpec: audioSpec, codec: ext, format: ext, ext: ext,
      size: size, file_size: size,
      coverId: guid, coverUrl: cover, cover_url: cover, coverURL: cover,
      is_online: true,
      streamUrl: streamUrl,
      url: streamUrl,
      audioUrl: streamUrl
    };
    if (typeof window.__FN_CREATE_TRACK__ === "function") {
      try { track = window.__FN_CREATE_TRACK__(track); } catch (e) {}
    }
    return track;
  }
  function playTrack(song) {
    var s = captureStore();
    if (!s) { toast("播放器未就绪，请稍候重试"); return; }
    try {
      var t = buildTrack(song);
      var st = null;
      try { st = s.getState(); } catch (e) {}
      var target, fn;
      if (st && typeof st.addAndPlayTrack === "function") { target = st; fn = st.addAndPlayTrack; }
      else if (typeof s.addAndPlayTrack === "function") { target = s; fn = s.addAndPlayTrack; }
      else { toast("播放器不支持注入播放"); return; }
      fn.call(target, t);
      toast("正在播放: " + t.title + " - " + t.artist);
    } catch (e) {
      console.warn("[fnExt] play failed", e);
      toast("播放失败: " + (e && e.message ? e.message : e));
    }
  }

  /* ---------------- 当前播放曲目 ---------------- */
  function currentTrack() {
    var s = captureStore();
    if (!s) return null;
    try { return s.getState().currentTrack; } catch (e) { return null; }
  }
  function currentOnlineGuid() {
    var cur = currentTrack();
    if (!cur) return "";
    var g = norm(cur, ["guid", "id", "trackId", "trackGUID"]) || "";
    return g && String(g).indexOf("online:") === 0 ? g : "";
  }

  /* ---------------- 搜索/列表结果归一化 ---------------- */
  function extractTracks(res) {
    var list = [];
    try {
      var data = res && res.data;
      if (Array.isArray(res)) list = res;
      else if (Array.isArray(data)) list = data;
      else if (data && Array.isArray(data.list)) list = data.list;
      else if (data && data.data && Array.isArray(data.data.list)) list = data.data.list;
      else if (data && Array.isArray(data.items)) list = data.items;
      else if (data && Array.isArray(data.tracks)) list = data.tracks;
      else if (data && Array.isArray(data.songs)) list = data.songs;
      else if (Array.isArray(res && res.list)) list = res.list;
    } catch (e) {}
    return list.map(function (it) {
      var artists = it.artists;
      var artist = it.artist || it.artistName || (artists && artists[0] && (artists[0].name || artists[0])) || "";
      return {
        guid: norm(it, ["guid", "id", "trackId", "trackGUID"]),
        id: norm(it, ["guid", "id"]),
        title: norm(it, ["title", "name", "songName"]),
        artist: artist,
        album: (it.album && (it.album.name || it.album)) || it.albumName || "",
        cover_url: norm(it, ["cover_url", "coverUrl", "coverURL", "cover"]) ||
          (it.album && (it.album.cover || it.album.coverUrl)) || "",
        duration_s: parseFloat(norm(it, ["duration_s", "durationSec"])) ||
          (it.duration ? (it.duration > 1000 ? it.duration / 1000 : it.duration) : 0),
        ext: it.ext || it.format,
        source: it.source || it.badge || ""
      };
    });
  }

  /* ---------------- 通用弹层 ---------------- */
  function ensureRoot() {
    var r = document.getElementById("fnExtRoot");
    if (!r) {
      r = document.createElement("div");
      r.id = "fnExtRoot";
      document.body.appendChild(r);
    }
    return r;
  }
  function closeLayer() {
    var m = document.getElementById("fnExtLayer");
    if (m) m.remove();
  }
  function openLayer(title, bodyHtml, opts) {
    opts = opts || {};
    closeLayer();
    var root = ensureRoot();
    var layer = document.createElement("div");
    layer.id = "fnExtLayer";
    layer.className = "fnExtLayer" + (opts.wide ? " wide" : "");
    layer.innerHTML =
      '<div class="fnExtBackdrop"></div>' +
      '<div class="fnExtCard">' +
      '<div class="fnExtHead"><span>' + escapeHtml(title) + '</span>' +
      '<button class="fnExtClose" title="关闭">×</button></div>' +
      '<div class="fnExtBody">' + bodyHtml + '</div>' +
      '</div>';
    root.appendChild(layer);
    layer.querySelector(".fnExtBackdrop").addEventListener("click", closeLayer);
    layer.querySelector(".fnExtClose").addEventListener("click", closeLayer);
    return layer;
  }

  /* ---------------- 换源 ---------------- */
  function openSourceModal() {
    var cur = currentTrack();
    if (!cur) {
      toast("播放器尚未就绪，请稍候或刷新页面后重试");
      return;
    }
    var guid = currentOnlineGuid();
    if (!guid) {
      toast("当前是本地歌曲，换源仅支持在线歌曲（请先播放在线歌曲）");
      return;
    }
    var layer = openLayer("更换音源", '<div id="fnExtSrcList" class="fnList">加载候选源...</div>');
    var box = layer.querySelector("#fnExtSrcList");
    fetch("/music/ext/api/track/alternatives?guid=" + encodeURIComponent(guid))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || res.code !== 0 || !res.data || !res.data.items || !res.data.items.length) {
          box.innerHTML = '<div class="fnNote">暂无其他可用音源</div>';
          return;
        }
        box.innerHTML = res.data.items.map(function (it, i) {
          var cov = it.cover_url
            ? '<img class="fnCov" src="' + escapeHtml(it.cover_url) + '" onerror="this.style.display=\'none\'">'
            : '<div class="fnCov fnCovEmpty"></div>';
          return '<div class="fnSrcItem" data-i="' + i + '">' + cov +
            '<div class="fnMeta"><div class="fnTitle">' + escapeHtml(it.title) + '</div>' +
            '<div class="fnSub">' + escapeHtml(it.artist) + ' · ' + escapeHtml(it.source || it.badge || "未知") +
            ' · ' + (it.duration_s ? Math.round(it.duration_s) + 's' : "") + '</div></div></div>';
        }).join("");
        Array.prototype.forEach.call(box.querySelectorAll(".fnSrcItem"), function (el) {
          el.addEventListener("click", function () {
            var it = res.data.items[+el.getAttribute("data-i")];
            playTrack(it);
            closeLayer();
          });
        });
      })
      .catch(function () { box.innerHTML = '<div class="fnNote">加载失败</div>'; });
  }

  /* ---------------- 在线音乐 ---------------- */
  function openOnline() {
    var layer = openLayer("在线音乐",
      '<div class="fnSearch"><input id="fnExtSearchInput" placeholder="搜索歌曲 / 歌手">' +
      '<button id="fnExtSearchBtn">搜索</button></div>' +
      '<div id="fnExtOnlineList" class="fnList"></div>', { wide: true });
    var input = layer.querySelector("#fnExtSearchInput");
    var list = layer.querySelector("#fnExtOnlineList");
    function doSearch() {
      var kw = input.value.trim();
      if (!kw) return;
      list.innerHTML = '<div class="fnNote">搜索中...</div>';
      fetch("/music/api/v1/search/track?keyword=" + encodeURIComponent(kw) + "&size=30")
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var items = extractTracks(res).filter(function (t) { return t.guid && String(t.guid).indexOf("online:") === 0; });
          if (!items.length) {
            list.innerHTML = '<div class="fnNote">无在线结果（可换关键词试试）</div>';
            return;
          }
          list.innerHTML = items.map(function (it, i) {
            return '<div class="fnTrack" data-i="' + i + '"><div class="fnTitle">' + escapeHtml(it.title) +
              '</div><div class="fnSub">' + escapeHtml(it.artist) + (it.album ? " · " + escapeHtml(it.album) : "") +
              ' · ' + escapeHtml(it.source || "在线") + '</div></div>';
          }).join("");
          Array.prototype.forEach.call(list.querySelectorAll(".fnTrack"), function (el) {
            el.addEventListener("click", function () { playTrack(items[+el.getAttribute("data-i")]); });
          });
        })
        .catch(function () { list.innerHTML = '<div class="fnNote">搜索失败</div>'; });
    }
    layer.querySelector("#fnExtSearchBtn").addEventListener("click", doSearch);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
    setTimeout(function () { input.focus(); }, 50);
  }

  /* ---------------- 心动歌曲（收藏） ---------------- */
  function openFav() {
    var layer = openLayer("心动歌曲", '<div id="fnExtFavList" class="fnList">加载中...</div>', { wide: true });
    var list = layer.querySelector("#fnExtFavList");
    fetch("/music/api/v1/favorite-track/list")
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var items = extractTracks(res);
        if (!items.length) { list.innerHTML = '<div class="fnNote">还没有收藏</div>'; return; }
        list.innerHTML = items.map(function (it, i) {
          return '<div class="fnTrack" data-i="' + i + '"><div class="fnTitle">' + escapeHtml(it.title) +
            '</div><div class="fnSub">' + escapeHtml(it.artist) + (it.album ? " · " + escapeHtml(it.album) : "") + '</div></div>';
        }).join("");
        Array.prototype.forEach.call(list.querySelectorAll(".fnTrack"), function (el) {
          el.addEventListener("click", function () { playTrack(items[+el.getAttribute("data-i")]); });
        });
      })
      .catch(function () { list.innerHTML = '<div class="fnNote">加载失败</div>'; });
  }

  /* ---------------- 下载到 NAS ---------------- */
  function downloadCurrentTrack() {
    var cur = currentTrack();
    if (!cur) { toast("未能识别当前歌曲，请确认正在播放或刷新页面后再试"); return; }
    var guid = norm(cur, ["guid", "id", "trackId", "trackGUID"]) || "";
    var title = norm(cur, ["title", "name", "songName"]) || "未知曲目";
    var artist = "";
    if (cur.artist) artist = cur.artist;
    else if (cur.artists && cur.artists.length) {
      artist = cur.artists.map(function (a) { return a.name || a; }).join(" / ");
    }
    if (!guid && !title) { toast("未能识别当前歌曲"); return; }
    toast("已加入后台下载任务: " + title);
    fetch("/music/ext/api/song/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guid: guid, title: title, artist: artist })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.code === 0) toast("下载任务已创建: " + (d.msg || title));
        else toast("下载失败: " + (d && d.msg || "未知"));
      })
      .catch(function (e) { toast("下载异常: " + e); });
  }

  /* ---------------- 下载管理（优先点击飞牛原生入口，失败再提示） ---------------- */
  function clickSidebarByText(texts) {
    var els = document.querySelectorAll('nav a, aside a, [class*="nav"] a, [class*="sidebar"] a, li, [role="menuitem"], [class*="MenuItem"]');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || "").trim();
      for (var j = 0; j < texts.length; j++) {
        if (t && t.indexOf(texts[j]) !== -1) {
          try { els[i].click(); return true; } catch (e) {}
        }
      }
    }
    return false;
  }
  function openDownloadManager() {
    if (clickSidebarByText(["下载", "下载管理", "我的下载"])) return;
    openLayer("下载管理", '<div class="fnNote">未找到飞牛「下载」入口，可在飞牛音乐左侧导航的「下载」中查看已下载歌曲。</div>');
  }

  /* ---------------- 浮动工具栏（彩色图标） ---------------- */
  function buildToolbar() {
    if (document.getElementById("fnExtToolbar")) return;
    var bar = document.createElement("div");
    bar.id = "fnExtToolbar";
    bar.innerHTML =
      '<div class="fnExtBtn fnExtBtn-heart" data-act="fav" title="心动歌曲"><span class="fnIco">❤</span><span>心动</span></div>' +
      '<div class="fnExtBtn fnExtBtn-dl" data-act="dl" title="下载当前歌曲到 NAS"><span class="fnIco">⬇</span><span>下载</span></div>' +
      '<div class="fnExtSep"></div>' +
      '<div class="fnExtBtn fnExtBtn-src" data-act="source" title="更换当前歌曲音源">换源</div>' +
      '<div class="fnExtBtn fnExtBtn-online" data-act="online" title="在线音乐搜索">在线</div>';
    document.body.appendChild(bar);
    bar.querySelector('[data-act="source"]').addEventListener("click", openSourceModal);
    bar.querySelector('[data-act="online"]').addEventListener("click", openOnline);
    bar.querySelector('[data-act="fav"]').addEventListener("click", openFav);
    bar.querySelector('[data-act="dl"]').addEventListener("click", downloadCurrentTrack);
    // 右键/长按「下载」按钮打开下载管理（保留快捷入口）
    bar.querySelector('[data-act="dl"]').addEventListener("contextmenu", function (e) {
      e.preventDefault();
      openDownloadManager();
    });
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    buildToolbar();
    waitStore(function (s) {
      if (s) console.log("[fnExt] player store captured");
      else console.warn("[fnExt] player store 未捕获（换源/在线播放将不可用，彩色图标与普通面板仍可用）");
    });
  }
  // 暴露给控制台调试
  window.__fnExt = {
    playTrack: playTrack,
    getStore: captureStore,
    openSourceModal: openSourceModal,
    openOnline: openOnline,
    openFav: openFav,
    downloadCurrentTrack: downloadCurrentTrack,
    openDownloadManager: openDownloadManager,
    currentTrack: currentTrack,
    diag: function () {
      var s = captureStore();
      return {
        storeReady: storeReady,
        hasStore: !!s,
        storeError: storeError,
        currentTrack: s ? currentTrack() : null,
        storeMethods: s ? (function () { var st = null; try { st = s.getState(); } catch (e) {} var src = (st && typeof st.addAndPlayTrack === "function") ? st : s; return Object.keys(src).filter(function (k) { return typeof src[k] === "function"; }).slice(0, 60); })() : []
      };
    }
  };

  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
  // SPA 挂载可能晚于 DOMContentLoaded，再补一次
  setTimeout(init, 1200);
  setTimeout(init, 3500);
})();
