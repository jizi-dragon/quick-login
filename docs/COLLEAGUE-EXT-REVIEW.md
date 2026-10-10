# 同事扩展功能评审 · 阿克索配置助手 v2.1.0

> 用途：**融合决策用**。请直接在 §五 决策表上勾选（回复编号即可，如「要 A1 A9 B1 B3 B4 C1 D1」）。
> 评审对象：`akso-config-assistant.zip`（同事提供），解压于 `tmp/colleague/x/`（`tmp/` 已 gitignore）。
> 评审日期：2026-10-08 · Akso Pass 侧基线：`3.14.1`

---

## 一、它是什么

| 项 | 值 |
|---|---|
| 名称 / 版本 | 阿克索配置助手 v2.1.0 |
| 规模 | 8 个文件、**3,456 行**、纯 JS 无构建（`content.js` 用 ES5 `var`，其余用 `const/let/async`） |
| 目标平台 | 同 Akso Pass：阿克索 EGMP（低代码平台） |
| 权限 | `storage`, `tabs`, `scripting`, `activeTab` + `optional_host_permissions: http/https` |
| **关键结论** | **它不做任何账号隔离**——没有 `cookies`、没有 `declarativeNetRequest`、没有 `webRequest`，全局假设「一个 profile 一个已登录账号」 |

→ **与 Akso Pass 是互补关系，不是竞品。** **Akso Pass** 的价值集中在「多账号并行隔离」。

---

## 二、功能全清单（23 项）

图例：**Akso Pass 现状** = 已有 / 部分 / 无 ｜ **建议** = ★★★强推 / ★★建议 / ★可选 / ✗不建议 ｜ **工作量** S(<0.5d) / M(0.5–2d) / L(>2d)

### A. 标题与基础信息

| # | 功能 | 用户拿到什么 | 实现位置 | QL 现状 | 建议 | 量 |
|---|---|---|---|---|---|---|
| A1 | 标题同步（可配置选择器） | 页面上某个元素的文字变成标签标题；1s 轮询 + MutationObserver 即时纠正 | `content.js:15-30,123-184` | **已有**（但走路由分类器+平台名称 API，覆盖 5 类页面） | ✗ **不融合** | — |
| A2 | 多候选选择器 | 每行一个候选，从上往下取第一个命中的，抗前端改版 | `content.js:58-95` | 无 | ★★ **借机制**（见 A9） | S |
| A3 | 标题前缀 / 后缀 | 标题前后加固定串，如 `- OA` | `content.js:137` | 部分（复合标题是 `账号别名 · 主体名·类型`） | ✗ 已有更强形态 | — |
| A4 | 生效域名白名单（通配） | 只在指定域名跑脚本，省资源 | `content.js:66-77` | 已有（按授权域注入） | ✗ | — |
| A5 | 检查间隔可配（≥200ms） | 调轮询频率 | `options.html:205` | 无（固定 3s 轮询） | ✗ 无必要 | — |
| A6 | 角标「本页已生效」圆点 | 命中时图标上一个小圆点，**只显示点、不显示用户名** | `background.js:14` | 部分（角标用于版本号/轮盘闪标） | ★ 可选（隐私取舍值得沿用） | S |
| A7 | 状态灯六态 | 运行中/已暂停/未授权/域名不匹配/未命中/本页未运行 | `popup.js:409-459` | 部分（徽标 4 态：在线/待登录/未授权·已暂停/离线） | ✗ 已覆盖 | — |
| A8 | 「立即执行一次」 | 强制 tick 一次并回显结果 | `content.js:342-346` | 无 | ★ 可选 | S |
| **A9** | **选择器测试按钮** | 在活动页试跑选择器，**逐条回显命中/「元素存在但无文字」/语法错误**，并预览最终标题 | `options.js:100-151`、`content.js:319-341` | 无 | ★★★ **强推**（诊断粒度极好，正好补 Akso Pass 的选择器兜底） | S |
| A10 | 系统版本（点击复制） | `GET /api/platform/Build/BuildInfo` → `gitBranch` | `popup.js:186-242` | 无 | ★★ 建议（并入诊断包） | S |
| A11 | 流程 Id（点击复制） | URL 的 `id=` 参数 | `popup.js:219` | 部分（参数在 URL 里，未显性展示） | ★★ 建议（并入 B1） | S |
| A12 | 系统地址（点击复制） | 当前页 origin | `popup.js:220` | 部分（管理页有站点列表） | ★ 可选 | S |

### B. 对象与流程

| # | 功能 | 用户拿到什么 | 实现位置 | QL 现状 | 建议 | 量 |
|---|---|---|---|---|---|---|
| **B1** | **请求参数面板** | 折叠面板展示 5 字段：`objectId`(URL `bid`)、`instanceId`(URL `id`)、`token`、`host`、`cookie`，**每项可一键复制** | `popup.js:622-669`、`common.js:170-197` | 无 | ★★★ **强推，但数据源必须换**（见 §四·2） | M |
| B2 | 当前状态高亮 | 抓页面 `.status-text_*` 的 title 文字，与状态同名的按钮加橙底 | `content.js:359-380` | 无 | ★★ 建议（跟随 B3 一起做） | S |
| **B3** | **状态列表（读）** | 两步链路：`POST /api/platform/Layout/GetFormInstance` → 挖 `lifecycle.id` → `GET /api/config/lifecycle/Status/GetListByBasicId`；两列按钮网格 | `content.js:512-661` | 无 | ★★★ **强推** | M |
| **B4** | **一键改状态（写）** | 点状态按钮即 `POST /api/openapi/v1.0/Object/status/{instanceId}/{code}`，成功后刷新页面 | `popup.js:745-797`、`content.js:795-819` | 无 | ★★ **建议，但交互与判定必须重做**（见 §四·3） | M |
| B5 | 打开状态配置页 | 新标签打开 `/admin/config/lifecycle/{lifecycleId}/status/{statusId}?__edit=2` | `popup.js:725-739` | 无 | ★ 可选 | S |
| B6 | 「启用生命周期」 | 按钮名如此，实调 `GET /api/tms/TrainingTask/TestGetMaterialFinishingRates`（**语义存疑**） | `content.js:704-745` | 无 | ✗ **先别合**，需先问清语义 | ? |
| B7 | objectId 缺失时用 mid 反查 | `/web/view?mid=` 页面用 `GET /api/platform/UserView/GetViewList?menuId=` 反查 objectId | `content.js:475-503` | 无 | ★★ 建议（B1/B3 的前置） | S |

### C. 标签管理

| # | 功能 | 用户拿到什么 | 实现位置 | QL 现状 | 建议 | 量 |
|---|---|---|---|---|---|---|
| **C1** | **同名标签去重** | 扫全部窗口 → 按「标题」或「标题+网址」分组 → **两段式**：第 1 击出预览、第 2 击才真关；每组留 1（优先当前页签），固定标签排除 | `popup.js:303-405` | 无 | ★★★ **强推，但必须重做**（见 §四·4） | M |

### D. 导航

| # | 功能 | 用户拿到什么 | 实现位置 | QL 现状 | 建议 | 量 |
|---|---|---|---|---|---|---|
| **D1** | **常用页面书签** | 用户可编辑的固定链接列表（名称+路径），可配系统地址拼 URL；**内置 7 条平台路由** | `options.html:264-280`、`common.js:26-34` | **部分**：只有「最近去过」的 MRU（每 host 5 条）+ Alt+W 轮盘 | ★★★ **强推**（书签与 MRU 互补） | M |
| D2 | 系统地址配置 + 取最近访问网页 | 配 baseUrl，或一键取最近访问过的域 | `common.js:68-101` | 已有（账号带 siteHost/scheme） | ✗ 已覆盖 | — |

### E. 配置与授权

| # | 功能 | 用户拿到什么 | 实现位置 | QL 现状 | 建议 | 量 |
|---|---|---|---|---|---|---|
| E1 | 独立完整设置页 | 左侧三选项卡布局（显示用户/常用页面/网站授权） | `options.html` 全篇 | 无（设置都在管理页，1990 行） | ✗ 不建议新增（会分裂），把配置项并进管理页 | — |
| E2 | 网站授权管理 | 已授权列表 + 撤销按钮 | `options.js:309-361` | **已有**（站点管理，含移除/停用名单） | ✗ 已覆盖 | — |
| **E3** | **同级 `-config` 域推导** | 授权 `br.x.com` 时自动一并申请 `br-config.x.com`（IP/两段域/www 不推导） | `options.js:291-307` | 无（硬编码 `tonbridge-config.aksoegmp.com`） | ★★★ **强推**（低成本高收益） | S |
| E4 | 设置存 `chrome.storage.sync` | 配置跨设备同步 | `common.js:53` | 用 local + 云端双数据源 | ✗ 不建议（已有云端源，sync 有配额且会打架） | — |
| E5 | 「启用本网站」一键授权 | 申请权限后 reload 页面 | `popup.js:133-167` | 已有（添加站点并授权） | ★★ 借「申请失败退回只申请原 origin」的稳健手法 | S |

### F. 工程手法（非功能，纯可借鉴）

| # | 手法 | 价值 | 位置 | 建议 | 量 |
|---|---|---|---|---|---|
| F1 | 按域动态注册 content script + 双层门控 | 权限即注册、撤销即注销，五处校正；页面侧再复核一次 | `background.js:36-98` | ★★ 可选 | M |
| F2 | BFS 容错解析响应结构 | `findLifecycleObject` BFS≤4、`extractStatusArray` 启发式——对付未文档化接口 | `content.js:569-661` | ★★ 建议 | S |
| F3 | 405 读 `Allow` 自动换方法 + 可诊断错误 | 把「方法轨迹 + 响应前 180 字」打包成错误信息 | `content.js:725-758` | ★★ 建议 | S |
| **F4** | **`__iframe=` 内嵌地址参数解码** | 平台的真实地址可能被编码在 `__iframe=` 参数里 | `common.js:106-150` | ★★★ **强推**（直接影响 QL 分类器覆盖率） | S |
| F5 | 两段式破坏性操作 | 第 1 击预览、第 2 击执行、可取消 | `popup.js:357-405` | ★★ 建议（C1 要用） | S |
| F6 | 幂等自毁防重复注入 | `window.__CI_EXT__.destroy()` | `content.js:33-53` | ✗ QL 已有同思路（`__QL_SHIELD_INSTALLED__`） | — |

---

## 三、顺带挖到的平台知识（不管融不融合都值钱）

| 类别 | 内容 |
|---|---|
| **路由地图** | `/admin/user-mgmt/users/list`（用户管理）、`/admin/user-mgmt/role-mgmt/list`（角色）、`/admin/config/workflow`（工作流）、`/admin/config/menu-mgmt?__edit=2`（菜单）、`/admin/config/view-management`（视图）、`/admin/secret-page/trace-log`（TraceLog）、`/admin/config/form-layout/edit?id=…`（文件布局） |
| **平台接口** | `Build/BuildInfo`、`Layout/GetFormInstance`、`lifecycle/Status/GetListByBasicId`、`UserView/GetViewList?menuId=`、`openapi/v1.0/Object/status/{id}/{code}`、`tms/TrainingTask/TestGetMaterialFinishingRates` |
| **URL 约定** | `bid` = objectId、`id` = instanceId；**真实地址可能编码在 `__iframe=` 参数里** |
| **多租户命名** | `<租户>.aksoegmp.com` ↔ `<租户>-config.aksoegmp.com`（QL 目前只认 `tonbridge-config`） |
| **响应形状** | `{code:0,data,message}`；`GetFormInstance` 任意深度含 `lifecycle{id,name}`；状态项含 `id/code/name` 多别名 |
| **DOM 约定** | React + CSS Modules 哈希类名（`header_QZ9Sk`、`status-text_4fqtL`），配 `[class*="status-text-"]` 兜底 |
| **鉴权** | Cookie + Bearer 双轨；同源请求 `credentials:'same-origin'` 即可 |

> 其中 D1 内置的 7 条路由里，有 5 条是 Akso Pass 的 `page-monitor.ts` L1 分类器**未覆盖**的（user-mgmt / role-mgmt / menu-mgmt / view-management / trace-log / form-layout）——可以直接补进去。

---

## 四、融合前必须先解决的 4 件事

**1. 标题所有权冲突（硬冲突，必须单选）**
Akso Pass 的 `title-hook.ts:12-17` 监听 `documentElement` 全量变更并强制回写账号别名；同事的 `content.js:172-184` 监听 `<title>` 父节点并强制回写用户信息。两边都是「与目标不同就写」→ **互相触发，标题抖动 + CPU 抖动**，并让「标题=账号名」这个核心区分能力失效。
→ 结论：**A1 不融合，Akso Pass 独占标题**；若将来要共存，QL 需改用 `chrome.tabs.update` 权威写入。

**2. 跨世界读 cookie（B1 数据源必须换）**
同事的 `content.js` 跑在 **ISOLATED** world，而 Akso Pass 的 Cookie 虚拟化补丁打在 **MAIN** world 的 `document` 上 → **管不到它**。它读到的是**真实 jar**，不是账号 Cookie 袋。后果：
- ① Akso Pass 的会话卫生会把身份键从真实 jar 驱逐 → `__auth_token__` 常为空 → 参数面板 token 空、所有平台请求不带 Authorization；
- ② 若真实 jar 残留别的账号 token → **跨账号凭据外显并可一键复制**。
→ 结论：**借它的 UI/交互（5 字段 + 分项复制 + 折叠），数据源换成 Akso Pass 后台**——后台本来就握着权威数据（`ql:parTokens` 的本账号 token + 账号 Cookie 快照）。这样反而更简单。

**3. 改状态的交互与判定（B4 必须重做）**
现有三个缺陷：① **一键写库无二次确认**；② 成功判定是「响应体里没有 `message` 就算成功」→ 空响应/非 JSON 错误页会被当成成功；③ 成功后 reload「此刻的活动标签页」→ 请求期间切页会**刷错页**；④ 状态项缺 `code` 时会**兜底用 `name` 当 code** POST 出去。
→ 结论：加二次确认、显式成功判定、固定在**该账号页签**内执行并刷新它、缺 code 直接拒绝。

**4. 去重会误关绑定页签（C1 必须重做）**
三个坑：① 分组键 `t.title || ''` **未排除空标题** → 所有无标题标签落进同一个 `''` 组，只留 1 个其余全关；② 跨**全部窗口**、无范围选项；③ 计划是分析时快照、确认时不复核（期间被固定的标签仍会被关）。
→ 对 Akso Pass 更严重：**关掉绑定页签会触发 v3.12.0 的「登录态终结」**（清 token/快照）。
→ 结论：必须排除空标题、限定窗口范围、**绑定页签默认保护**（或至少显著警告）。

---

## 五、决策表（请勾选）

**我的推荐组合：`A9 · A10 · A11 · B1 · B2 · B3 · B4 · B7 · C1 · D1 · E3 · E5 · F2 · F3 · F4`**
（即：参数面板 + 状态工具 + 标签去重 + 书签 + 平台适配修正 + 几处工程手法；合计约 **6–8 人日**）

| # | 一句话 | 我的建议 | 你的决定 |
|---|---|---|---|
| A9 | 选择器测试按钮（逐条诊断） | ★★★ | ☐ |
| A10 | 系统版本展示 + 复制 | ★★ | ☐ |
| A11 | 流程 Id 展示 + 复制（并入 B1） | ★★ | ☐ |
| A6 | 角标「已生效」圆点（不露用户名） | ★ | ☐ |
| A8 | 立即执行一次 | ★ | ☐ |
| A12 | 系统地址展示 + 复制 | ★ | ☐ |
| **B1** | **请求参数面板（数据源换后台）** | ★★★ | ☐ |
| B2 | 当前状态高亮 | ★★ | ☐ |
| **B3** | **状态列表（两步接口链路）** | ★★★ | ☐ |
| **B4** | **一键改状态（重做交互）** | ★★ | ☐ |
| B5 | 打开状态配置页 | ★ | ☐ |
| B7 | objectId 缺失时用 mid 反查 | ★★ | ☐ |
| B6 | 「启用生命周期」 | ✗ 待确认语义 | ☐ |
| **C1** | **同名标签去重（必须重做）** | ★★★ | ☐ |
| **D1** | **常用页面书签（+ 补 7 条路由进分类器）** | ★★★ | ☐ |
| **E3** | **同级 `-config` 域推导** | ★★★ | ☐ |
| E5 | 授权失败退回原 origin | ★★ | ☐ |
| F2 | BFS 容错解析 | ★★ | ☐ |
| F3 | 405 换方法 + 可诊断错误 | ★★ | ☐ |
| **F4** | **`__iframe=` 参数解码** | ★★★ | ☐ |
| F1 | 按域动态注册 + 双层门控 | ★★ | ☐ |
| A1–A5 A7 | 标题同步整套 | ✗（与 QL 直接冲突） | ☐ |
| E1/E4 | 独立设置页 / storage.sync | ✗ | ☐ |
| F5/F6 | 两段式操作 / 幂等自毁 | 已具备或随 C1 实现 | ☐ |

---

## 六、附：评审方法与可信度

- 解压源码：`tmp/colleague/x/`（8 文件 3,456 行，已逐行读完）
- 由 4 份独立分析交叉验证：popup 面（`popup.html/js`）、页面引擎（`content.js`）、后台（`background.js`）、共享契约（`common.js`）+ 评审人本人通读 `options.html/js` 与 `common.js`
- 所有「平台接口 / 路由 / DOM 选择器」均标注了 `file:line`，可回溯核对
- 未逐项实测运行（需要真实平台登录态）；标注「语义存疑」处为代码无法自证的推断
