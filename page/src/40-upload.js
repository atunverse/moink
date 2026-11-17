/* ==================================================================
   40-upload.js —— 上传（刷新 / 只存图库 / 存远程）
   ================================================================== */
/* ---------- 上传 ---------- */
function setBar(frac){ barEl.style.display = "block"; fillEl.style.width = Math.round(frac*100) + "%"; }
function upload(){
  if (LOCAL_PREVIEW){
    msg("本地预览模式：请连接 MoInk 热点后打开 http://192.168.4.1 上传", "err");
    return;
  }
  if (MODE === 0 && !img){ msg("请先选择图片", "err"); return; }
  if (MODE === 0 && !previewOK){ msg("预览生成中，请稍候再上传", "err"); return; }
  goEl.disabled = true;
  goOnlyEl.disabled = true;
  msg("正在合成画面…", "");
  showWorkLoading("正在生成上传数据…");
  afterLoadingPaint(function(){ buildAndUpload("show"); });
}
/* R1.3.4（FB-018）：上传到图库 —— 占一个轮播槽但不刷新屏幕，
   批量入库不必逐张等刷屏；图库列表随即更新。 */
function uploadOnly(){
  if (LOCAL_PREVIEW){
    msg("本地预览模式：请连接 MoInk 热点后打开 http://192.168.4.1 上传", "err");
    return;
  }
  if (MODE === 0 && !img){ msg("请先选择图片", "err"); return; }
  if (MODE === 0 && !previewOK){ msg("预览生成中，请稍候再上传", "err"); return; }
  goEl.disabled = true;
  goOnlyEl.disabled = true;
  msg("正在合成画面…", "");
  showWorkLoading("正在生成上传数据…");
  afterLoadingPaint(function(){ buildAndUpload("save"); });
}
function buildAndUpload(mode){
  var doSave = (mode === "save");
  var payload;
  try { payload = packFull(); }
  catch(e){
    hideWorkLoading();
    msg("合成失败：" + e.message, "err");
    goEl.disabled = false;
    goOnlyEl.disabled = false;
    return;
  }
  var body = frameWithHeader(payload);
  /* R1.3.4（FB-018）：「上传并刷新屏幕」走无 save 的 /api/frame —— 只显示、
     不占轮播槽、不擦写 flash；「上传到图库」才用 save=1&noshow=1。
     R1.3.3 的彩色 JPEG 缩略只服务图库列表，不入库时不必生成与上传。 */
  var url = api(doSave ? "/api/frame?save=1&noshow=1" : "/api/frame");
  if (doSave) {
    try {
      var thumb = buildThumbJpeg();
      var nb = new Uint8Array(body.length + thumb.length);
      nb.set(body, 0); nb.set(thumb, body.length);
      body = nb;
      url += "&tlen=" + (thumb.length - 16);
    } catch(e){ /* 缩略生成失败：不带缩略上传，图库回退实时抽稀 */ }
  }
  msg("正在上传 " + (body.length/1024).toFixed(0) + " KB…", "");
  updateWorkLoading("正在上传… 0%");
  setBar(0);
  var xhr = new XMLHttpRequest();
  /* R1.3.4（FB-018）：doSave=true 才入库（save=1&noshow=1），
     否则只刷新不占槽；入库时轮播满 8 张固件回 507 */
  xhr.open("POST", url);
  xhr.timeout = 30000;   /* R1.0.22：软超时，弱信号下不挂死 */
  xhr.ontimeout = function(){
    hideWorkLoading();
    barEl.style.display = "none";
    msg("上传超时，请重试", "err");
    goEl.disabled = (MODE === 0) ? !img : false;
    goOnlyEl.disabled = goEl.disabled;
  };
  xhr.upload.onprogress = function(e){
    if (e.lengthComputable){
      var frac = e.loaded/e.total;
      setBar(frac);
      updateWorkLoading("正在上传… " + Math.round(frac*100) + "%");
    }
  };
  xhr.onload = function(){
    hideWorkLoading();
    barEl.style.display = "none";
    if (xhr.status === 200){
      if (doSave){
        msg("已存入图库（未刷新屏幕），双击设备按键可循环播放", "ok");
        refreshGallery();
      } else {
        msg("屏幕刷新中…（未加入图库、不占槽位）", "ok");
      }
    } else if (xhr.status === 507){
      msg("轮播已满 8 张：请先删除或清空再上传", "err");
      refreshGallery();
    } else { msg("上传失败：" + (xhr.responseText || ("HTTP " + xhr.status)), "err"); }
    goEl.disabled = (MODE === 0) ? !img : false;
    goOnlyEl.disabled = goEl.disabled;
  };
  xhr.onerror = function(){
    hideWorkLoading();
    barEl.style.display = "none";
    msg("网络错误：请确认已连接设备热点", "err");
    goEl.disabled = (MODE === 0) ? !img : false;
    goOnlyEl.disabled = goEl.disabled;
  };
  xhr.send(body);
}
goEl.addEventListener("click", upload);
goOnlyEl.addEventListener("click", uploadOnly);
