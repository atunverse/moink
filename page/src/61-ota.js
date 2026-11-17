/* ==================================================================
   61-ota.js —— 更新恢复与升级
   ================================================================== */
/* ---------- 维护 ---------- */
/* ---------- 统一升级入口（R1.2.0，FB-015）----------
   固件与控制页走同一条 /api/upload，由固件按请求体首块内容嗅探分流，用户不需要
   判断本次升的是哪一种。这里用**同一套规则**预判类型：固件 OTA 成功后约 1 秒即
   重启，响应有可能发不出去，所以文案不能依赖响应。
   ★ 改 sniffKind() 必须同步改 src/ota_web.c 的 sniff_kind()。 */
var UP_URL = "http://192.168.4.1/api/upload";   /* 设备 SoftAP 地址恒定（无 STA 模式）：
       无论页面从设备内嵌 / 离线客户端 / 本地文件打开，上传都直达设备。 */
function sniffKind(bytes){
  if (bytes.length && bytes[0] === 0xE9) return "fw";        /* ESP 镜像魔数 */
  var head = "";
  for (var i = 0; i < bytes.length && i < 1024; i++) head += String.fromCharCode(bytes[i]);
  head = head.toLowerCase();
  return (head.indexOf("<!doctype") >= 0 || head.indexOf("<html") >= 0) ? "page" : "";
}
function readHead(file, cb){
  var fr = new FileReader();
  fr.onload  = function(){ cb(new Uint8Array(fr.result)); };
  fr.onerror = function(){ cb(new Uint8Array(0)); };
  fr.readAsArrayBuffer(file.slice(0, 1024));
}
$("upGo").addEventListener("click", function(){
  var f = $("upFile").files[0];
  if (!f){ saveState("upmsg", "err", "✗ 请先选择固件文件（.bin）"); return; }
  if (LOCAL_PREVIEW){ saveState("upmsg", "warn", "⚠ 本地预览（未连设备）：无法上传"); return; }
  readHead(f, function(bytes){
    var kind = sniffKind(bytes);
    if (kind !== "fw"){
      saveState("upmsg", "err", "✗ 只支持固件镜像（.bin）");
      $("otamsg").textContent = "R1.4.0 起控制页随固件发布，不再单独上传 .html";
      return;
    }
    var isFw = true;
    $("otamsg").textContent = "上传固件中…（设备随后自动重启）　目标 192.168.4.1";
    saveState("upmsg", "busy", "上传固件中…");

    var xhr = new XMLHttpRequest();
    var sentAll = false, reported = false;
    function bad(text){
      if (reported) return;
      reported = true;
      $("otabar").style.display = "none";
      saveState("upmsg", "err", text);
      $("otamsg").textContent = text;
    }
    xhr.open("POST", UP_URL);
    xhr.upload.onprogress = function(e){
      if (e.lengthComputable){
        $("otabar").style.display = "block";
        $("fill2").style.width = Math.round(e.loaded / e.total * 100) + "%";
        if (e.loaded >= e.total) sentAll = true;
      }
    };
    xhr.onload = function(){
      if (reported) return;
      reported = true;
      $("otabar").style.display = "none";
      if (xhr.status !== 200){
        var why = (xhr.status === 400) ? "（文件类型无法识别）"
                : (xhr.status === 404) ? "（设备固件过旧，不含统一升级入口 —— 请先升级固件）" : "";
        bad("✗ 上传失败：设备返回 " + xhr.status + why);
        return;
      }
      saveState("upmsg", "ok", "✓ 固件已写入，设备重启中…");
      $("otamsg").textContent = "固件升级成功，设备重启中…（45 秒内勿断电，然后刷新页面；"
                              + "设备设置已重置，热点名与密码保留）";
    };
    xhr.onerror = function(){
      /* 固件路径：数据已发完才断连 = 设备正在重启，属正常收尾，不是失败。 */
      if (isFw && sentAll){
        if (reported) return;
        reported = true;
        $("otabar").style.display = "none";
        saveState("upmsg", "ok", "✓ 已发送完毕，设备正在重启…");
        $("otamsg").textContent = "固件已发送完毕，设备重启中…（45 秒内勿断电，然后刷新页面；"
                                + "设备设置已重置，热点名与密码保留）";
        return;
      }
      bad("✗ 上传失败：连接中断（请确认已连接 MoInk 热点）");
    };
    /* 包一层 text/plain Blob：Content-Type 落在简单请求白名单内 → 不触发跨源预检。 */
    xhr.send(new Blob([f], { type: "text/plain" }));
  });
});
$("clearBtn").addEventListener("click", function(){
  msg("清理残影中（约 40~60 秒）…", "");
  fetch(api("/api/clear?cycles=2"), { method: "POST" }).then(function(){
    msg("残影清理完成", "ok");
  }).catch(function(){ msg("清理失败", "err"); });
});
$("factory").addEventListener("click", function(){
  if (!confirm("恢复出厂设置？热点与全部设置会清除。")) return;
  fetch(api("/api/factory"), { method: "POST" }).then(function(){
    msg("已恢复出厂，设备重启中…", "ok");
  });
});
