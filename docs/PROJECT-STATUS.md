# QuickLogin 项目现状快照（2026-08-29 · v3.7.2）

> 配套阅读：版本明细见根目录 `CHANGELOG.md`；代码库导读见 `docs/CODEBASE_OVERVIEW.md`；
> 四象限泄漏的完整取证链见 `research/idb-permissions/`（5 份报告）。

## 一、当前形态

**纯浏览器扩展**实现多账号在同一浏览器窗口并行登录内部低代码平台（无状态 JWT Bearer 认证）。历史上的「本地引擎（CDP spawn 隔离）/Native Messaging」路线自 v2.4 起退出扩展运行时（manifest 无 `nativeMessaging`、无调用方），但 `packages/engine/` 目录与 `scripts/build.mjs` 的引擎打包步骤仍留存于仓库（属待清理遗产，不影响扩展产物）。

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

## 五、四象限泄漏：已收敛（v3.5–v3.7.2 分层修复）

### 1. 修复历程（每层都有 E2E/实测证据，明细见 CHANGELOG）

| 层 | 根因 | 修复 |
|---|---|---|
| 网络平面全死 | DNR `redirect.urlTransform` 为 Firefox 专属字段，Chrome 以 `Unexpected property` 拒绝整批 `updateSessionRules`（原子），v3.3 的 CACHE 规则拖垮 COOKIE/AUTH 全部规则 | v3.5：CACHE 移页面层 + 逐条安装降级 |
| 站点自建缓存 | 站点 SW 在网络栈内自建缓存，完全无视 DNR 与 `_qlck` | v3.5 第五平面：SW 注册拦截/注销 + CacheStorage 命名空间 |
| Cookie 降级为匿名 | 「服务端不看 Cookie」前提不成立，剥离使 Cookie 亲和请求降级 | v3.6：Cookie 按账号回放（登录时点快照含 HttpOnly） |
| **共享 IndexedDB（主载体）** | 平台把 `isAdmin` 标志与全量菜单树缓存在 origin 级共享 IDB（`DBFetch`，键=URL 哈希无账号维度），免密恢复的标签页直接消费上一账号条目 | v3.7 第六平面：IDB 按账号前缀化 |
| 真实 jar 残留身份 | 绕过扩展的普通页签把 token 写进真实 jar，登录快照经 `chrome.cookies` 把它打包回放 → Bearer 与 Cookie 身份不一致 | v3.7.2：快照/回放双侧过滤 `IDENTITY_COOKIE_BLACKLIST`，存量快照自愈 |

**验证结论**：E2E 台架 3.7.1 回归全绿（A 进管理端、U 保持普通、CDP 真实 IDB 全景仅见 `__ql_ns_*` 库）；v3.7.2 用户实测 1 管理员 + 2 普通 + 绕过扩展的普通页签并存全绿；研究构建（仅关第六平面）可 1:1 复现泄漏，**官方 v3.7.2 不可复现**（详见 `research/idb-permissions/reports/04-archaeology.md`）。

### 2. 现存边界与残余风险（客户端能力上界）

1. **主动提权方向无法在客户端根治**：把普通用户抬成管理员需「接管服务端应答」，客户端篡改 IDB → 白屏（无回退渲染路径，`reports/05-minimal-capability.md`）。权限真边界在服务端（JWT 无 role；管理侧读接口未过滤 + 单设备登录未启用 `isEnableSingleDeviceLogin:False`）——建议向平台方反馈。
2. **Web Worker 内打开的 IndexedDB** 不受主世界补丁（待观测）。
3. Cookie 快照仅登录时点采集一次；服务端若在会话中轮转会话标识，该账号需重新登录刷新（JWT 主体不受影响）。
4. 轮盘页面浮层需站点授权；未授权站点按设计降级独立小窗（用户知悉接受）。

> 安全边界声明：本扩展只保证客户端呈现层的账户分离；若平台服务端以某凭证返回他人数据，属平台越权缺陷，应向平台方反馈其接口缺失正确的缓存语义与鉴权校验。

### 3. 台架运维注意（实测教训）

- **更新 dist 后必须在扩展卡片点「重新加载」**：Chrome 会缓存扩展 SW 脚本（实测档案内 ScriptCache 长期复用首次加载的旧脚本，导致「诊断埋点全空 + 旧缺陷常驻」的假象）；必要时删除档案 `Default/Service Worker/` 后重开。
- `tmp/` 下档案/事件流均 gitignored；`QuickLogin-v*.zip` 官方构建包不入库。

## 六、验证工具链

```bash
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/
npm run e2e         # Playwright 真实 Chrome 台架（交互式，见下）
QL_E2E_SELFTEST=1 npm run e2e   # 冒烟自检（自动退出）
QL_E2E_DRIVE=file npm run e2e   # 文件驱动模式（无人值守 stdin；检查点写 tmp/e2e-go 推进）
```

E2E 台架（`tools/e2e/harness.mjs`）：隔离档案加载 dist、经扩展页评估通道 + 浏览器级 CDP 同时采集：SW 日志/DNR 规则/每标签 localStorage 身份解码/**线上 Authorization 终值/缓存与 SW 命中标记/响应体跨账号名嗅探/CDP `IndexedDB` 域全量取证**。三种运行模式（交互 / 自检 / 文件驱动）；事件流 `tmp/e2e-events.jsonl`（set-cookie / identity-snap / wire-auth / idb-full / resp-hash…），报告 `tmp/e2e-report.md`，`node tools/e2e/peek.mjs <type>` 随手判读。登录等需人工凭据的环节由使用者操作。

配套取证工具（`tools/e2e/`）：`analyze-events.mjs`（事件流离线分析 → 跨标签串号判定）、`rule-probe.mjs`（DNR 规则格式回归探针）、`fix-verify.mjs`（壳激活 + 页面层缓存分区全自动验证）。

注意事项：

- **品牌 Chrome 137+ 已禁用 `--load-extension`**，台架强制使用 Playwright 自带 Chromium（CFT 构建）；首次运行前 `npx playwright-core install chromium`（国内镜像 `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`）；
- **更新 dist 后扩展卡片点「重新加载」**，必要时清档案 `Default/Service Worker/`（SW 脚本缓存会长期复用旧脚本，见 §5.3）；
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
| `src/background/core/tab-rules.ts` | 两条 DNR 规则族（AUTH 改写 + COOKIE 回放/剥离）构建、换值重建、冷启恢复、孤儿清理；**逐条安装降级**；父域覆盖 |
| `src/background/core/parallel-session.ts` | 绑定表/token 双通道捕获/Cookie 登录快照与回放（身份键黑名单）/种子下发/导航重推/授权健康门控；诊断埋点 `ql:diag` |
| `src/background/core/credentials.ts` | 账号密码 AES-GCM 加密（设备绑定种子） |
| `src/background/service-worker.ts` | 总装：`par.*`/`ql.diag` 消息分发、轮盘触发链、角标诊断、commands/onRemoved |
| `src/content/shield-main.ts` | MAIN 壳六项职责：存储命名空间、Cookie 袋虚拟化、种子直灌、写入上报、SW/CacheStorage 封控、IndexedDB 命名空间 + 页面层 `_qlck` 缓存分区 |
| `src/content/shield-bridge.ts` | ISOLATED 桥：window.postMessage ↔ chrome.runtime 双向通路 |
| `src/content/auto-login.ts` | 凭据自动填表（会话级 pending 表驱动） |
| `src/ui/parallel/*` | 并行管理主页（站点下拉记忆、授权停用、实时徽标、3000ms 轮询） |
| `src/ui/wheel/*` · `src/content/wheel-overlay.ts` | 轮盘双形态（小窗 / 页面浮层） |
| `tools/e2e/harness.mjs` | E2E 取证台架（交互/自检/文件驱动三模式；CDP IndexedDB 全量取证） |
| `tools/e2e/peek.mjs` · `analyze-events.mjs` · `rule-probe.mjs` · `fix-verify.mjs` | 事件流判读 / 离线串号分析 / DNR 格式探针 / 修复自动验证 |
| `research/idb-permissions/` | 专项研究工程（驱动器 + 分析器 + 5 份报告） |
