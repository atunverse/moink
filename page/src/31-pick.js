/* ==================================================================
   31-pick.js —— 选图 / EXIF 摆正 / 拖放粘贴
   ================================================================== */
/* ---------- 选图（R1.0.17：EXIF 归一 + 换图重置裁剪旋转） ---------- */
var imgUrl = null;
/* 照片的拍摄日期（EXIF DateTimeOriginal）；读不到就退回文件修改时间。
   日期控件默认用它，用户也可以直接改字。 */
var shotDate = null;
var pendingShotDate = null;
/* 读 JPEG EXIF orientation（1=已正，2~8=需摆正）；非 JPEG/解析失败返回 1。
   只扫段头，不做完整解码。 */
function exifOrientation(buf){
  var d = new DataView(buf);
  if (d.byteLength < 4 || d.getUint16(0) !== 0xFFD8) return 1;
  var off = 2;
  while (off + 4 < d.byteLength){
    if (d.getUint8(off) !== 0xFF){ off++; continue; }
    var m = d.getUint8(off + 1);
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)){ off += 2; continue; }
    if (m === 0xD9 || m === 0xDA) break;   /* EOI / SOS：后面不会有 EXIF */
    if (m === 0xE1 && d.getUint32(off + 4) === 0x45786966){  /* APP1 "Exif" */
      var tiff = off + 10;
      if (tiff + 8 > d.byteLength) return 1;
      var little = d.getUint16(tiff) === 0x4949;
      var ifd = tiff + d.getUint32(tiff + 4, little);
      var n = d.getUint16(ifd, little);
      for (var i = 0; i < n; i++){
        var e = ifd + 2 + i * 12;
        if (d.getUint16(e, little) === 0x0112) return d.getUint16(e + 8, little);
      }
      return 1;
    }
    off += 2 + d.getUint16(off + 2);   /* 跳到下一 marker */
  }
  return 1;
}
/* 读一个 ASCII 型 IFD 条目（EXIF 的日期就是 ASCII，20 字节含结尾 0） */
function exifAscii(d, tiff, entries, n, little, tag){
  for (var i = 0; i < n; i++){
    var e = entries + i * 12;
    if (d.getUint16(e, little) !== tag) continue;
    var cnt = d.getUint32(e + 4, little);
    var vo = (cnt > 4) ? (tiff + d.getUint32(e + 8, little)) : (e + 8);
    if (vo <= 0 || vo + 4 > d.byteLength) return "";
    var s = "", k;
    for (k = 0; k < Math.min(cnt, 19); k++){
      var c = d.getUint8(vo + k);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  return "";
}
function parseExifDate(s){
  var m = /^(\d{4})[:/-](\d{2})[:/-](\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ""));
  if (!m) return null;
  var dt = new Date(+m[1], (+m[2]) - 1, +m[3], +m[4], +m[5], 0);
  return isNaN(dt.getTime()) ? null : dt;
}
/* 读拍摄日期：优先 Exif 子 IFD 的 DateTimeOriginal，其次 IFD0 的 DateTime。
   只扫段头，不做完整解码；读不到返回 null。 */
function exifDateTime(buf){
  var d = new DataView(buf);
  if (d.byteLength < 4 || d.getUint16(0) !== 0xFFD8) return null;
  var off = 2;
  while (off + 4 < d.byteLength){
    if (d.getUint8(off) !== 0xFF){ off++; continue; }
    var m = d.getUint8(off + 1);
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)){ off += 2; continue; }
    if (m === 0xD9 || m === 0xDA) break;
    if (m === 0xE1 && d.getUint32(off + 4) === 0x45786966){
      var tiff = off + 10;
      if (tiff + 8 > d.byteLength) return null;
      var little = d.getUint16(tiff) === 0x4949;
      var ifd = tiff + d.getUint32(tiff + 4, little);
      if (ifd + 2 > d.byteLength) return null;
      var n = d.getUint16(ifd, little), s = "", i;
      for (i = 0; i < n; i++){
        var e = ifd + 2 + i * 12;
        if (d.getUint16(e, little) !== 0x8769) continue;
        var sub = tiff + d.getUint32(e + 8, little);
        if (sub + 2 > d.byteLength) break;
        s = exifAscii(d, tiff, sub + 2, d.getUint16(sub, little), little, 0x9003);
      }
      if (!s) s = exifAscii(d, tiff, ifd + 2, n, little, 0x0132);
      return s ? parseExifDate(s) : null;
    }
    off += 2 + d.getUint16(off + 2);
  }
  return null;
}
/* 采纳图片：收编对象/URL、重置裁剪旋转（不跨图记忆）、走既有初始化链 */
function adoptImg(im2, url, f){
  if (imgUrl && imgUrl !== url) URL.revokeObjectURL(imgUrl);
  imgUrl = url;
  img = im2;
  shotDate = pendingShotDate || null;
  pendingShotDate = null;
  curRot = 0; cfg.cropRot = 0; syncRotUI();   /* R1.0.17: 换图重置裁剪旋转 */
  previewOK = false;   /* 新图未预览，先锁上传 */
  $("filerow").classList.add("show");
  $("stage").classList.remove("empty");
  $("thumb").src = im2.src;
  $("fname").textContent = f.name + "  ·  " + im2.naturalWidth + "×" + im2.naturalHeight;
  msg("正在处理…", "");
  destroyCrop();
  autoCompose = true;        /* initCrop 的 ready 回调会据此弹出构图面板 */
  setMode(MODE, true);
  if (MODE === 0) goEl.disabled = true;   /* 预览跑通前禁止上传 */
  goOnlyEl.disabled = goEl.disabled;
  schedulePreview(false);
}
function loadFile(f){
  if (!f) return;
  if (!/^image\//.test(f.type)){ msg("请选择图片文件", "err"); return; }
  var url = URL.createObjectURL(f);
  var im = new Image();
  im.onload = function(){
    /* EXIF 归一：仅 JPEG 且方向标记 2~8 时，经 canvas 重绘烤正（drawImage 在
       from-image 内核上已按 EXIF 摆正），不再依赖 Cropper 的 XHR EXIF 方案；
       其余图片零额外成本。 */
    if (!/^image\/jpeg$/.test(f.type)){
      pendingShotDate = f.lastModified ? new Date(f.lastModified) : null;
      adoptImg(im, url, f); return;
    }
    var fr = new FileReader();
    fr.onload = function(){
      var o = 1;
      try { o = exifOrientation(fr.result); } catch(e){}
      try { pendingShotDate = exifDateTime(fr.result); } catch(e){ pendingShotDate = null; }
      if (!pendingShotDate && f.lastModified) pendingShotDate = new Date(f.lastModified);
      if (o < 2 || o > 8){ adoptImg(im, url, f); return; }
      var cv = document.createElement("canvas");
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      cv.getContext("2d").drawImage(im, 0, 0);
      cv.toBlob(function(b){
        if (!b || !/^image\//.test(b.type)){ adoptImg(im, url, f); return; }  /* 烤制失败兜底走原图 */
        /* R1.0.22：revoke 挪到结果分支里——兜底路径还要用 url，提前吊销会让兜底图裂 */
        var u2 = URL.createObjectURL(b);
        var im2 = new Image();
        im2.onload = function(){ URL.revokeObjectURL(url); adoptImg(im2, u2, f); };
        im2.onerror = function(){ URL.revokeObjectURL(u2); adoptImg(im, url, f); };
        im2.src = u2;
      }, "image/jpeg", 0.95);
    };
    fr.onerror = function(){ adoptImg(im, url, f); };
    fr.readAsArrayBuffer(f);
  };
  im.onerror = function(){ msg("图片解码失败，换一张试试", "err"); };
  im.src = url;
}
/* 部分品牌安卓手机Android captive WebView 没实现 onShowFileChooser 时，input 仍会收到 click，但页面
   不会失焦/隐藏，也不会收到 change。首次点击启动一次检测，连续点击不重置计时器；PC/iOS
   永不显示，能正常拉起相册的 Android 浏览器也保持隐藏。 */
var pickerLeftPage = false, pickerTimer = 0;
function pickerDidLeave(){ if (pickerTimer) pickerLeftPage = true; }
window.addEventListener("blur", pickerDidLeave);
document.addEventListener("visibilitychange", function(){ if (document.hidden) pickerDidLeave(); });
fileEl.addEventListener("click", function(){
  if (!captivePage || !/Android/i.test(navigator.userAgent)) return;
  if (pickerTimer || $("browserFallback").classList.contains("show")) return;
  pickerLeftPage = false;
  pickerTimer = setTimeout(function(){
    pickerTimer = 0;
    if (!pickerLeftPage) $("browserFallback").classList.add("show");
  }, 800);
});
fileEl.addEventListener("change", function(){
  clearTimeout(pickerTimer);
  pickerTimer = 0;
  pickerLeftPage = false;
  $("browserFallback").classList.remove("show");
  loadFile(fileEl.files[0]);
});
["dragenter","dragover"].forEach(function(ev){
  document.addEventListener(ev, function(e){ e.preventDefault(); });
});
document.addEventListener("drop", function(e){
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
document.addEventListener("paste", function(e){
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (var i = 0; i < items.length; i++){
    if (items[i].type.indexOf("image") === 0){
      loadFile(items[i].getAsFile()); return;
    }
  }
});
