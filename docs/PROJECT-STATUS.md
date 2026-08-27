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
| COOKIE | 出站 `Cookie` 头全量移除（共享真实 jar 对绑定标签隐身） | 全部资源类型 | 3.0 |
| CACHE | GET XHR 查询串追加 `_qlck=t<tabId>`，把全 profile 共享的 HTTP 缓存按标签硬分区 | xmlhttprequest GET | 3.3 |

配套机制：

- Token 捕获双通道：命名空间 `__auth_token__` 写事件上报 + 出站 fetch/XHR Authorization 嗅探；快照持久于 `chrome.storage.session`（会话级，SW 冷启恢复）。
- 授权健康门控：host 无浏览器授权或被手动停用时关闭全部改写并在 UI 显示「未授权 · 已暂停」（`enforcementOff`）。
- 「移除授权」= 尽力调用 `permissions.remove` + 失败时写入**本地停用名单**（Chrome 的 required 权限无法经 API 回收，功能层必然生效）。
- `main_frame` 导航刻意不改写（保护静态资源与 SSO 跳转语义）。

## 三、版本里程碑速览（v2.5 → v3.4）

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
| 3.3 | 第四平面：HTTP 缓存按标签分区 `_qlck`（应对「泄露方向跟随第一个登录者」） |
| 3.4 | AUTH 改写扩展到 sub_frame；诊断脚本沉淀入 CHANGELOG |

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
