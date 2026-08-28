# QuickLogin 项目现状快照（2026-08-28 · v3.4.0）

> 配套阅读：版本明细见根目录 `CHANGELOG.md`；技术调研与方案论证见 `docs/BROWSER-ONLY-MULTILOGIN-RESEARCH.md`。

## 一、当前形态

**纯浏览器扩展**实现多账号在同一浏览器窗口并行登录内部低代码平台（无状态 JWT Bearer 认证）。历史上的「本地引擎（CDP spawn 隔离）/Native Messaging」路线已在 v2.x 全部移除，相关目录仅存于更早的提交历史中。

- 扩展 ID 固定，卡片入口 `chrome://extensions`；
- 并行管理主页：`ui/parallel/`；启动弹窗：`ui/popup/`；账号轮盘：`ui/wheel/`（独立小窗）+ `content/wheel-overlay.ts`（页面内浮层）；
- 构建产物 `dist/`（esbuild），装载即测。

## 二、核心架构：四平面隔离（网络栈现状）

绑定到标签页后，后台为每个 tab 安装至多三条 DNR session 规则（id 区间互不重叠，见 `background/core/tab-rules.ts`）：

| 平面 | 规则 | 覆盖范围 | 版本 |
|---|---|---|---|
| 存储 | MAIN 壳将 localStorage 重定向至 `__ql_ns_<accountId>__` 命名空间；`document.cookie` 虚拟化为命名空间「Cookie 袋」（`__ql_cookies__`）；bind 时后台携带 token/身份/指纹快照种子静默直灌 | 页面内存视图 | 2.6–2.7 |
| AUTH | `Authorization → Bearer <token>` 强制改写 | xmlhttprequest / websocket / **sub_frame**（iframe 文档） | 2.5 / 3.4 扩展 |
| COOKIE | 出站 `Cookie` 头 **set 本账号快照回放**（登录时点经 `chrome.cookies` 采集，含 HttpOnly；未登录/登出回退 remove）——对齐 SessionBox「会话独立罐回放」机制，真实 jar 从不参与 | 全部资源类型 | 3.0 剥离 → **3.6 回放** |
| CACHE | GET XHR 查询串追加 `_qlck=t<tabId>`，把全 profile 共享的 HTTP 缓存按标签硬分区（v3.5 起由 MAIN 壳页面层实现；Chromium DNR 无 urlTransform） | xmlhttprequest GET | 3.3 / 3.5 修正 |
| SW/Cache | `navigator.serviceWorker.register` 拦截 + 既有注册注销；`CacheStorage.prototype` 按账号命名空间键控、match 一律 miss | 站点级 SW 自建缓存 | 3.5 |
| IDB | `indexedDB.open/deleteDatabase` 按账号前缀化、`databases()` 剥前缀回显。**3.7 台架实锤的泄漏根因**：平台把 `isAdmin` 标志与全量菜单树缓存于 origin 级共享 IDB（库 `DBFetch`，键=URL 哈希无账号维度），免密恢复的标签页直接消费上一账号条目 → 四象限「U 获得管理员/A 被同化」 | 站点 IndexedDB | **3.7**（3.7.1 移除危险的历史库清扫——阻塞删除会误杀 passthrough 标签页的库） |

配套机制：

- Token 捕获双通道：命名空间 `__auth_token__` 写事件上报 + 出站 fetch/XHR Authorization 嗅探；快照持久于 `chrome.storage.session`（会话级，SW 冷启恢复）。
- 授权健康门控：host 无浏览器授权或被手动停用时关闭全部改写并在 UI 显示「未授权 · 已暂停」（`enforcementOff`）。
- 「移除授权」= 尽力调用 `permissions.remove` + 失败时写入**本地停用名单**（Chrome 的 required 权限无法经 API 回收，功能层必然生效）。
- `main_frame` 导航刻意不改写（保护静态资源与 SSO 跳转语义）。

## 三、版本里程碑速览（v2.5 → v3.7）

| 版本 | 要点 |
|---|---|
| 2.5 | 移除 NM/options/引擎残留；并行独立管理页上 Replace 注入式轮盘 |
| 2.6 | 轮盘改为独立弹窗小窗（任意页面可用）；品牌更名 QuickLogin；可见版本号惯例建立 |
| 2.7 | document.cookie 虚拟化 + bind 快照种子直灌（修「首页对但信息面板错」混合态） |
| 2.8 | 新增账号站点改下拉选择并记忆上次选择；修复站点行计数脱节 |
| 2.9 | 移除授权改原始串精确删除 + 反馈；wheel.toggle 消息通道与弹窗直达按钮 |
| 3.0 | 出站 Cookie 头剥离（封堵共享 jar 泄漏）；角标诊断闪标；授权本地停用语义 |
| 3.1 | 轮盘视觉重构（渐变环 Hub/SVG 连线/椭圆自适应/入场动画/新空态） |
| 3.2 | 轮盘去壳：普通网页优先注入**页面内无框浮层**（同款视觉），受限页才退回小窗 |
| 3.3 | 第四平面：HTTP 缓存按标签分区 `_qlck`（方案后经 3.5 修正为页面层实现） |
| 3.4 | AUTH 改写扩展到 sub_frame；诊断脚本沉淀入 CHANGELOG |
| 3.5 | 修正 DNR urlTransform 不受支持问题（缓存分区移页面层）；新增第五平面 SW/CacheStorage 封控 |
| 3.6 | **Cookie 剥离升级为按账号回放**（登录时点全量快照含 HttpOnly；父域覆盖）；对齐 SessionBox 稳定核心 |
| 3.6.1 | 修复：Cookie 快照触发内聚 `captureToken`（3.6 的快照因首捕走 authHeader 通道从未执行，回放一直未生效——E2E 台架诊断实锤） |
| 3.7 | **第六平面 IndexedDB 命名空间**。台架取证闭环：共享 IDB（`DBFetch`）缓存 `isAdmin`+菜单树是四象限泄漏载体；时间线拍到 `ADMIN=TRUE`/`admin=false` 两组 sha1 随打开顺序交叉翻转；3.7.1 回归全绿（A 进管理端、U 保持普通、CDP 真实 IDB 全景仅见 `__ql_ns_*` 库） |
| 3.7.2 | **修复真实环境「权限被分发覆盖」**：绕过扩展的普通登录页签把 `__auth_token__` 写进真实 jar（无虚拟化保护），3.6 登录时点快照经 `chrome.cookies` 把 jar 残留身份一并打包回放 → 请求 Bearer 与 Cookie 身份不一致。快照/回放双侧过滤 `IDENTITY_COOKIE_BLACKLIST`；回放侧过滤使存量快照无需重登自愈。用户实测 1A+2U+普通页签并存全绿。E2E 台架无法复现此因（全新档案 jar 干净）——「真实档案 vs 隔离档案」差异本身成为取证线索 |
| E2E | `npm run e2e`：Playwright+扩展隔离环境，事件流 `tmp/e2e-events.jsonl`（set-cookie / identity-snap / wire-auth / idb-full / resp-hash…），CDP `IndexedDB` 域全量取证，`node tools/e2e/peek.mjs <type>` 随手判读 |

## 四、快捷键与轮盘形态

- 快捷键命令 `quick-wheel`，用户实测设为 **Ctrl+Shift+Q**（避免 Windows Alt+Shift 输入法冲突）；
- 触发链：普通网页 → **页面内浮层**（Shadow DOM，幂等开关 `__QL_WHEEL_ACTIVE__`，锁滚动、不劫持输入焦点）；chrome:// 等受限页 → 独立小窗（3.1 视觉）；极端情况 → 标签页打开；
- 按键时图标闪 `→`、重装后短显 `v3.x`：用于现场区分「键位没通 / 旧驻留代码」类环境问题。

## 五、已知未决问题

### 1. 四象限身份泄漏（最高优先级，待定位最后一层）

实测记录（三个页签：管理员 A/B + 普通用户 U）：

1. 首次创建进入管理员 A：「管理端」按钮存在但点击无法进入；关闭该页签重新打开后恢复管理员权限；
2. 首次加 A 再加 U：U 权限正常；再加 B 也正常；
3. 全关后先开 U 再开 A：A 权限被剥离；
4. 全关后先开 A 再开 U：U 获得管理员权限。

**已排除/已覆盖**：存储命名空间（v2.6）、共享 Cookie jar（v3.0 Cookie 剥离）、HTTP 缓存 URL 键（v3.3 `_qlck` 分区）。「首因顺序决定身份」仍指向某跨标签共享、按写入顺序生效的层：

- 候选一：站点的 Service Worker / Cache Storage（其在网络栈内自建缓存，可能无视 `_qlck` 参数自行键控）；
- 候选二：服务端按设备指纹（`__device_fp__`）或浏览器环境属性绑定会话权限——各账号指纹若相同且服务端合并，可完整解释四个象限的方向性。

**定位手段（已交付）**：CHANGELOG §3.4 内置 DevTools Console 诊断脚本（解码本地 tokenPayload / deviceFp / cookie 视图）+ Network 面板核对 `_qlck` 与 Size 列的 `(disk cache)/(ServiceWorker)` 标记；正在建设的自动化台架（第六节）目标是把这些取证全自动完成。

> 安全边界声明：本扩展只保证客户端呈现层的账户分离；若平台服务端确实以某凭证返回他人数据，属平台越权缺陷，应向平台方反馈其接口缺失正确的缓存语义与鉴权校验。

### 2. 轮盘浮层在未授权站点降级为小窗

非故障：executeScript 需要对当前页面所在 host 有授权。用户知悉并接受现状（「先这样吧」）。

## 六、验证工具链

```bash
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/
npm run e2e         # Playwright 真实 Chrome 台架（交互式，见下）
QL_E2E_SELFTEST=1 npm run e2e   # 冒烟自检（自动退出）
```

E2E 台架（`tools/e2e/harness.mjs`）：隔离档案加载 dist、通过 CDP 同时采集 SW 日志/DNR 规则/每标签 localStorage 身份解码/**线上 Authorization 终值/缓存命中标记/响应体跨账号名嗅探**，产出 `tmp/e2e-report.md`（对比表 + 自动判定线索）与 `tmp/e2e-log.jsonl`（全事件流）。登录等需人工凭据的环节由使用者操作，脚本回车推进检查点。

注意事项：

- **品牌 Chrome 137+ 已禁用 `--load-extension`**，台架强制使用 Playwright 自带 Chromium（CFT 构建）；首次运行前需 `npx playwright-core install chromium`（约 192MB，曾因网络中断半途，续跑即可断点续传）；
- 临时档案 `tmp/e2e-profile` 与日志均在 `.gitignore` 保护下，不会入库。

### 专项研究：`research/idb-permissions/`（独立于扩展产物）

四象限泄漏的完整取证链与终审结论（5 份报告 + 文件驱动实验驱动器 `driver.mjs` 8 命令 + 参数分析器）：

- **01 参数粒度**：客户端 IDB 仅 4 条目（isAdmin 布尔 / 菜单树 / 页面清单 / 导航入口）——细粒度权限（对象/字段）纯服务端；
- **02 因素剖析**：权限真边界在服务端（JWT 无 role）；安全短板 = 管理侧读接口未过滤 + 单设备登录未启用；
- **03 动态覆盖终审**：IDB 为写穿镜像非渲染源，动态覆盖不可行（覆盖必被重取冲掉）；
- **04 考古复现**：仅关闭第六平面的研究构建下 1:1 复现共享镜像串权（凭据无关，纯启动顺序）；
- **05 最小能力终审**：被动串权=零能力/零信息（共享镜像+启动顺序）；主动赋权需「接管服务端应答」级能力（客户端篡改 → 白屏，无回退渲染）。

研究构建（第六平面关闭版）存放于 `tmp/dist-research/`（gitignored），与官方 dist 逐文件哈希核验仅 `content/shield-main.js` 一处差异（开关位），官方产物不受影响。

## 七、关键文件索引

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3 清单（permissions / commands quick-wheel / 静态 MAIN-world content scripts @document_start） |
| `src/background/core/tab-rules.ts` | 三条 DNR 规则族的构建、冷启恢复、孤儿清理；CACHE_PARTITION_ENABLED 开关 |
| `src/background/core/parallel-session.ts` | 绑定表/token 快照/桥上行处理/种子下发/导航重推/授权健康门控 |
| `src/background/service-worker.ts` | 总装：轮盘触发链、par.* 消息分发、角标诊断、commands/onRemoved |
| `src/content/shield-main.ts` | MAIN 壳：localStorage + document.cookie 虚拟化、种子直灌、authHeader 嗅探 |
| `src/content/shield-bridge.ts` | ISOLATED 桥：window.postMessage ↔ chrome.runtime 双向通路 |
| `src/content/auto-login.ts` | 凭据自动填表（会话级 pending 表驱动） |
| `src/ui/parallel/*` | 并行管理主页（站点下拉记忆、授权停用、实时徽标、3000ms 轮询） |
| `src/ui/wheel/*` · `src/content/wheel-overlay.ts` | 轮盘双形态（小窗 / 页面浮层） |
| `tools/e2e/harness.mjs` | E2E 取证台架 |
