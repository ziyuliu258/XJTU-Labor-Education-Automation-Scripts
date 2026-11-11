// ==UserScript==
// @name         西交在线学习平台 · 解锁进度条 + 倍速
// @namespace    https://vpahw.xjtu.edu.cn/
// @version      1.1
// @description  解除 ckplayer 的“只能看已看过的部分”限制，解锁倍速播放，一键跳到结尾（触发平台自己的 100% 上报）
// @match        https://vpahw.xjtu.edu.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 原理（针对 vpahw.xjtu.edu.cn 当前前端 index-40948025.js）：
 *   1. 平台播放器是 ckplayer，创建时传 timeScheduleAdjust:1，
 *      但一按播放，页面的 play 监听会把 timeScheduleAdjust 改成 5
 *      （= 只有“看过的地方”能拖），并把 playbackrateOpen 设为 false（隐藏倍速菜单）。
 *      → 这里劫持 ckplayer 实例的 vars()，把它想设的 5 / false 强行改成 1 / true。
 *   2. 页面还给 <video> 用 Object.defineProperty 写了一个不可配置的 playbackRate，
 *      setter 是空函数，导致 video.playbackRate = 16 无效。
 *      → 在 document-start 改掉 Object.defineProperty，让它变成可配置，再 delete 掉这个属性。
 *   3. 页面监听 visibilitychange，切到后台就 pause。
 *      → 把 document.hidden 固定为 false。
 *   4. 页面在 'ended' 事件里直接 mutateAsync(100)，即“播完 = 100%”。
 *      → “跳到结尾”就是利用这条路径。
 *
 * ⚠️ 这个站有 devtools 检测（devtools-detector + 递归 debugger），
 *    按 F12 会在 1 秒内被跳回首页，所以别在播放页开控制台，用油猴。
 * ⚠️ 后台有进度校验（报错码 9999 “进度记录异常”），如果跳结尾报这个错，
 *    就改用 2x~4x 老老实实播。
 */

(function () {
  'use strict';

  var RATE = 0;                 // 0 = 不干预
  var player = null;            // 当前 ckplayer 实例
  var nativeDefineProperty = Object.defineProperty;

  /* ---------- 1. 解掉 <video>.playbackRate 的只读锁 ---------- */
  try {
    Object.defineProperty = function (obj, prop, desc) {
      if (
        prop === 'playbackRate' &&
        typeof HTMLMediaElement !== 'undefined' &&
        obj instanceof HTMLMediaElement
      ) {
        desc = Object.assign({}, desc, { configurable: true });
      }
      return nativeDefineProperty.call(Object, obj, prop, desc);
    };
  } catch (e) { /* ignore */ }

  /* ---------- 2. 让 document.hidden 永远为 false（后台继续播） ---------- */
  try {
    nativeDefineProperty(Document.prototype, 'hidden', {
      configurable: true,
      get: function () { return false; }
    });
    nativeDefineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get: function () { return 'visible'; }
    });
  } catch (e) { /* ignore */ }

  /* ---------- 3. 劫持 ckplayer 实例 ---------- */
  function forceUnlock() {
    try {
      if (player) {
        player.vars('timeScheduleAdjust', 1);   // 1 = 随便拖
        player.vars('playbackrateOpen', true);  // 显示倍速菜单
      }
    } catch (e) { /* ignore */ }
  }

  function adopt(inst) {
    if (!inst || inst.__unlocked) return;
    inst.__unlocked = true;
    player = inst;

    var rawVars = inst.vars ? inst.vars.bind(inst) : null;
    if (rawVars) {
      inst.vars = function (a, b) {
        if (typeof a === 'string') {
          if (a === 'timeScheduleAdjust') b = 1;
          if (a === 'playbackrateOpen') b = true;
        } else if (a && typeof a === 'object') {
          var o = {};
          for (var k in a) o[k] = a[k];
          if ('timeScheduleAdjust' in o) o.timeScheduleAdjust = 1;
          if ('playbackrateOpen' in o) o.playbackrateOpen = true;
          a = o;
        }
        return rawVars(a, b);
      };
    }

    forceUnlock();
    setTimeout(forceUnlock, 300);   // 页面在 play 后 ~300ms 会设回 5，这里补一刀
    setTimeout(forceUnlock, 1500);
  }

  function wrapCk(Orig) {
    if (typeof Orig !== 'function' || Orig.__xjtuWrapped) return Orig;
    var Wrapped = function (cfg) {
      var inst = new Orig(cfg);
      adopt(inst);
      return inst;
    };
    Wrapped.__xjtuWrapped = true;
    Wrapped.prototype = Orig.prototype;
    try { for (var k in Orig) Wrapped[k] = Orig[k]; } catch (e) { /* ignore */ }
    return Wrapped;
  }

  var realCk = null;
  try {
    nativeDefineProperty(window, 'ckplayer', {
      configurable: true,
      enumerable: true,
      get: function () { return realCk; },
      set: function (v) { realCk = wrapCk(v); }
    });
  } catch (e) { /* ignore */ }

  /* ---------- 4. 倍速维持 + 状态 ---------- */
  function getVideo() {
    return document.querySelector('#player video') || document.querySelector('video');
  }

  setInterval(function () {
    var v = getVideo();
    if (!v) return;
    try { delete v.playbackRate; } catch (e) { /* 非严格模式下失败也无所谓 */ }
    try {
      if (RATE && v.playbackRate !== RATE) v.playbackRate = RATE;
    } catch (e) { /* ignore */ }
    updateStatus();
  }, 500);

  function setRate(r) {
    RATE = r;
    var v = getVideo();
    if (v) {
      try { delete v.playbackRate; } catch (e) { /* ignore */ }
      try { v.playbackRate = r; } catch (e) { /* ignore */ }
    }
    forceUnlock();
    updateStatus();
  }

  function jumpEnd() {
    var v = getVideo();
    if (!v) { alert('还没找到视频，先点一下播放'); return; }
    var d = 0;
    try { d = player ? player.duration() : v.duration; } catch (e) { d = v.duration; }
    if (!d || !isFinite(d)) { alert('视频时长还没加载出来'); return; }
    var target = Math.max(0, d - 0.4);
    try {
      if (player) player.seek(target);
      else v.currentTime = target;
    } catch (e) {
      try { v.currentTime = target; } catch (e2) { /* ignore */ }
    }
    try {
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
    // seek 被弹回来的话再补一次
    setTimeout(function () {
      if (v.currentTime < target - 2) {
        try { v.currentTime = target; } catch (e) { /* ignore */ }
        try { if (player) player.seek(target); } catch (e) { /* ignore */ }
      }
    }, 600);
  }

  /* ---------- 5. 悬浮面板 ---------- */
  var statusEl = null;

  function updateStatus() {
    if (!statusEl) return;
    var v = getVideo();
    if (!v) { statusEl.textContent = '等待播放器…'; return; }
    var cur = fmt(v.currentTime), dur = fmt(v.duration);
    statusEl.textContent = cur + ' / ' + dur + '  ·  ' + (v.playbackRate || 1).toFixed(2) + 'x' +
      (player ? '  ·  已接管' : '  ·  未接管');
  }

  function fmt(s) {
    if (!s || !isFinite(s)) return '--:--';
    s = Math.floor(s);
    var m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function mkBtn(text, fn) {
    var b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'margin:2px;padding:3px 8px;border:1px solid #4b5563;border-radius:5px;' +
      'background:#374151;color:#fff;font-size:12px;cursor:pointer;line-height:1.4;';
    b.onmouseenter = function () { b.style.background = '#4b5563'; };
    b.onmouseleave = function () { b.style.background = '#374151'; };
    b.onclick = function (ev) { ev.stopPropagation(); fn(); };
    return b;
  }

  function buildUI() {
    if (document.getElementById('xjtu-unlock-ui')) return;
    if (!document.body) return;

    var box = document.createElement('div');
    box.id = 'xjtu-unlock-ui';
    box.style.cssText = 'position:fixed;right:16px;top:80px;z-index:2147483647;' +
      'background:rgba(17,24,39,.9);color:#fff;padding:8px 10px;border-radius:8px;' +
      'font:12px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35);user-select:none;width:186px;';

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;' +
      'font-weight:600;margin-bottom:4px;cursor:pointer;';
    head.innerHTML = '<span>播放器解锁</span><span style="opacity:.6">−</span>';

    var body = document.createElement('div');

    var row1 = document.createElement('div');
    [1, 1.5, 2, 4, 8, 16].forEach(function (r) {
      row1.appendChild(mkBtn(r + 'x', function () { setRate(r); }));
    });

    var row2 = document.createElement('div');
    row2.style.marginTop = '4px';
    row2.appendChild(mkBtn('跳到结尾', jumpEnd));
    row2.appendChild(mkBtn('解锁进度条', function () { forceUnlock(); setRate(RATE); }));

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'margin-top:4px;opacity:.75;font-size:11px;';
    statusEl.textContent = '等待播放器…';

    body.appendChild(row1);
    body.appendChild(row2);
    body.appendChild(statusEl);
    box.appendChild(head);
    box.appendChild(body);
    document.body.appendChild(box);

    var collapsed = false;
    head.onclick = function () {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'block';
      head.lastChild.textContent = collapsed ? '+' : '−';
    };

    updateStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
  // SPA 路由切换后 body 不会重建，但防止脚本注入晚于 DOM
  setTimeout(buildUI, 1200);
})();