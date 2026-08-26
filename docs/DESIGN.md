# SessionBox 重构设计方案

> 状态：`设计已确认，待实现`（2026-08-26）
> 本文档与最终源码一一对应；实现阶段若改动行为，必须同步更新本文件。

---

## 1. 背景与目标

旧仓库 `d:\ai_assistant\SessionBox` 是 SessionBox 商业扩展 **v1.3.20（2020-01 构建快照）** 的还原产物，存在以下硬伤，不做补丁式修复而是整体重写（见 §9）：

- `manifest_version: 2`，Chrome 已停用，现代浏览器基本无法加载。
- 依赖 `webRequestBlocking` + `proxy` + `<all_urls>` + Firebase 第三方同步，权限过大、隐私与攻击面大、且依赖在线后端。
- `background.js` 等为 webpack 压缩产物，无源码、无构建配置、无测试，不可维护。
- 靠重写 `document.cookie` 单点隔离，`HttpOnly`/ServiceWorker/严格 CSP 场景会失效。

**本次重构明确要解决的需求（老大已复述）：**

> 单浏览器内，对同一网站/系统支持多个账号同时登录；打开多个账号后，**通过把标签页标题改写成「账号名/用户名」来区分不同账号**。

## 2. 关键决策（已与需求方对齐）

| 决策点 | 结论 | 理由 |
|---|---|---|
| 目标浏览器 | **Chrome / Edge（MV3）** | 覆盖用户群最大 |
| 产品形态 | **纯浏览器扩展** | 贴合轻量需求，可快速落地；本期不做指纹/IP 级硬隔离 |
| 隔离策略 | 自研「Cookie 罐仲裁 + 存储虚拟化」双层护栏 | Chrome 无 Firefox 式原生容器，需自建隔离层 |
| 持久化 | IndexedDB **本地优先**，同步为可插拔扩展点 | 不把多账号登录态外发给第三方 |
| 权限策略 | **最小权限 + 按站点动态授权** | 彻底移除 `<all_urls>` / proxy / webRequestBlocking / Firebase |

非本期范围（避免过度工程）：指纹伪装、IP/代理替换、桌面伴随进程、团队协作。参见 §11。

## 3. 总体架构

```
┌────────────────────── 浏览器外壳（MV3） ──────────────────────┐
│                                                              │
│  【 Background Service Worker 】                             │
│   ┌───────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│   │Session-   │  │Account-      │  │ Navigation           │ │
│   │Manager    │  │Registry      │  │ tabId <-> sessionId   │ │
│   │(CRUD/持久化)│  │(账号名/用户名) │  │                       │ │
│   └─────┬─────┘  └──────┬───────┘  └──────────┬───────────┘ │
│         │               │                     │              │
│   ┌─────▼───────────────▼─────────────────────▼───────────┐  │
│   │              Isolation（隔离层）                        │  │
│   │  Cookie-Fence  │  Storage-Fence  │  JS Cookie 视图     │  │
│   └─────────────────────────┬───────────────────────────┘  │
│                             │ IPC (chrome.runtime)          │
├─────────────────────────────┼──────────────────────────────┤
│    【 Content Script（每个会话标签页）】                      │
│   virtual-storage.ts │ title-hook.ts │ cookie-view.ts      │
└─────────────────────────────┼──────────────────────────────┘
                              │
                网站（同一域名下的 N 个账号标签页）
```

数据流：用户在扩展弹窗/面板创建「会话 + 账号名」→ 打开该会话标签页 → `Navigation` 绑定 `tabId↔sessionId` → `Isolation` 为该会话注入隔离态 → `Title-Hook` 把标签页标题改写为账号名。

## 4. 关键技术：会话隔离（核心，Chrome 无原生容器）

### 4.1 边界事实（必须先说清）

Chrome 单一浏览器实例内，Cookie 罐（cookie jar）是**全局共享**的，公开 API 不提供 Firefox 容器那样的「每标签页独立 cookie 罐」。`declarativeNetRequest` 的规则**不能按 tabId 匹配请求**（规则是全局的），因此无法在请求层做「每标签页独立 Cookie 头」。这是纯 Chrome 扩展的硬约束，任何过度承诺都会导致实现失败。因此隔离设计采用**双层护栏 + 焦点仲裁**，并在 §10 明确其并发上限。

### 4.2 第一层：Cookie-Fence（cookie-fence.ts，网络层）

- 每个会话在扩展自己的存储里维护一份 **Cookie 包**（`chrome.cookies` 导出/导入该会话会话级 Cookie）。
- **所有权模型（焦点仲裁的具体实现）**：同一 host 的 cookie jar 任意时刻只属于一个会话（当前聚焦的会话标签）。以 `sb:jarOwners`（`host→sessionId`）记录归属，`Cookie-Fence` 提供正交两操作：`capture`（纯捕获：把 jar 快照固化进会话包，不清 jar）与 `switchIn`（所有权切换：擦除 jar 中其它会话残留 → 写回目标会话包）。
- **绝不在导航过程中清 Cookie**。登录/跳转是连续的 `loading` 导航，若在导航期清 jar 会抹掉刚写入的登录 Cookie（导致永远退回登录页）。因此隔离只发生在「所有权切换」的确定时刻：聚焦仲裁（`tabs.onActivated`）离场标签先 `captureIfOwner` 保存登录态，进场标签再 `switchIn`；标签关闭（`onRemoved`）同样先固话再解绑。
- 用 manifest 权限 `"cookies"` 完成 `cookies.getAll / remove / set`。`HttpOnly` Cookie 由网络层正常携带，JS 层不依赖。
- **焦点仲裁**：同一域名在多个会话标签页同时打开时，以**当前激活（focused）标签页**作为罐的主导者；后台同站标签页靠存储层护栏保持界面状态自洽。这是单罐模型下能稳定落地的方案。

### 4.2b 登录态保存与自动登录

- 登录成功后，离场标签 / 关闭标签时通过 `captureIfOwner` 把当前 jar（含刚写入的登录 Cookie）固化为该会话的权威快照；标签在目标 host 内完成导航时同步固化（`tabs.onUpdated`），并把该 URL 记为 `lastVisitedUrl`。
- 重开会话（`session.openOrCreate`）：优先复用该会话已打开的标签页；否则若已有登录 Cookie，直接进入 `lastVisitedUrl`（登录后的首页），站点凭 Cookie 自动进入已登录态；无 Cookie 时才落到 `/login` 并自动填充。
- **账号密码加密存储（credentials.ts）**：用户录入的「账号密码」经 `crypto.subtle` AES-GCM 加密后存入会话（各字段独立 IV），密钥由设备种子经 PBKDF2 派生。仅在 Cookie 失效、需重新登录时才解密用于自动填充。
- **自动登录兜底（auto-login.ts，all_frames）**：当会话已存凭证但 Cookie 无效时，弹窗打开会话后向目标标签注入自动填表脚本。因密码框常位于内嵌 iframe，脚本以 `all_frames` 注入，各层 frame 自行定位用户名/密码/同意复选框/登录按钮，填充后提交。
- 新建会话时（`session.create`），若用户正停留在该站点且 jar 未被任何会话持有（普通已登录浏览），`captureHostJarIfUnowned` 会把当前登录态捕获为该新建会话初始 Cookie 包，同为自动登录兜底。

### 4.2c 会话复用策略（问题4：已存在复用 / 不存在新建）

`session.openOrCreate(host, username?, password?, accountAlias?)` 是弹窗「添加并打开」的入口，逻辑：
1. **显式指定 `accountAlias`**：精确匹配该账号（标签标题）的既有会话；匹配不到则视为**新账号**并新建会话（不退回复用他人会话）；
2. **未指定 `accountAlias` 的快捷打开**：复用该 host 最近更新的会话；
3. 均无则新建会话并捕获当前继承的登录态。
随后 `openOrCreate` 决定：复用已开标签 → 直接 `switchIn` 登录态；或新建标签进入 `lastVisitedUrl`（已登录）或 `/login`（自动填充）。带入了明文 `username` + `password` 时，先加密持久化，再作为本次自动登录凭证下发。

### 4.3 第二层：Storage-Fence（storage-fence.ts + virtual-storage.ts，JS 态层）

- 每个会话以 `sb:${sessionId}` 为命名空间，虚拟化 `localStorage / sessionStorage`（对原生对象做代理/读写前缀映射），使同站多标签页各自保有**一致、独立**的 DOM 存储视图。
- 这样后台的同站会话标签页在未被激活时，其页面状态不会因 Cookie 罐切换而错乱。

### 4.4 JS Cookie 视图（网络层已覆盖，无需独立脚本）

页面可见的 `document.cookie` 由浏览器 jar 直接提供。由于所有权切换仅在聚焦仲裁时刻触发，jar 与当前会话快照天然一致，因此**不单独注入脚本改写 cookie 视图**（避免旧版靠 setter 篡改的根因缺陷）。此判断与 §7.1「清理旧版 cookie 挂钩」一致。

### 4.5 已知边界（诚实声明）

单 Cookie 罐模型下，**同一站点的多个会话同时且高并发活跃时**，隔离以“焦点标签页”为准；极端场景（同一站 5+ 个账号标签页同时高频请求）在线级并发隔离上存在上限。此边界与行业中纯 Chrome 扩展方案的现实一致；若需“每会话独立 IP/指纹/网络栈”的硬隔离，应升级到桌面伴随进程方案（§11）。

## 5. 核心特性：标签页标题 = 账号名/用户名

这是老大的显式需求，作为一等公民设计：

1. **账号名注册**：创建会话时，用户为该会话录入三个字段——**用户名（登录账号）**、**账号名（标签标题）**、**密码**。用户名用于登录表单填充，账号名存于 `Account-Registry`（`sessionId → alias`）并用作标签标题。
2. **标签绑定**：`Navigation` 维护 `tabId → sessionId`，并在浏览器标签被回收（Service Worker 挂起）后，从 `chrome.storage.session` 恢复绑定。
3. **标题改写（title-hook.ts）**：
   - 整页加载：内容脚本执行 `document.title = alias`；
   - SPA 内部导航（`history.pushState` / `popstate`）：靠 `MutationObserver` 监听 `title` 节点与 URL 变化，自动重挂标题；
   - 标题策略可配置：`仅账号名` 或 `账号名 · 页面原标题`。
4. **只改可见标题，不改会话数据**：标题由扩展侧写回，不影响网站自身的 `document.title` 逻辑（避免触发对方侧脚本冲突）。
5. **标题策略（已锁定）**：默认值为**纯账号名**（`document.title = alias`）。「账号名 · 页面原标题」作为可选项在设置中提供，但默认关闭。

### 5.1 会话删除语义（已锁定）

删除会话**不影响已打开的标签页**：
- `Navigation` 的 `tabId → sessionId` 绑定仅在标签关闭时清除；会话记录被删除后，已打开标签仍按其已有绑定继续运行。
- 已打开标签页的标题继续保持账号名，页面的 JS 存储状态保持不变。
- 仅从 IndexedDB 移除该会话的 `Session` 与 `CookieBag`；已打开的标签下次刷新/重载后该会话不再拥有隔离包（视为默认/新会话），提示由 UI 给出。

## 6. 数据模型

```
Session {
  id: string
  name: string              // 展示名
  accountAlias: string      // 账号名/用户名（进标签标题）
  color: string
  createdAt, updatedAt: number
  siteHost: string          // 绑定的站点，用于动态授权
}

CookieBag {                 // 该会话在站点 H 的 Cookie 快照
  sessionId: string
  host: string
  cookies: CookieRecord[]   // chrome.cookies 可反序列化的记录
}
```

**持久化**：IndexedDB 本地优先（`db.ts`）。`chrome.storage.local` 有配额且不适合非结构化数据，故用 IndexedDB；同步能力（未来可插拔 E2E 加密同步）不在本期。

## 7. 权限与安全（最小权限）

```
manifest.json:
  manifest_version: 3
  permissions: [ "tabs", "scripting", "cookies", "storage", "contextMenus" ]
  host_permissions: []          // 不预授权任何站点
  optional_host_permissions: [ "*://*/*" ]  // 用户添加站点时按需授权
  content_security_policy: 无远程代码 / 无 eval
  background: { service_worker }
```

- 彻底移除：`proxy`、`webRequest`、`webRequestBlocking`、`<all_urls>`、`unlimitedStorage`、Firebase 相关 CSP 白名单。
- 站点访问由用户**显式添加**后动态授权，默认不触碰任何网站。
- **站点动态授权交互入口（已锁定）**：用**快捷键**或**右键菜单**触发「把当前站点加入会话站点」：

```
commands:
  add_current_site: { suggested_key: Ctrl+Shift+E }
context_menus:
  sessionbox_add_site  → 在页面/链接右键菜单提供「将当前站点添加为会话站点」
```

两者都指向同一授权入口：调用 `chrome.permissions.request` 按需申请 `*://<host>/*` 的 host 权限，再把站点加入站点清单。

### 7.1 UI 重设计与旧版清理（已确定，蓝白色系）

**旧版 UI 全部清理**：删除旧构建产物里的 UI 页面与无关静态资源——`assets/PleaseWait.html`、`views.html`、`view.css`、`views.js`、`PleaseWait.js`、`PleaseWaitStatic.html`、`assets/SVG/*`、`assets/Icons/*`（`box.svg` 保留）、`assets/onboarding/*`、`assets/previews/*`、`assets/translations/*`、`assets/*.png/jpg`（图标集）等。这些属于旧版黑色商务主题与无用占位素材，重写时不再保留同风格资源。

**新 UI 主题：蓝白色系**
- 主色：`#1E6FFF`（品牌蓝），浅色背景 `#F5F8FF`，纯白卡片 `#FFFFFF`。
- 文字：主文字 `#1B2A4A`，次要 `#6B7A99`。
- 交互色：成功 `#22C55E`、警告 `#F59E0B`、危险 `#EF4444`；禁用态 `#D7E0F1`。
- 圆角 `8px`，阴影 `0 1px 4px rgba(16,60,180,0.10)`，整体轻量、扁平、低饱和。
- 组件：弹窗（Popup）会话列表 + 设置页（Options）站点管理。新 UI 采用独立样式变量（CSS 自定义属性）集中管理，杜绝硬编码色值。

新 UI 资源统一放在 `src/ui/`（结构与样式随源码管理），不落入旧版发布根目录。

## 8. 目标目录结构（目标态）

```
docs/DESIGN.md
manifest.json
src/
  background/
    service-worker.ts       # 消息路由 + 事件装载
    core/
      session-manager.ts
      account-registry.ts
      site-auth.ts          # 站点动态授权 + 快捷键/右键菜单入口
      isolation/
        cookie-fence.ts
        storage-fence.ts
      navigation.ts
      credentials.ts    # 账号密码 AES-GCM 加密存储（自动登录兜底依赖）
    tabs/
      tab-title.ts
  content/
    virtual-storage.ts
    main/virtual-storage-runtime.ts
    title-hook.ts
    auto-login.ts     # 登录表单自动填充（all_frames，覆盖 iframe 内密码框）
  storage/
    db.ts
  ui/
    send.ts           // 弹窗/设置页共用的后台调用助手
    popup/            // 弹窗：会话列表（蓝白色系）
    options/          // 设置页：站点管理（蓝白色系）
    theme.css         // CSS 变量：蓝色系设计令牌（§7.1）
  shared/
    types.ts
    messages.ts   // IPC 协议
    constants.ts  // storage 前缀、默认策略
package.json
tsconfig.json
build/            // 构建产物（webpack/vite），不提交源码混淆
tests/
```

实现后，旧版构建产物（`background.js`、`dll/*`、`CookieJar.js`、`forge.bundle.js`、`publicsuffixlist.js`、`views.*`、`assets/actions` 之外的冗余静态资源等）一律删除，不保留中间态副本（见 §9 落地步骤）。

## 9. 为什么整体重写而不是打补丁

旧代码的核心缺陷（`document.cookie` 重写、全局 Cookie 罐模型、MV2、Webpack 黑盒）是**架构根因**，不是可修的局部 Bug。任何「保留旧 bundle、改动点参数」的做法都违反根因修复原则。因此：

- **推翻旧实现**，按 §8 目录用 TypeScript + MV3 从零搭建；
- 隔离层面采用 §4 的「Cookie 罐仲裁 + 存储虚拟化」双层方案，淘汰单点 `document.cookie` 篡改。

## 10. 落地阶段划分（只做需求内收敛，不铺开）

- **Phase 1（本期核心）**：MV3 骨架 + 会话 CRUD + 站点动态授权（快捷键/右键菜单）+ 标签页标题改写为账号名 + IndexedDB 持久化 + **新版蓝白色系弹窗/设置页**。等价于把旧版「核心多账号使用」路径在新架构上走通。
- **Phase 2（可选增强）**：省电/标签分组、会话导入导出。
- **不做（明确非范围）**：指纹伪装、IP/代理、桌面进程、团队协作 —— 避免过度工程与无收益复杂度（与规则 6 一致）。

## 11. 已知限制与升级路径

| 限制 | 触发条件 | 升级路径 |
|---|---|---|
| 单 Cookie 罐在线级并发上限 | 同站多账号高并发活跃 | 桌面伴随进程（每会话独立浏览器实例，对标 SessionBox One / Multilogin） |
| 无指纹/网络层隔离 | 平台利用设备指纹关联封号 | 升级桌面方案 + 每会话代理 |

---

## 待办（决策已锁定，剩余为实施执行项）

- [x] 标题策略默认值：**纯账号名**（§5）
- [x] 会话删除语义：**不影响已打开标签页**（§5.1）
- [x] 站点动态授权入口：**快捷键 `Ctrl+Shift+E` + 右键菜单**（§7）
- [x] UI 重设计：**清理旧版 UI，蓝白色系**（§7.1）
- [ ] Phase 1 实施：MV3 骨架 + 会话 CRUD + 站点动态授权 + 标签标题改写 + IndexedDB + 新 UI