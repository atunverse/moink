# 墨印 · MoInk — 版本更新记录（CHANGELOG）

> **★ 当前基线版本：fw R1.0.6 + page R1.0.10**（2026-09-17 上机验证功能基本正常，已固化至
> `moink/releases/baseline-fwR1.0.6_pageR1.0.10/`：整包/OTA 固件 + 页面 + 源码快照）。
> 后续版本如需回退，以此目录为恢复点。

> **维护规则**（2026-09-17 起）：
> 1. 任何固件（fw）或页面（page）改动合入时，**必须在本文档新增条目**，条目格式保持统一；
> 2. 版本号：fw 与 page **独立递增**——页面改动不触碰固件接口时只增 page 版本（免刷机热更），
>    触碰固件接口则 fw + page 同步递增并要求刷机/OTA；api 变化属重大事件，必须在「影响范围」标注；
> 3. 条目按时间**最新在上**排列；
> 4. 回滚依据：`moink/backups/` 保存有各版本的代码与固件备份。

## 条目格式模板

```
## [fw R1.x.y + page R1.x.y] YYYY-MM-DD
### 新增
### 修改
### 修复
### 涉及文件
### 影响范围与注意事项
```

（仅涉及一侧时另一侧版本标注「不变」）

---

## [page R1.0.22 + fw R1.0.8] 2026-09-18

> 全面代码审查后的批量整合修复（一次交付）。页面可独立热更；固件修复需 OTA/刷机。

### 新增
-（无）

### 修改
- fw：`/api/clear` 残影清理改走 `frame_clear_cycles()`，持 `s_fb_mutex`，与传图/显示互斥（原与 frame_task 并发共用 SPI/row 缓冲，竞态可致画面损坏）
- fw：`ota_web_has_page()` 加三态缓存（键 = NVS len+crc，未变则免 960KB 全分区 CRC 扫描），GET / 提速 100~300ms；上传/清除页面时自动失效
- fw：`ota_handler` / `web_handler` / `web_clear_handler` / `frame_upload_handler` 全链路喂 `power_activity()`（修复 sleep=60s 档位下长传输中途被深睡）
- fw：`settings` NVS commit 收敛到各 setter 末尾（一次保存一次落盘）
- page：上传失败提示改为「上传失败：(服务端返回 || HTTP 状态码)」（修复 `+` 与 `||` 优先级错误导致失败原因永远显示不出）
- page：文字描边回显改四色如实回显（原黄/红边折叠成白边，再碰下拉会意外改写真值）
- page：离线客户端导出先克隆再清理运行时节点（`#ctrls` 滑块 / `#tFont` 选项 / `#objLayer` 手柄），修复导出包打开后滑块与字体选项翻倍

### 修复
- fw：captive DNS 应答加答案段 16B 越界 guard（问题段满长时原可越界写任务栈最多 16B）
- fw：`read_body` 循环收满 + 溢出部分读走丢弃（原单次 recv 短读会半截解析设置，且残体污染 keep-alive）
- fw：`/api/frame` 校验 `content_len` 精确等于 16B 头 + 载荷（原只判下限，尾随垃圾污染连接）
- fw：`netif_ap_apply()` 运行时改热点配置不再用 `ESP_ERROR_CHECK`（失败即 abort 重启 → 改记日志保持现有 AP）
- page：EXIF 烤正兜底路径的 blob URL 提前 revoke 导致兜底图裂（revoke 挪入成功分支）
- page：文字拖动/缩放/旋转加 `pointerId` 校验（双指误触不再跳变）
- page：XHR 加 30s 超时（弱信号下不挂死）
- page：删除死代码 `modeAR()` / `statsOf()`（预览少一次全图统计）

### 涉及文件
- `src/frame.c`、`src/frame.h`、`src/main.c`、`src/captive.c`、`src/ota_web.c`、`src/netif_ap.c`、`src/settings.c`、`src/version.h`、`src/index_html.h`（再生成）
- `page/index.html`、`tools/smoke_page.js`
- 交付：`page/page-R1.0.22.html`、`moink_R1.0.8_app.bin`（OTA）、`moink_R1.0.8_merged.bin`（USB 刷机）

### 影响范围
- api = 1 **不变**，帧格式/色码/几何/引脚契约零改动；上传页自检（meta R1.0.22 / 闭合符==2 / 版本串）通过
- 固件：RAM 12.0%（39,260 B）、Flash 60.5%（951,868 B，增长因内嵌页更新为 R1.0.22 全量页面）
- 页面冻结算法零改动：check_algo 12/12 MATCH；smoke ALL PASS
- ⚠ 未实施项（有意跳过）：①图像管线 Float64→Float32（触碰冻结算法契约，需专项回归）；②OTA begin 整槽同步擦除改异步（收益小、改动大）；③saveCfg 每键全量写合并（风险大于收益）

## [page R1.0.21 + fw 不变] 2026-09-18

### 修改
- **留白四方向排版重构**：`.padGrid` 由 flex-wrap（窄屏挤成 3+1 错行）改为 grid 卡片式布局——每边一个圆角小卡（勾选框+方向字+数值框），宽屏 4 列、≤520px 自动 2×2；`applyPad`/启动回显的 display 切换同步 `"flex"`→`"grid"`。
- **删除模式副标题**：移除分段控件下方的 `modeDesc` 说明行及 `MODE_DEF` 定义（拍立得/便签描述文案整链删除），切换模式不再显示任何副标题。
- **步骤条按模式构建**：`updateSteps()` 重写为模式感知——拍立得保持「① 选图 → ② 裁剪调整 → ③ 上传」；便签改为「① 编辑文字 → ② 上传」（原便签错误显示「裁剪调整」步骤），便签下存在非空文字对象时自动高亮第②步；`objAdd`/`objDel` 操作后联动刷新。
- **便签底色行合并**：便签模式下「文字底色」「屏幕底色」两个 select 合并到同一行（`.pair` 包裹保证窄屏折行时标签与控件不拆散），删除原独占一行的 `tbgRow`。
- **残留单位清理（上轮遗漏）**：裁剪「旋转」output（`o-rot`）去掉 `°`、风格「色彩强度」output（`o-core`）去掉 `%`，全部纯数值显示。

### 修复
- 无（本轮为排版/交互优化）。

### 涉及文件
- `moink/page/index.html`（版本号 → R1.0.21）
- `moink/tools/smoke_page.js`（版本门禁递增 + 3 项 R1.0.21 结构检查：modeDesc/MODE_DEF 移除、步骤条模式化、padGrid grid 布局、底色行合并）

### 影响范围与注意事项
- 纯 HTML/CSS/展示层 JS 改动，渲染管线/打包/算法零触碰；`check_algo.py` 12/12 MATCH。
- 回退：`moink/backups/index_pageR1.0.20.bak.html`。

---

## [page R1.0.20 + fw 不变] 2026-09-18

### 修复
- page：**高级滑杆百分比显示错误（旧 bug）**——显示公式把滑杆值（0~100）又除了 sc(100)，
  百分比类参数（饱和度/冷色抑制/冷色去饱和/暖色吸引/锐化/抖动强度）只能显示 0 或 1；
  `fmtCtrl` 修正为百分比乘 100（显示 0~100），伽马保持 1.54 形式。该 bug 早于 R1.0.19 存在，
  本次格式化重构时暴露。
- page：**高级滑杆数值改为纯数值**——去掉 °/%/× 单位后缀，统一数值表示
  （亮度/对比度保留正负号标识方向）。
- page：**便签模式点文字输入框无反应**——R1.0.19 取消自动建框后，无选中对象时
  `syncSel` 仍禁用输入框形成死锁；改为输入框永久可编辑（兼作「＋添加」草稿框），
  无选中时不再清空草稿，仅字体/大小/颜色等参数控件保持选中才可用。

### 修改
- page：**留白改为四方向独立勾选**——勾选「留白」展开 上/下/左/右 四个复选框
  （`padTOn/padBOn/padLOn/padROn`，默认全不勾选），勾选某边即按默认值生效
  （上下 200 / 左右 100，数值框可改，勾选时数值为 0 自动填默认），取消勾选该边为 0；
  `applyPad` 重写为 `padSideVal()` 逐边计算，老配置（仅 padT/B/L/R 值）启动时按
  值>0 自动回显勾选状态，无需迁移。

### 涉及文件
- `moink/page/index.html`（页面级）
- `moink/tools/smoke_page.js`（版本锚点 R1.0.20 + 留白勾选/纯数值/输入框 3 项新检查，共 54 项）

### 影响范围
- 仅页面，**固件零改动**（fw 维持 R1.0.7），热更上传即可，无 api 变化。
- 回退：`backups/index_pageR1.0.19.bak.html`。
- 验证：smoke 54/54 PASS、check_algo 12/12 MATCH、node --check 通过、
  agent-browser 实测（sat60→60 / gamma154→1.54 / wcenter35→35、
  padTOn 勾选→200/取消→0、便签输入框 disabled=false 且添加成功）✅。

---

## [page R1.0.19 + fw 不变] 2026-09-18

### 新增
- page：**抖动算法动态说明**——抖动下拉下方新增一行动态 hint（`#dmodeHint`），
  8 个算法各配一句优缺点说明，随选择实时更新（`refreshDefMarks` 内同步）。
- page：**文字删除柄**——选中文字框左上角新增红色（#e5484d）× 删除柄，点按直接删除
  （无二次确认）；`odDown` 拦截 `data-a="del"`。
- page：**四色底色/描边**（⑩ 确认项）——屏幕底色 白/黑/黄/红（值 0~3，旧值语义不变）、
  描边颜色 黑/白/黄/红边（值 0~3）、文字底色 无/白/黑/黄/红（值 0~4）；
  渲染统一改走 PAL 调色板映射（`drawBase` 便签底、`drawObjs` 对象底与描边），
  所见即所得直出设备四色。`normObjs` clamp 范围同步放宽（bg 0..4、strokeC 0..3）。

### 修改
- page：**模式副标题定稿**——拍立得「像拍立得一样，晒出喜欢的照片」、
  便签「写点想说的，贴在身边」（HTML 静态 + `MODE_DEF` 两处同步）。
- page：**留白默认边距**——勾选「留白」立即按默认生效：上下 200px / 左右 100px
  （仅当从未设置过时填默认），四框按 上/下/左/右 排序、预填数值、旁显 px；
  老配置已存值优先。启动时补齐 pad 输入框从 cfg 回显（顺带修复旧版输入框不回显的隐患）。
- page：**高级图像数值统一**——输出格式化走 `fmtCtrl()`：伽马带 `×`、
  亮度/对比度带正负号（如 `+10`），角度 `°`、比例 `%` 保持；纯显示层，算法零改动。
- page：**屏幕设置竖排**——拆为 屏幕下拉 / 左右镜像 / 保存 三行，与热点设置风格一致；
  「系统维护与升级」内部维持现状。
- page：**文字手柄重排**——右下缩放(↘)、右上旋转(↻)、左下宽度(↔)统一橙色，
  图标用 CSS ::after 字符区分；右中宽度柄删除（`h-wl/h-wr` → 单 `h-w`，
  `odMove` 仅保留 `wl` 分支）。

### 修复
- page：**「图像 选图·裁剪·上传」标题删除**（信息与步骤条重复）；分段控件上方间距微调。
- page：**系统维护提示精简**——删除「离线客户端导出为实验性功能…?lab=1」后半句；
  `?lab=1` 功能保留（仅不再宣传）。

### 删除
- page：**停止输入 3 秒自动上传**——UI 行、`autoPush` 配置项、`scheduleAutoPush()`
  及 `pushTimer` 全部移除（保留手动「上传并刷新屏幕」；旧存储 autoPush 键自然失效）。
- page：**文字自动创建**——勾选「添加文字」/切便签模式不再自动塞空文字框；
  「＋添加/删除所选」按钮移到输入框下方；添加规则=无选中或选中已有内容→新建、
  选中空对象→就地填入；空内容点添加→提示「请先输入文字」。`newObj` 默认文本改为空。

### 涉及文件
- `moink/page/index.html`（60.8KB→约 113KB 区间，页面级）
- `moink/tools/smoke_page.js`（版本锚点 R1.0.19 + 10 项新结构检查，共 51 项）

### 影响范围
- 仅页面，**固件零改动**（fw 维持 R1.0.7），热更上传即可，无 api 变化。
- 回退：`backups/index_pageR1.0.18.bak.html`。
- 验证：smoke 51/51 PASS、check_algo 12/12 MATCH、node --check 通过、
  agent-browser 离线实测（手机/桌面截图、齿轮/返回、四色底像素 idx 1/0/2/3、
  手柄红×/橙↻/橙↔/橙↘、添加规则、留白默认 200/100）✅。

---

## [page R1.0.18 + fw 不变] 2026-09-18

### 新增
- page：**齿轮入口式导航**——删除首页「图像/设备」页签栏；主页即创作页，右上角齿轮按钮
  进入设备设置；设置页左上角「← 设备设置」返回按钮，返回即回主页；每次打开页面默认停在主页。
- page：**创作模式分段控件**——拍立得/便签改为居中 iOS 风格分段控件（灰底白滑块），
  带相机/便签 SVG 图标，触摸目标 ≥44px。
- page：**步骤指示条**——「① 选图 → ② 裁剪调整 → ③ 上传」，随图片加载/模式切换自动高亮
  （`updateSteps()` 挂在 `preview()`/`setMode()` 末尾，零管线侵入）。
- page：**响应式双栏**——≥900px 桌面端编辑区左右分栏（左控制/右预览+上传按钮 sticky），
  `main` 放宽到 1020px；<900px 保持单列。预览/上传 DOM 移入 `#editRight`（id 不变，JS 零改动）。

### 修改
- page：**首页信息瘦身**——头部删去「固件/页面/接口」版本行（`i-fw/i-page/i-api` 元素与
  `refreshInfo` 对应三行赋值一并移除），版本信息只在设备设置页「设备信息」网格显示；
  连接状态改为带圆点的胶囊（绿=已连接/灰=未连接）；副标题改为「把喜欢的瞬间，放在身边」。
- page：**设备设置页重组**——8 项状态改为两列「设备信息」网格；休眠唤醒/热点/屏幕/维护
  四组改为 `details` 折叠条；「恢复出厂」保留底部独立危险区。
- page：**文案清理（9 处）**——「预览已跑通」→「预览完成，可以上传了」；「预览还没跑通…」→
  「预览生成中，请稍候再上传」；预览下方四色占比+耗时调试行移除（拖动时显示「正在生成预览…」，
  成功后留空）；「（已阻止上传）」→「，请重试」；切换模式 toast 删除；MODE_DEF 两模式描述、
  留白说明、文字手柄说明、高级设置注记全部改为贴近使用场景的措辞。

### 修复
- （无逻辑缺陷修复，本版为纯 UI/文案版）

### 涉及文件
- `moink/page/index.html`（HTML 结构重排 + CSS 新增 + tab JS 重写 + 9 处文案；
  渲染管线/打包/算法函数零改动）、`moink/tools/smoke_page.js`（版本锚点 R1.0.18 +
  10 项结构检查）、`moink/backups/index_pageR1.0.17.bak.html`（回退点）、
  交付副本 `moink/page/page-R1.0.18.html`。

### 影响范围与注意事项
- **纯页面级改动，固件零编译，api 不变**；热更上传 `page-R1.0.18.html` 即可。
- 门禁：smoke_page 42/42 PASS（新增 10 项）、check_algo.py 12/12 MATCH、
  node --check 主脚本通过、agent-browser 双视口（390×844 / 1280×900）截图验证
  齿轮进入/返回交互/分段控件/双栏 sticky 均正常。
- 回退：`backups/index_pageR1.0.17.bak.html` 热更回传即可。
- 已知既有行为（非本版引入）：未选图时裁剪工具行（90°/铺满/居中/旋转滑杆）在拍立得模式常显。

---

## [page R1.0.17 + fw 不变] 2026-09-17

### 修复
- page：**上传照片底图方向躺倒（EXIF 失效）**——手机直拍照片靠 EXIF orientation 摆正，
  浏览器原生 `<img>` 会应用，但内嵌 Cropper.js 的 `checkOrientation` 依赖 XHR 读文件
  解析 EXIF，在 `file://` 等场景会**静默失败**，导致缩略图正、裁剪区/设备输出躺倒。
  修复：`loadFile` 对 JPEG 轻量解析 EXIF orientation（约 30 行零依赖，仅扫段头），
  方向标记为 2~8 时经 canvas 重绘把 EXIF **烤进像素**（drawImage 在 from-image 内核
  上已按 EXIF 摆正）再交 Cropper；其余图片（PNG/已摆正 JPEG）走原路**零额外成本**。
  重编码 q0.95，不做缩放（守住不预缩教训）；烤制失败兜底走原图。
- page：**取消勾选「添加文字」后文字不消失**——`renderComposite`/`liveDraw` 画文字层
  时不看 `cfg.textOn` 开关，取消勾选只藏了编辑面板与手柄层，画布仍无条件烤入
  `cfg.objsImg`。修复：两处调用按 `cfg.textOn` 过滤（勾选对象仍保留，重新勾选即恢复）。
- page：**换图继承上一张的裁剪旋转**——`cfg.cropRot` 持久化并在 `initCrop` ready 时
  无条件 `cr.rotate(curRot)`，上一张转过 90° 后每张新图都先被转 90°。修复：换图时
  重置 `curRot/cfg.cropRot = 0` 并同步滑杆 UI（旋转针对当前图，不跨图记忆）。

### 涉及文件
- `moink/page/index.html`（meta 版本、loadFile 重构 + exifOrientation/adoptImg、
  renderComposite/liveDraw 文字过滤）
- `moink/tools/smoke_page.js`（版本门禁 R1.0.17 + 3 项新检查，36 项全 PASS）
- 测试样张：`moink/tools/_exif_test.jpg`（EXIF orientation 6 回归样张）、
  `moink/tools/_test_image.png`（四色样张）
- 备份：`moink/backups/index_pageR1.0.16.bak.html`（回退 = 直接热更此文件）

### 影响范围与注意事项
- 仅页面级改动，**固件零编译**（fw 维持 R1.0.7）；算法冻结区零改动（check_algo 12/12 MATCH）。
- 浏览器离线实测：EXIF 样张 Cropper 内部位图由 300x200（躺倒）变 200x300（摆正）；
  取消勾选文字预览暗像素 29119 → 19814（文字真正移除）；设 cropRot=90 后换图自动归零。
- 带 EXIF 旋转的照片上传时会多一次 canvas 重绘+重编码（手机约 0.2~0.5 秒，一次性）。



### 新增
- page：**竖屏编辑空间（以竖屏为主要使用形态）**——编辑/预览空间改为 552x768 竖屏
  （新增常量 `EW/EH`），预览画布、裁剪框比例（Cropper `aspectRatio` 自动跟随）、
  留白、文字对象坐标全部天然竖屏；`packFull` 输出前经 `rotateCW()` 顺时针转 90°
  变回设备帧 768x552。**`PANEL`/`packIdx`/`frameWithHeader` 一字未动**（设备帧
  契约与冻结算法零改动，check_algo 12/12 MATCH），固件零感知。旧文字对象坐标做
  一次性逆时针迁移（`cfg.m16rot` 防重入），设备输出不变。
  ⚠ 旋转方向需上机核对：用非对称测试图（左上角红块）看竖持观感，若相反改
  `rotateCW` 一行即可。
- page：**文字框宽度调节（左右边中柄）**——文字对象左右两侧中点新增拖拽柄，横向
  拖动实时改变换行宽度 `o.wrap`（位移投影到文字局部 x 轴，随旋转一起转，竖排
  90° 时同样直觉）；配合 R1.0.15 liveDraw 拖动中逐帧重排所见即所得。拖到满宽
  （≥EW-8）恢复默认 0.94x 屏宽（wrap=0）；最小宽度 0.7x 字号。手柄框（实测包围
  盒）随换行实时变化。

### 修改
- page：**UI 卡片顺序按操作流重排**——选图/裁剪 → **风格**（从页面尾部独立卡片
  移入主卡片，section→div + h3）→ **留白**（从 pickCard 内移出）→ 添加文字 →
  预览上传；纯 DOM 位置移动，控件均按 id 绑定，逻辑零改动。

### 涉及文件
- `moink/page/index.html`（EW/EH 常量、编辑空间引用切换、rotateCW/packFull、
  canvas 竖屏属性、loadCfg m16rot 迁移、styleCard/padCard 移位、边柄 CSS/创建/
  odDown/odMove 分支、提示文案）
- `moink/tools/smoke_page.js`（版本门禁 R1.0.16 + 6 项新检查：设备帧/竖屏/
  rotateCW 映射/桥接/边柄/卡片顺序/迁移，33 项全 PASS）
- 备份：`moink/backups/index_pageR1.0.15.bak.html`（回退 = 直接热更此文件）

### 影响范围与注意事项
- 仅页面级改动，**固件零编译**（fw 维持 R1.0.7）。
- 浏览器离线实测：竖屏画布 552x768；拖右边柄 wrap 519→322、行数 7→12 实时重排、
  框高随动；旋转 90° 后向下拖右边柄 wrap 322→493（局部轴投影正确）；packFull
  恒定 105,984 B；截图确认手柄紧贴、无重影。
## [page R1.0.15 + fw 不变] 2026-09-17

### 修改
- page：**文字编辑架构重构为「画布唯一视觉源」（Fabric.js 模式轻量版）**——DOM 文字框
  永久透明（连拖动中也不再显示 DOM 版），只保留虚线框与手柄做交互；文字一律由预览
  画布矢量绘制。R1.0.12~R1.0.14 系列的双层渲染不一致问题（重影/其他对象消失/贴边
  换行/手柄偏远）连根移除。
- page：**拖动实时重绘**——手势开始用 `renderBase()` 把无文字底图（L0+L1，含风格化
  量化图像层）量化一次缓存为 ImageData，拖动中每帧 `putImageData` + 全部文字矢量
  重画（rAF 节流），所见即所得；松手做一次全量合成（snapIdx 就近吸附恢复锐利边缘）。
  `renderComposite` 重构出 `drawBase` 共用底图逻辑，删除手势期 `objEditing` 过滤。
- page：**手柄贴合实测包围盒**——新增 `objMetrics()`（wrapText + measureText 实测
  文字渲染尺寸），画布绘制与 DOM 手柄框共用同一几何，手柄永远紧贴文字；删除 R1.0.14
  的固定换行宽度补丁与 webkitTextStroke 逻辑。
- page：**文字底色默认改回透明**——撤销 R1.0.13 的白底默认：`newObj` 默认
  `bg:0`；删除 `m13bg` 白底一次性迁移（已被迁移成白底的旧对象保持不变，可逐对象改回）。

### 涉及文件
- `moink/page/index.html`（meta 版本、.tobj CSS、objMetrics/drawObjs/drawBase/
  renderBase/liveDraw/startLive、renderComposite、relayoutOne、odDown/odMove/odUp、
  newObj、loadCfg）
- `moink/tools/smoke_page.js`（版本门禁 R1.0.15，23 项全 PASS）
- 备份：`moink/backups/index_pageR1.0.14.bak.html`（回退 = 直接热更此文件）

### 影响范围与注意事项
- 仅页面级改动，**固件零编译**；上传合成 / previewOK 门禁 / eink-warm 算法冻结区零改动。
- 性能：拖动中每帧仅底图贴回 + 文字矢量绘制；手势开始多一次全分辨率底图量化
  （取代原半分辨率快合成）。
- 浏览器离线实测：手柄框与实测包围盒完全一致（160/160 px）；拖动中画布暗像素 1470
  ≈ 松手后 1535（所见即所得，仅吸附锐利化差异）；拖到右缘行数恒 1（不换行）；
  新对象 bg=0（透明）。

---

## [page R1.0.14 + fw 不变] 2026-09-17

### 修复
- page：**调节某文字对象时其余文字对象消失**（R1.0.13 回归）——编辑手势期间画布改为只排除
  **正在编辑的那一个**对象（`objs.filter(k !== od.i)`），其余文字照常烤入画布保持可见
  （且显示设备真实量化效果）；DOM 层规则不变（仍仅被拖对象可见，防重影）。
- page：**文字拖到边缘自动换行、松手后恢复**（DOM 与画布排版模型不一致）——DOM 文字框改为
  **固定换行宽度**（`o.wrap` 优先，否则 0.94×屏宽，与画布 wrapText 同宽），位置不再影响换行；
  覆盖层 `overflow:hidden` 按预览边界裁剪，与画布裁剪行为对齐（贴边时手柄可能被裁一半，属预期）。

### 涉及文件
- `moink/page/index.html`（meta 版本、renderComposite 两处调用、relayoutOne 固定宽度、objLayer CSS）
- `moink/tools/smoke_page.js`（版本门禁 R1.0.14，23 项全 PASS）
- 备份：`moink/backups/index_pageR1.0.13.bak.html`（回退 = 直接热更此文件）

### 影响范围与注意事项
- 仅页面级改动，**固件零编译**；性能不变（合成次数与 R1.0.13 一致）。
- 浏览器离线实测：双对象场景拖 A 时 B 暗像素持续可见、贴边行高 42px（未翻倍=无换行）、
  DOM 宽度锁定 363px、松手全部恢复。

---

## [page R1.0.13 + fw 不变] 2026-09-17

### 修复
- page：**文字拖动/旋转/缩放手势期间「重影」**——此前预览画布（量化烤入的文字）与 DOM 覆盖层（编辑用
  文字）同时可见，手势只移动 DOM 层，画布旧文字原位不动直至松手才重合成，造成拖动时出现两份文字。
  修复为「编辑期间单一视觉源」：手势开始置 `objEditing` 并立即半分辨率重合成**跳过文字层**（画布清空
  文字，DOM 版为唯一可见文字，补染 `-webkit-text-stroke` 描边）；静止时反向——DOM 文字透明，
  画面只显示画布量化版（= 设备真实输出）。上传合成与 previewOK 门禁零影响。

### 修改
- page：**文字旋转 90° 贴合**——与裁剪旋转同规则（±3° 阈值吸附到 90° 整数倍），拖动右上旋转柄与
  面板「方向」滑杆均生效（滑杆值即时回写吸附结果）。
- page：**文字底色默认白底**——`newObj` 默认 `bg:1`（拍立得/便签一致）；
  `loadCfg` 一次性迁移旧默认透明底对象为白底（`cfg.m13bg` 防重入，仅 bg===0 的既有对象）。
- tools：`smoke_page.js` 版本门禁更新 R1.0.13（23 项全 PASS）。

### 涉及文件
- `moink/page/index.html`（meta 版本、renderComposite 文字层守卫、objLayer pointerdown/odUp/
  relayoutOne 编辑态切换、odMove+tRot 旋转吸附、newObj/loadCfg 白底默认与迁移）
- `moink/tools/smoke_page.js`（版本门禁）
- 备份：`moink/backups/index_pageR1.0.12.bak.html`（回退 = 直接热更此文件）

### 影响范围与注意事项
- 仅页面级改动，**固件零编译**（fw 维持 R1.0.7），页面热更即可生效。
- 每次拖动手势新增 2 次合成（开始半分辨率 + 结束全分辨率）；图像层有 cropCache，实测 PC 端单次
  约 30-80ms，手机端可接受。
- 编辑手势瞬间画布文字短暂消失属预期行为（松手即回）；若热更后见「静止时文字发虚/重边」，为
  R1.0.12 遗留现象，本版已一并消除。

---

## [page R1.0.12 + fw 不变] 2026-09-17

### 新增
- page：图像管线重构为**「拍立得 / 便签」双模式**——拍立得以图为主（裁剪 → 可选留白、文字叠加），
  便签以文字为主（自由摆放，可调字体/颜色/底色，无图像无抖动）。
- page：**内嵌 Cropper.js v1.6.2**（MIT，min 37,369B + css 3,795B，存档于 `page/vendor/`）——
  裁剪支持双指捏合缩放、拖动移动、自由旋转（滑杆 + ±90° 按钮）、**90° 整数倍自动贴合**（±3° 阈值）；
  `checkOrientation` 自动校正手机照片 EXIF 方向。
- page：**留白**——勾选后可按 px 指定上/右/下/左四边留白，裁剪框比例随内容区（屏幕内缩）自动变形，
  留白区保持纯白、**不参与风格化**（避免暖调污染白边）。
- page：**文字对象系统**——替代原单条 cfg.text；支持多对象、画布内拖动 / 右下柄缩放 / 右上柄旋转、
  字体/大小/颜色/方向调节；拍立得模式强制**透明底 + 可调描边**（白/黑边），便签模式可选对象底色
  与屏幕底色（白/黑）。预览画布上有可交互覆盖层，控制面板作用于选中对象。

### 修改
- page：`renderComposite` 分层合成——L0 白底（含留白区）→ L1 图像层（风格化+抖动只作用此层，
  由 Cropper `getCroppedCanvas` 供图并缓存）→ L2 文字对象（调色板纯色透明叠加，读回 snapIdx 吸附）。
- page：便签模式隐藏「风格」面板；旧版整列文字排版（textMetrics）退役。
- page：旋转角持久化 `cfg.cropRot`（-180..180）；新增 cfg：padOn/padT/R/B/L、textOn、objsImg/objsNote。
- page：旧版 `cfg.text` 一次性迁移为单个文字对象（拍立得/便签各一份，textOn 自动勾选）。
- tools：`smoke_page.js` 适配双 script 块（闭合符防线 1→2）并新增 8 项结构检查；
  `check_algo.py` 冻结比对移除已退役的 drawCropInto（12/12 MATCH）。

### 修复
- （无独立修复项；裁剪体验差/EXIF 方向问题由 Cropper 内嵌一并解决）

### 涉及文件
- `page/index.html`（60,788B → 110,896B）、`page/vendor/cropper.min.js`、`page/vendor/cropper.min.css`（新增存档）、
  `tools/apply_r1012.py`（手术脚本）、`tools/smoke_page.js`、`tools/check_algo.py`；
  备份 `backups/index_pageR1.0.11.bak.html`。

### 影响范围与注意事项
- **仅页面改动，固件零改动**（api=1 不变，帧格式不变）；页面热更即可生效，无需刷机。
- web 分区占用约 110.9KB / 960KB，充裕；后续固化进固件时 app.bin 约 +50KB，Flash 仍有富余。
- 回退：热更 `backups/index_pageR1.0.11.bak.html` 即可恢复 R1.0.11。
- 已知取舍：iOS 超大图裁剪内存上限（Cropper 官方提示）首版不做预缩，上机如有问题再评估。

---

## [page R1.0.11 + fw R1.0.7] 2026-09-17

### 新增
- page：页面重构为**双标签页**——「图像」（选图/裁剪/风格/上传）与「设备」分离，顶部标签栏切换。
- page：「设备」标签内设置项归类为四组小节——**休眠与唤醒 / 热点设置 / 屏幕设置 / 系统维护**；
  状态区新增**固件版本、页面版本、API 版本**三行显示。
- page：「休眠与唤醒」增加**保存按钮**（不再随下拉框变更即时保存，保存后显示「已保存 ✓」反馈）。
- page：「下载离线客户端」从维护区隐藏，转为**实验性功能**——地址栏追加 `?lab=1` 刷新后显示
  （导出逻辑保留，绑定不受影响）。

### 修复
- fw：**构建依赖修复**——PIO IDF 构建不跟踪 `version.h` 隐式依赖，`ota_web.c.o` 未随版本号重编，
  导致 `/api/info` 的 page 版本 fallback 串陈旧（R1.0.10）；CMakeLists 显式为全部源文件声明
  `version.h` 的 OBJECT_DEPENDS。fw R1.0.6 从未上机，被本版取代。

### 涉及文件
`page/index.html`、`src/index_html.h`（再生成）、`src/CMakeLists.txt`、`src/version.h`、`src/version.h` 相关 `src/*.c.o`

### 影响范围与注意事项
- 纯页面改动可直接热更 `page-R1.0.11.html`；fw R1.0.7 仅修构建依赖与 fallback 版本串，可随下次 OTA 顺带升级，无急迫性。
- 回退：`backups/page-R1.0.10.html.bak`（页面）、`backups/main.c.R1.0.5.bak`；基线快照 releases/ 不受影响。

---

## [fw R1.0.6 + page R1.0.10] 2026-09-17 ★基线版本（上机验证通过，已固化至 releases/）

### 修复
- fw：跨源上传预检 404——esp_http_server 默认 URI 精确匹配导致 `OPTIONS *` 通配路由从未生效，
  非简单请求（如 .bin 的 octet-stream）跨源上传被浏览器拦截报「net」。
  `main.c` 加 `cfg.uri_match_fn = httpd_uri_match_wildcard;`。
- page：OTA 请求体包 `text/plain` Blob 变为简单请求，**免预检、兼容旧固件**（R1.0.3 也能直接 OTA）。

### 涉及文件
`src/main.c`、`page/index.html`、`src/version.h`

### 影响范围与注意事项
- OPTIONS 通配路由自此真正生效，所有 API 的跨源访问可用；现有精确路由不受影响。
- 对旧固件发起本地 OTA 时，页面可能显示「失败：net」但**升级实际成功**（旧固件响应无 CORS 头），
  以设备重启和刷新后版本为准；新固件下状态显示正常。

---

## [fw R1.0.5 + page R1.0.9] 2026-09-17

### 新增
- page：OTA 目标地址固定 `http://192.168.4.1/api/ota`（纯 SoftAP，IP 恒定）——页面从任意来源打开
  （设备内嵌 / 离线客户端 / 本地文件）都能直接升级固件，不再依赖 curl。
- page：固件上传成功提示「约 45 秒内勿断电」；失败提示注明热点检查。

### 修改
- fw：`/api/ota` 成功响应加 `Access-Control-Allow-Origin: *`（跨源时浏览器才能读到成功状态）。
- page：`postFile` 拆出 `postFileTo(url,…)`；本地预览模式（file:// 无 MOINK_BASE）上传给出明确提示
  而非「net」；连接状态显示「本地预览（未连设备）」。

### 涉及文件
`page/index.html`、`src/ota_web.c`、`src/version.h`

### 影响范围与注意事项
- 仅 OTA 路径行为变化；图片/页面热更上传仍走相对地址。
- 已知遗留：本地页面 OTA 对 **R1.0.3/R1.0.4** 固件仍会报 net（预检 404，见 R1.0.6）。

---

## [fw R1.0.4] 2026-09-17

### 修复
- **web 分区页面静默损坏**：web_handler 增量擦除以 `written % 4096 == 0` 为条件，而 `httpd_req_recv`
  返回块大小任意 → 块偏离 4K 边界后写入跨越到未擦除扇区 → flash 数据被静默按位与坏
  （页面头部幸存、脚本中段损坏，表现为页面成"静态壳"）。
  改为**按扇区对齐拆分写入**（块跨扇区时切开，每扇区首次写入前先擦）。
- `ota_web_has_page()` 升级为长度 + CRC32 双重校验：web 分区页面损坏时**自动回退内嵌页**（自愈）。

### 涉及文件
`src/ota_web.c`

### 影响范围与注意事项
- 修复后页面热更写入才真正可靠；旧固件 R1.0.3 上传页面存在损坏风险，勿用。

---

## [fw R1.0.3 + page R1.0.7] 2026-09-17

### 修复
- fw：**恢复出厂不再清除页面热更标记**——原 `nvs_erase_all` 会把同命名空间的
  web_len/web_crc/page_ver 连带擦掉导致回退内嵌页；改为逐键擦设置键
  （panel/hflip/sleep_s/wake_s/ap_ssid/ap_pass）。
- fw：**电池未连接检测**——开发板未接电池时 ADC 悬空读数乱漂（实测 3.2/3.3/17.6V 交替）；
  跨请求状态机：读数须在单节锂电物理范围（2400~4600mV）且连续 3 次轮询有效才返回电压，
  否则返回 -1。
- page：电池栏对无效读数显示「未连接」。

### 涉及文件
`src/settings.c`、`src/power.c`、`page/index.html`、`src/version.h`

### 影响范围与注意事项
- 恢复出厂后页面热更保留；清除页面请用维护区「恢复内置页面」。

---

## [page R1.0.6] 2026-09-17

### 修复
- **移除预压缩**：`createImageBitmap` 的 resizeWidth/resizeHeight 是强制绝对尺寸（非长边上限），
  竖图被拉成 2048×2048 方图变形；loadFile 回归 M7 状态（保留 URL 保活 + 预览锁）。
- **预览图被文字底色盖住**：drawTextLayer 无条件整屏 fillRect；加 noBg 参数，
  图像模式叠加文字时透明底。
- **文字与图像处理分离**：渲染管线重排为 renderComposite——图像层单独 warmMap+quantize
  （抖动/色调只作用图像），文字以纯调色板色最后叠加，读回 snapIdx 就近吸附（文字无抖动）；
  删除 drawLogical；底色选项仅便签模式显示。

### 涉及文件
`page/index.html`、`src/index_html.h`（再生成）

### 影响范围与注意事项
- 文字便签模式不再做风格化（底色+文字直绘）；风格板块只对图像生效。
- 风格参数对合成结果的映射由「图像量化后文字就近吸附」实现，文字边缘干净无抖动噪点。

---

## [fw R1.0.2 + page R1.0.3~R1.0.5] 2026-09-17

### 修复
- fw R1.0.2：**web_handler/ota_handler 栈溢出**——httpd 任务栈仅 4KB，handler 栈上放
  buf[4096]+head[8192]（12KB）导致 /api/web 上传断连「net」；收包缓冲改文件级静态共享
  （s_buf/s_head），整片预擦改逐扇区（该增量擦除的边界 bug 由 R1.0.4 完成收尾）。
- page R1.0.2：图片 blob URL 不再在 onload 里立即 revoke（部分内核 drawImage 画不出、缩略图裂图），
  改为换图时吊销。
- page R1.0.3：**预览门禁**——预览成功（previewOK）才解锁上传按钮，落实「先离线跑通再上传/OTA」。
- page R1.0.5：**图像白板真根因**——舞台 `#src` 误写为 `<img>`（应为 `<canvas>`），
  renderStage 调 getContext 抛错致整条图像管线从第一步死亡；恢复 canvas。

### 涉及文件
`src/ota_web.c`、`src/main.c`（HTTPD_STACK 注释）、`page/index.html`、`src/index_html.h`、`src/version.h`

### 影响范围与注意事项
- page R1.0.4 的 createImageBitmap 预压缩后被 R1.0.6 移除（变形），仅 R1.0.4 版本短暂存在。

---

## [page R1.0.1] 2026-09-16

### 修复
- 离线客户端导出函数的 JS 字符串含字面量 `</script>`，导致页面主脚本被浏览器提前终结
  （页面底部漏源码、启动初始化与设置加载失效）；转义为 `<\/script>`。
- smoke_page.js 新增静态防线：全文件 `</script>` 计数必须为 1、启动块必须完整。

### 涉及文件
`page/index.html`、`tools/smoke_page.js`、`src/index_html.h`

---

## [fw R1.0.0 + page R1.0.0] 2026-09-16

### 新增
- **R1 首版**：固件全新重写（epd_drv 锁屏驱动 / settings / netif_ap 纯 SoftAP / captive /
  frame 帧接收 / power 深睡唤醒 / ota_web / version），删除 STA 配网、拉图、局部刷新、引导条、蓝牙；
  页面全新重写（eink-warm 算法逐行冻结 + M5 式 90° 裁剪 + 文字便签）。
- 帧格式 v1（16B 头 + CRC16-CCITT-FALSE + 2bpp 载荷 105,984B）；契约文档 `docs/CONTRACT.md`。
- 工具链：make_index_header / check_frame / smoke_page / check_algo / package_bins / flash_moink。

### 涉及文件
`moink/` 全目录（src/、page/、tools/、docs/）

### 影响范围与注意事项
- 首刷基线；分区表 nvs 16K + otadata 8K + phy 4K + ota_0/1 各 1.5M + web 960K。
- 占用：RAM 静态 10.1%、Flash 56.0%。
