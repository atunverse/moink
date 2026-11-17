/* ==================================================================
   41-gallery.js —— 设备图槽（列表 / 大图 / 删 / 清空）
   ================================================================== */
/* ---------- 轮播图库（R1.3.1） ---------- */
var galGridEl = $("galGrid");
var caroStateEl = $("caromsg");
var PAL_RGB = [ [0,0,0], [255,255,255], [255,255,0], [255,0,0] ];   /* 0黑 1白 2黄 3红，与 quantize 色板一致 */

/* 解码 2bpp 帧为 ImageData：与固件/合成管线的 packIdx 契约一致
   （行自下而上、列右到左、字节内 MSB 优先），画布顶行 = 设备底行。 */
function decodeFrame(payload, w, h){
  var RB = w >> 2, img = new ImageData(w, h), d = img.data;
  for (var r = 0; r < h; r++){
    var bo = r * RB;
    for (var xb = 0; xb < RB; xb++){
      var v = payload[bo + xb];
      var xa = w - 4 - (xb << 2);
      for (var k = 0; k < 4; k++){
        var c = (v >> (k * 2)) & 3;
        var px = xa + k, cy = h - 1 - r;
        var o = (cy * w + px) * 4;
        d[o] = PAL_RGB[c][0]; d[o+1] = PAL_RGB[c][1]; d[o+2] = PAL_RGB[c][2]; d[o+3] = 255;
      }
    }
  }
  return img;
}
/* 渲染到画布：rot=true 时旋转 90° 竖向显示（与编辑界面方向一致——
   上传时前端把竖向合成图顺时针转 90° 打包成设备横向帧，因此设备帧回到
   竖向须逆时针转 90°。缩略图/大图预览均用）。 */
function renderFrameToCanvas(canvas, payload, w, h, rot){
  var tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  tmp.getContext("2d").putImageData(decodeFrame(payload, w, h), 0, 0);
  canvas.width = rot ? h : w;
  canvas.height = rot ? w : h;
  var ctx = canvas.getContext("2d");
  if (rot){
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(tmp, 0, 0, w, h);
}
function b64ToBytes(b64){
  var bin = atob(b64), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function refreshGallery(){
  if (LOCAL_PREVIEW){
    /* 本地预览没有设备可问，但槽位骨架要画出来，否则面板像坏了 */
    var ph = [];
    for (var q = 0; q < 8; q++) ph.push('<div class="galEmpty">空</div>');
    galGridEl.innerHTML = ph.join("");
    caroStateEl.textContent = "本地预览";
    return;
  }
  fetch(api("/api/carousel/list")).then(function(r){ return r.json(); }).then(function(j){
    caroStateEl.textContent = (j.count || 0) + " / " + (j.slots || 0) + " 张";
    var html = [], items = j.items || [];
    for (var i = 0; i < (j.slots || 8); i++){
      var it = null;
      for (var k = 0; k < items.length; k++) if (items[k].slot === i) { it = items[k]; break; }
      if (it && it.len > 0){
        /* fmt=2 彩色 JPEG 缩略 → <img> 直接显示；fmt=1 2bit → canvas 旋转渲染 */
        var isJpg = (it.fmt === 2);
        html.push('<div class="galCell' + (i === j.cur ? ' cur' : '') + '" data-slot="' + i + '">'
                + (isJpg ? '<img data-slot="' + i + '" alt="">' : '<canvas data-slot="' + i + '"></canvas>')
                + '<span class="num">' + (i + 1) + '</span>'
                + (i === j.cur ? '<span class="tick">\u2713</span>' : '')
                + '</div>');
      } else {
        html.push('<div class="galEmpty">空</div>');
      }
    }
    galGridEl.innerHTML = html.join("");
    var thumbs = galGridEl.querySelectorAll(".galCell canvas, .galCell img");
    for (var m = 0; m < thumbs.length; m++){
      var s = parseInt(thumbs[m].getAttribute("data-slot"), 10);
      for (var k2 = 0; k2 < items.length; k2++){
        if (items[k2].slot === s){
          try {
            if (items[k2].fmt === 2)
              thumbs[m].src = "data:image/jpeg;base64," + items[k2].data;
            else
              renderFrameToCanvas(thumbs[m], b64ToBytes(items[k2].data), items[k2].w, items[k2].h, true);
          } catch(e){ /* 缩略图渲染失败留空 */ }
          break;
        }
      }
    }
    /* 底栏「保存」角标 = 已存张数 */
    var badge = $("savBadge");
    if (badge){
      var n = j.count || 0;
      badge.textContent = n;
      badge.style.display = n ? "" : "none";
    }
  }).catch(function(){ caroStateEl.textContent = "未连接"; });
}

/* R1.3.4（FB-020）：删除/清空期间锁住图库。
   删除在固件里是「整槽擦写 + 后续槽逐个前移」，删前面的图要数秒到十余秒；
   这个窗口内再点一次 × 会带着**页面上的旧索引**发出第二次请求 ——
   轻则 404，重则静默删掉相邻的另一张（不可恢复）。 */
var caroBusy = false;
function caroLock(on, msg){
  caroBusy = !!on;
  try {
    galGridEl.style.pointerEvents = on ? "none" : "";
    galGridEl.style.opacity = on ? "0.55" : "";
  } catch(e){}
  var bs = galGridEl.querySelectorAll(".galDel");
  for (var i = 0; i < bs.length; i++) bs[i].disabled = !!on;
  if (msg) saveState("caromsg", "busy", msg);
}
function caroFail(prefix, status, body){
  var extra = body ? (" · " + String(body).replace(/\s+/g, " ").slice(0, 60)) : "";
  saveState("caromsg", "err", prefix + "：HTTP " + status + extra);
}
function deleteSlot(slot){
  if (caroBusy) return;
  if (!confirm("删除这张轮播图？")) return;
  caroLock(true, "正在删除…");
  fetch(api("/api/carousel/delete?slot=" + slot), { method: "POST" }).then(function(r){
    return r.text().then(function(t){
      return { ok: r.status === 200, status: r.status, body: t };
    });
  }).then(function(x){
    if (x.ok) saveState("caromsg", "ok", "已删除");
    else if (x.status === 404) saveState("caromsg", "err", "这张图已不在（可能已被删除），正在刷新图库");
    else if (x.status === 503) saveState("caromsg", "err", "设备正忙，请稍后重试");
    else caroFail("删除失败", x.status, x.body);
  }).catch(function(){
    saveState("caromsg", "err", "网络错误（删除可能已生效，请核对图库）");
  }).then(function(){
    caroLock(false);
    refreshGallery();
  });
}

var prevSlot = -1;   /* 大图预览当前打开的槽，「显示到屏幕」用 */
function showPreview(slot){
  if (LOCAL_PREVIEW) return;
  /* R1.3.4：读取大图期间弹上传同款遮罩——锁定操作 + 进度反馈 */
  showWorkLoading("正在读取…");
  fetch(api("/api/carousel/full?slot=" + slot)).then(function(r){
    if (r.status !== 200) throw new Error("HTTP " + r.status);
    return r.arrayBuffer();
  }).then(function(ab){
    var u8 = new Uint8Array(ab);
    var w = (u8[4] << 8) | u8[5], h = (u8[6] << 8) | u8[7];
    renderFrameToCanvas($("prevCanvas"), u8.subarray(16), w, h, true);
    hideWorkLoading();
    prevSlot = slot;
    $("prevShow").disabled = false;
    saveState("prevmsg", "", "");
    $("prevOverlay").style.display = "flex";
  }).catch(function(e){ hideWorkLoading(); saveState("caromsg", "err", "预览失败：" + e.message); });
}

/* 预览窗口「显示到屏幕」：固件只校验并排队，刷屏异步进行，**刷屏成功后才更新 cur**。
   四色屏整屏刷新远不止 2~4 s（驱动超时留到 45 s），固定延时刷新图库会拿到旧 cur，
   「当前」高亮不动。改为轮询 /api/info 的 store_cur（比 list 轻，不带缩略图），
   等到目标张再刷新图库；最多 60 s 截止——有界轮询，不会让设备永不休眠。
   showSeq：连点另一张时作废上一轮轮询。 */
var showSeq = 0;
function waitSlotShown(slot){
  var seq = ++showSeq, t0 = Date.now();
  /* 预览窗口可能已换成别的图：提示只写给仍在预览这张的窗口，图库照常刷新 */
  function say(kind, text){ if (prevSlot === slot) saveState("prevmsg", kind, text); }
  function next(){
    if (seq !== showSeq) return;
    if (Date.now() - t0 > 60000){
      say("warn", "⚠ 60 秒内未确认屏幕已切换，请看屏幕");
      refreshGallery();
      return;
    }
    setTimeout(poll, 2000);
  }
  function poll(){
    if (seq !== showSeq) return;
    fetch(api("/api/info?t=" + Date.now())).then(function(r){ return r.json(); }).then(function(j){
      if (seq !== showSeq) return;
      if (+j.store_cur === slot){
        say("ok", "✓ 屏幕已显示这张");
        refreshGallery();
        return;
      }
      next();
    }).catch(next);
  }
  setTimeout(poll, 2000);
}
function showSlotOnDevice(){
  if (caroBusy || prevSlot < 0) return;
  var btn = $("prevShow"), slot = prevSlot;
  btn.disabled = true;
  saveState("prevmsg", "busy", "正在发送…");
  fetch(api("/api/carousel/show?slot=" + slot), { method: "POST" }).then(function(r){
    return r.text().then(function(t){
      return { ok: r.status === 200, status: r.status, body: t };
    });
  }).then(function(x){
    if (x.ok){
      saveState("prevmsg", "busy", "已发送到屏幕，正在刷新…");
      waitSlotShown(slot);
    } else if (x.status === 404 && /no such slot/.test(x.body)){
      saveState("prevmsg", "err", "这张图已不在（可能已被删除），请关闭预览后重试");
      refreshGallery();
    } else if (x.status === 404 || x.status === 405){
      saveState("prevmsg", "err", "当前固件不支持此功能，请先升级固件");
    } else if (x.status === 503){
      saveState("prevmsg", "err", "设备正忙，请稍后重试");
    } else {
      var extra = x.body ? (" · " + String(x.body).replace(/\s+/g, " ").slice(0, 60)) : "";
      saveState("prevmsg", "err", "显示失败：HTTP " + x.status + extra);
    }
  }).catch(function(){
    saveState("prevmsg", "err", "网络错误（可能已显示，请看屏幕）");
  }).then(function(){
    btn.disabled = false;
  });
}

function clearCarousel(){
  if (caroBusy) return;
  if (!confirm("清空全部轮播图片？")) return;
  caroLock(true, "正在清空…");
  fetch(api("/api/carousel/clear"), { method: "POST" }).then(function(r){
    return r.text().then(function(t){
      return { ok: r.status === 200, status: r.status, body: t };
    });
  }).then(function(x){
    if (x.ok) saveState("caromsg", "ok", "已清空轮播");
    else caroFail("清空失败", x.status, x.body);
  }).catch(function(){
    saveState("caromsg", "err", "网络错误（清空可能已生效，请核对图库）");
  }).then(function(){
    caroLock(false);
    refreshGallery();
  });
}

/* 单击只做「选中」（青绿描边）；打开大图 / 上屏 / 删除都在长按菜单里，
   由 50-ui.js 统一处理 —— 避免「点一下就把正在显示的画面换掉」的误触。 */
galGridEl.addEventListener("click", function(ev){
  var cell = ev.target.closest ? ev.target.closest(".galCell") : null;
  if (cell) selectSlot(parseInt(cell.getAttribute("data-slot"), 10));
});
$("carouselClear").addEventListener("click", clearCarousel);
$("prevShow").addEventListener("click", showSlotOnDevice);
$("prevClose").addEventListener("click", function(){ $("prevOverlay").style.display = "none"; });
$("prevOverlay").addEventListener("click", function(ev){
  if (ev.target && ev.target.id === "prevOverlay") this.style.display = "none";
});
refreshGallery();
