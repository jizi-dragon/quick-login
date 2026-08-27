# QuickLogin — 扩展 UI + 本地引擎 多账号并行方案 架构设计稿

> 状态：`设计稿 v5（决策已收口，可开工）`（2026-08-27）
> 前置调研：见 `docs/DESIGN.md` §3、§9（扩展无法同站多账号并行在线的实测结论）与竞品调研（AdsPower / Multilogin / SessionBox One 均为桌面形态）。
> v2 变更：去掉独立桌面 UI，本地程序退为纯后台引擎，全部交互收敛到扩展弹窗（对标 VSCode 扩展 + Language Server）。
> v3 变更：引擎语言 Python → **TypeScript**（与扩展同栈），Monorepo 单仓库，分发编译为单文件 exe，用户零环境依赖。
> v4 变更（决策收口）：分发形态定为**目录版**（放弃 SEA）；并行管理界面定为**独立扩展页**（弹窗留入口按钮）。
> v5 变更：**彻底移除 Playwright**——实例拉起改为裸 `spawn(chrome.exe --user-data-dir)`，自动登录改为 CDP 直连（`chrome-remote-interface` + `Runtime.evaluate` 移植扩展已验证的填表逻辑）。分发体积从 ~100MB 降至 ~30MB。

---

## 1. 目标与非目标

### 目标
1. **同站多账号并行在线**：N 个账号 = N 个真实浏览器实例（独立 user-data-dir），Cookie / localStorage / IndexedDB 物理隔离，互不登出。
2. **免密自动登录**：首次录入账号密码后，此后启动账号直达已登录首页。
3. **UI 单一入口**：账号管理（新增/启动/停止/删除/在线状态）全部在扩展内完成——并行多开用**独立扩展页**，免密切换留在现有弹窗，本地程序无界面。
4. **零环境安装**：引擎以目录版分发（engine.js + node.exe + node_modules），install.ps1 一键安装，用户无需装 Node/Python。
5. **凭证安全**：账号密码加密落盘，不明文存储。

### 非目标（明确裁剪，防过度工程）
- ❌ 指纹伪装 / 反检测（Canvas、WebGL、TLS）——无防关联诉求。
- ❌ 代理绑定 / IP 隔离——内部系统。
- ❌ 团队协作 / 云同步——单机工具。
- ❌ macOS / Linux——Windows 优先。
- ❌ 独立桌面 UI——交互全在扩展。

## 2. 总体架构

```
┌─ Chrome（用户的浏览器）──────────────────────────────────────────┐
│                                                                  │
│  ┌─ quick-login 扩展（UI 前端，TypeScript）────┐                  │
│  │ 弹窗：免密切换（现有能力不变）              │                  │
│  │ 独立扩展页 parallel.html：并行多开管理      │                  │
│  │   账号列表/启动/停止/在线徽标/日志          │                  │
│  └──────────────┬──────────────────────────────┘                  │
│                 │ chrome.runtime.connectNative()                  │
│                 │ Native Messaging（stdio，双向长连接）            │
└─────────────────┼─────────────────────────────────────────────────┘
                  ▼
┌─ quicklogin-engine（本地后台，TypeScript，无 UI，零自动化框架）────┐
│  ┌────────────────┐  ┌─────────────────┐  ┌────────────────────┐ │
│  │ NM Host 消息层  │─▶│ AccountStore    │─▶│ Launcher           │ │
│  │ 协议分发/回推   │  │ SQLite+DPAPI    │  │ spawn + CDP 编排    │ │
│  └────────────────┘  └─────────────────┘  └────────┬───────────┘ │
└─────────────────────────────────────────────────────┼────────────┘
                        ┌─────────────────────────────┼────────────┐
                        ▼                             ▼            ▼
                 Chrome 实例#1                  Chrome 实例#2   实例#3 …
                 (profiles/lyl)                (profiles/T0601)
                 spawn(chrome.exe --user-data-dir) —— 引擎崩溃也不连坐
                 独立 Cookie/localStorage/token —— 并行在线互不登出
```

核心事实不变：**每账号一个独立 Chrome 实例**。v5 起实例由裸 `spawn` 拉起（Chrome 原生 `--user-data-dir` 参数，无自动化框架），自动登录经 CDP（`--remote-debugging-port` + `chrome-remote-interface`）注入。

## 3. 技术选型（v5）

| 层 | 技术 | 理由 |
|---|---|---|
| UI 前端 | 现有 quick-login 扩展（TS） | UI 已存在；与引擎**同语言同仓库** |
| 通信 | Native Messaging（stdio） | MV3 扩展与本机进程的唯一官方通道；Node 的 `process.stdin/stdout` 是原生能力 |
| 实例拉起 | **`child_process.spawn(chrome.exe, ['--user-data-dir=...', '--remote-debugging-port=...'])`** | Chrome 原生命令行参数即完整隔离实例；进程天然独立（引擎退出不连坐）；零第三方依赖 |
| 自动登录 | **CDP 直连：`chrome-remote-interface` + `Runtime.evaluate`** | 移植扩展 auto-login.ts 已实测校准的填表逻辑（DOM 选择器 + 顶层访问 srcdoc iframe.contentDocument + 原生 setter 触发 React）——本就不依赖 Playwright 能力，换个执行通道而已 |
| 存储 | **better-sqlite3** + Windows DPAPI（`win-dpapi`）+ node:crypto AES-GCM | 密钥由 DPAPI 派生（不出操作系统，换机失效） |
| 构建 | **esbuild（已有工具链）** bundle 引擎为单 js | 开发期 `node dist/engine.js`；分发为目录版（engine.js + node.exe + node_modules 打 zip ≈ 30MB），install.ps1 一键安装 |

### 3.1 决策记录：为什么彻底抛弃 Playwright（v5）

1. **隔离不需要它**：`--user-data-dir` 是 Chrome 原生参数，一行 spawn 即完整隔离实例；Playwright 的 `launchPersistentContext` 内部做的也是这件事，我们直接用底层能力。
2. **自动登录不需要它**：我们的填表逻辑是纯 DOM 选择器方案（已在目标站点实测通过），Playwright 的 `frameLocator`/自动等待并未参与；CDP `Runtime.evaluate` 执行同一段代码即可。
3. **进程模型更健壮**：spawn 出的 Chrome 与引擎是父子进程但**不随引擎退出**（默认 detached 语义），原 P4 的「detach 托管」设计自然达成。
4. **体积/攻击面双减**：node_modules 从 ~100MB（含 Playwright 驱动）降到 ~5MB（chrome-remote-interface + better-sqlite3 + win-dpapi）；分发 zip 从 ~100MB 降到 ~30MB（大头只剩 node.exe）。
5. 代价（诚实记录）：失去 Playwright 的自动等待，需自行轮询 DOM 就绪（扩展版 auto-login 本来就是轮询模型，逻辑同构）；Chrome 会显示「正在调试此浏览器」提示条（无功能影响）。

### 3.2 决策记录：TS 优于 Python（v3，保留）

1. **零环境安装**：目录版分发自带 node.exe，用户解压 + 运行 install.ps1 即用；Python 方案需用户装解释器或 PyInstaller 打包。
2. **同栈红利**：扩展与引擎共享 `shared/nm-protocol.ts`（NM 消息两端 import 同一份类型），协议改动编译期即报错；共享 esbuild 构建配置与代码风格。
3. 单仓库 Monorepo：`packages/extension` + `packages/engine`，消除跨语言仓库割裂。

## 4. 模块设计

### 4.1 `engine/nm-host.ts`（消息层）
- 注册为 NM Host：`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.quicklogin.engine` → manifest json（`allowed_origins` 绑定扩展 ID）。
- stdio 帧协议（4 字节小端长度前缀 + JSON），`process.stdin`/`process.stdout` 直读直写。
- 协议定义在 **`shared/nm-protocol.ts`（扩展与引擎共用）**：

```ts
// 扩展 → 引擎
type EngineCommand =
  | { cmd: 'list' }
  | { cmd: 'create'; siteHost: string; username: string; alias: string; password: string }
  | { cmd: 'start'; accountId: string }
  | { cmd: 'stop'; accountId: string }
  | { cmd: 'delete'; accountId: string };

// 引擎 → 扩展（推送）
type EngineEvent =
  | { event: 'state'; accountId: string; state: 'starting' | 'online' | 'login_failed' | 'offline' };
```

### 4.2 `engine/store/`（数据层）
- `better-sqlite3` 单文件 `quicklogin.db`：`Account { id, site_host, username, alias, password_enc, created_at, updated_at }`。
- `node:crypto` AES-256-GCM 加密，密钥 = DPAPI(`win-dpapi`) 保护的随机种子派生（HKDF）。设备绑定，换机失效。
- 与扩展 IndexedDB 不互通，多账号场景以引擎库为准。

### 4.3 `engine/launcher.ts`（编排）
```ts
async function start(account: Account): Promise<void> {
  // 端口 = 9300 + 账号序号（每实例唯一，供 CDP 连接）
  // spawn(chromePath, [
  //   `--user-data-dir=${profilesDir}/${account.id}`,
  //   `--remote-debugging-port=${port}`,
  //   `--no-first-run`, `--no-default-browser-check`,
  //   `https://${account.site_host}/`,
  // ])
  // 等待 CDP endpoint 就绪 → 若页面落在 /login 则 autoLogin(port, account)
  // 成功后 emit state=online
}
```
- Chrome 路径探测顺序：注册表 `App Paths\chrome.exe` → `Program Files` 常见位置 → Edge（`msedge.exe`）兜底。
- spawn 出的实例**不随引擎退出**（独立进程）；引擎重启后通过探测 `--remote-debugging-port` 是否存活恢复在线状态。

### 4.4 `engine/autologin.ts`
移植扩展 `auto-login.ts` 已实测校准的填表逻辑，执行通道从 content script 换为 CDP `Runtime.evaluate`：
- DOM 选择器（用户名/密码/协议复选框/登录按钮，含 srcdoc iframe 内密码框的顶层 `contentDocument` 访问）原样保留；
- 原生 setter + `input`/`change` 事件触发 React 受控组件的写入方式原样保留；
- 轮询等待模型原样保留（CDP 每 800ms evaluate 一次探测+填充+提交）；
- 选择器外置 `selectors.yaml`（按 host 分组）。失败降级手动登录，persistent profile 仍保登录态。

### 4.5 扩展改造（packages/extension）
- manifest 加 `nativeMessaging` 权限。
- **新增独立扩展页 `parallel.html`（v4 决策）**：并行多开管理主界面，全尺寸标签页，含账号列表（在线徽标 + 启动/停止/清除登录态/删除）、新增账号表单、引擎连接状态、事件日志面板。复用 options.html 的页面模式与蓝白主题。
- 现有弹窗保持原样（免密切换），仅加一个「并行多开 →」入口按钮跳转 `parallel.html`——两场景两种形态：免密切换「点一下就走」适合弹窗，并行多开「常驻监控状态」适合标签页。
- `background` 加 NM port 管理器：懒连接、指数退避重连、`onDisconnect` 时标记状态 unknown 并提示。
- 引擎未安装（`connectNative` 即断）→ 扩展页引导安装，不静默失败。

## 5. 核心流程

```
扩展并行页点「启动 lyl」
  → background: port = chrome.runtime.connectNative("com.quicklogin.engine")
  → 发 { cmd: "start", accountId }
  → 引擎: spawn(chrome.exe --user-data-dir=profiles/lyl --remote-debugging-port=9300)
          首次 → CDP Runtime.evaluate 自动填表登录；再次 → 直接进已登录首页
  → 引擎推送 { event: "state", state: "online" }
  → 扩展并行页徽标变绿
```

## 6. 生命周期与容错

| 风险 | 对策 |
|---|---|
| NM host 由 Chrome 按需拉起，浏览器重启断连 | 扩展端懒连接 + 指数退避重连；账号实例是独立进程，Chrome 重启不影响在线账号 |
| 引擎进程退出 | spawn 的 Chrome 实例**天然独立**（v5 红利：无 detach 设计成本）；引擎重启后探测各账号 `--remote-debugging-port` 存活恢复在线状态 |
| 调试链路长（扩展→NM→引擎→Chrome） | 引擎结构化日志（`logs/engine.log`）；扩展 background 打印 NM 收发帧 |
| 账号实例崩溃/被用户误关 | 引擎定期探测端口 → 状态回推 offline，扩展页徽标变灰 |

## 7. 仓库结构（Monorepo，v3 决策）

```
quick-login/                       # 现仓库升级为 monorepo
  packages/
    shared/
      nm-protocol.ts               # NM 消息类型（扩展/引擎共用）
    extension/                     # 现有 quick-login 扩展（平移）
      src/… manifest.json
      ui/parallel/                 # 新增：并行多开管理页（v4）
    engine/                        # 新增本地引擎
      src/
        main.ts                    # NM host 入口（stdio 循环）
        nm-host.ts                 # 协议分发 + 事件推送
        store/db.ts                # better-sqlite3 CRUD
        store/crypto.ts            # DPAPI + AES-GCM
        launcher.ts                # spawn 编排 + Chrome 路径探测 + 端口分配
        autologin.ts               # CDP Runtime.evaluate 自动登录（移植扩展逻辑）
        chrome-path.ts             # Chrome/Edge 安装位置探测（注册表/常见路径）
      selectors.yaml
      profiles/                    # user-data-dir（gitignore）
      quicklogin.db                # gitignore
  scripts/
    build.mjs                      # 扩展 esbuild（现有）+ 引擎 bundle
    pack-engine.mjs                # 目录版打包（engine.js + node.exe + node_modules → zip）
    install.ps1                     # 解压后一键安装：写注册表/NM manifest + 引导重载扩展
  package.json                     # workspaces: packages/*
```

## 8. 与现有扩展的关系

| | packages/extension | packages/engine |
|---|---|---|
| 角色 | UI 前端 + 单账号免密切换（现有能力不变） | 多账号并行引擎（无 UI） |
| 隔离 | 共享浏览器（串行切换） | 每账号独立实例（并行在线） |
| 数据 | IndexedDB | SQLite（独立，不互通） |
| 依赖 | 独立可用 | 引擎未装时扩展优雅降级 |
| 语言 | TypeScript | TypeScript（共享 shared/nm-protocol.ts） |

## 9. 实施阶段

| 阶段 | 内容 | 交付判据 | 状态 |
|---|---|---|---|
| P1 引擎骨架 | monorepo 平移 + NM host + SQLite + spawn Launcher | 扩展按钮启动两个账号，并行在线不互踢 | ✅ 完成（命令行 NM 帧协议实测：2 账号并行在线） |
| P2 自动登录 | selectors.yaml + CDP autologin（移植扩展逻辑） | 删 profile 目录后一键自动重登 | ⏳ |
| P3 扩展 UI | 独立扩展页 parallel.html（账号列表+徽标+日志）+ 弹窗入口按钮 + 断线重连 | 全程浏览器内操作，并行状态常驻可视 | ⏳ |
| P4 分发容错 | 目录版打包（node.exe 随包）+ 状态恢复（端口探测）+ install.ps1 | 全新机器：解压→运行 install.ps1→可用，无 Node/Python | ⏳ |

P1 落地备注：
- DPAPI 依赖最终选 `@primno/dpapi`（预编译 N-API 免本地编译；`win-dpapi` 在 VS2026 下源码编译失败弃用）。
- 引擎 bundle 输出 `.cjs` + `engine-host.cmd` 包装（目录版分发入口），规避 packages/engine 的 `"type":"module"` 声明冲突。
- 扩展端已接 NM：manifest 加 `nativeMessaging`，background 含 port 管理器（懒连接/指数退避重连）与事件桥（P3 的 parallel 页消费）。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 登录页改版选择器失效 | selectors.yaml 外置；失败降级手动登录，登录态不丢 |
| `--remote-debugging-port` 安全面 | 端口仅绑定 127.0.0.1（Chrome 默认行为，局域网不可达）；端口范围 9300+ 低位随机分配 |
| Chrome「正在调试此浏览器」提示条 | 仅视觉提示，无功能影响；文档注明 |
| 本机无 Chrome | chrome-path 探测顺序 Chrome → Edge 兜底；均无时扩展页引导安装 |
| NM 权限审查（上架场景） | 内部工具不上架；`allowed_origins` 白名单绑扩展 ID |
| profiles 目录膨胀 | 扩展页提供「清除登录态」（引擎删目录） |

---

## 决策记录（已全部收口）
- [x] UI 形态 → 无独立桌面 UI，扩展为唯一前端（v2）
- [x] 引擎语言 → TypeScript（Node），monorepo 同栈（v3）
- [x] 仓库位置 → 现仓库升级 monorepo：extension + engine（v3）
- [x] 打包形态 → 目录版分发（engine.js + node.exe + node_modules zip + install.ps1），放弃 SEA（v4）
- [x] 并行模式入口 → 独立扩展页 parallel.html，弹窗留「并行多开 →」入口按钮（v4）
- [x] 自动化依赖 → **彻底移除 Playwright**：spawn 拉实例 + CDP 自动登录（v5）
