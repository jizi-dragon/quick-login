# 可行性调研：配置页监听 · 最近 5 个 · 主体名 · 跳转轮盘

> 调研基线：代码 3.10.8（轮盘 Hub 切盒版）· 站点 tonbridge-config.aksoegmp.com 实测语料（E2E 事件流 264+ 条真实请求）
> 结论先行：**可行，且大部分基础设施已存在**。主体名提取有三层来源兜底，唯一需要现场确认的是「四类配置页的 DOM/路由→主体对应关系」，约 15 分钟合作探针即可定案。

## 一、需求拆解

| # | 需求 | 现状差距 |
|---|---|---|
| 1 | 监听打开的配置页（菜单/对象/工作流/生命周期配置） | 无页面类型识别；有 tabs 权限与绑定表 |
| 2 | 记录最近 5 个 | 无历史记录存储 |
| 3 | 提取「主体性」名称（某对象/某工作流/某生命周期） | 无；但有 API 响应可借道 |
| 4 | 主体名追加到页签标题 | 标题管线已有（现只显示账号别名） |
| 5 | 新轮盘快捷跳转 | 轮盘浮层机制已有（账号切换用） |

## 二、已有基础设施（可直接复用）

1. **标题管线**：`setTabTitle`（scripting.executeScript 权威写入）+ `title-hook.ts`（MutationObserver 抗 SPA 重置）+ `navigation.applyTitle`（切换账号时下发）+ 内容脚本消息通道。→ 只需把「纯别名」升级为「别名 + 主体名」复合标题。
2. **轮盘浮层机制**：`wheel-overlay.ts` —— background `executeScript` 注入、`__QL_WHEEL_ACTIVE__` 幂等开关、Shadow DOM 隔离、`chrome.runtime.sendMessage` 取数。→ 新轮盘照抄此模式，零新权限。
3. **网络嗅探位**：`shield-main.ts` 的 `patchNetworkSniffers` 已包好 fetch/XHR（MAIN world、document_start、all_frames）。→ 加**白名单响应嗅探**即可建「guid→名称」缓存，无需新权限（webRequest 不可读响应体，页面层是唯一通路）。
4. **框架覆盖**：内容脚本 `all_frames: true` 已开 → 平台把控制台放在 iframe（实测 `/iframe-content` 文档请求 18 次）也能读到其 DOM。
5. **E2E 台架**：验证新功能不破坏六平面隔离（回归有保障）。

## 三、主体名提取——三层策略（按可靠性排序）

实测语料已确认的站点事实：

- 工作区路由 `/web?display=<guid>`（43+ 次出现，`__edit=2` 为编辑态）
- 管理端路由 `/admin/<域>/<功能>?cid=<guid>`（如 `/admin/config/docs-lifecycle`、`/admin/user-mgmt/power-set/list`）
- **名称型 API 确凿存在**：
  - `UserView/GetView?id=<guid>`（15 次，id 与 `display=` 同源 → 视图名）
  - `BasicObject/BasicObjectDetail?id=<guid>` + `biz/BasicObject/ObjectDetail`（对象名）
  - `Menu/GetUserMenuPermission` + `MenuGroup/QueryList`（**一份响应即得全部路由 slug→菜单中文名映射**）
  - 工作流/生命周期详情 API（同类形态，路由 slug 待现场确认）

| 层 | 机制 | 覆盖 | 成本 |
|---|---|---|---|
| L1 路由解析 | URL slug → 页面类型（菜单/对象/工作流/生命周期），query 取 guid | 页面类型 100%；主体 guid 100%；主体名 0% | 极低，纯字符串 |
| L2 响应嗅探 | 白名单 API 的 JSON 响应 → `guid→名称` 缓存（storage.session，host 作用域） | 主体名主要来源（打开页面必有详情请求） | 低：白名单匹配 + 截断 256KB + 异步解析 |
| L3 DOM 兜底 | 同源 iframe/顶层面包屑/标题元素的 MutationObserver 摘取 | L2 未命中时兜底；同时校准 L2 | 中：选择器需现场确认 |

标题展示时若名称尚未学到，先显示「<类型> · <guid 前 8 位>」，名称到达后**原地升级标题**（管线支持后续覆写）。

## 四、监听与记录

- **切换检测**：SPA 内路由跳转在 Chromium 会触发 `tabs.onUpdated`（changeInfo.url，pushState 也触发）——无需新增 `webNavigation` 权限；iframe 内路由用现有 all_frames 内容脚本上报兜底。
- **去重**：连续相同 `路由+guid` 跳过；同一实体回访则**置顶**（MRU 而非 FIFO）。
- **存储**：`chrome.storage.session`，键 `ql:recentPages:<host>`，条目 `{pageType, guid, subject, url, accountAlias, ts}`，容量 5（可配置 3–10）。
- **隔离纪律**（项目一贯原则）：记录带 `accountAlias` 供轮盘展示来源账号；跳转发生在**当前标签页**（保持其账号绑定与六平面规则，tabId 不变则 DNR/命名空间全部无缝）。

## 五、新轮盘设计要点

- 新 command `quick-pages`（建议 `Alt+W`，`chrome://extensions/shortcuts` 可改），与账号轮盘 `Alt+Q` 并列；
- 复用 Shadow DOM 浮层机制；**竖排列表形态**优于圆环（5 条中文长名称的可读性；圆环适合 6–10 个短标签），每项：类型图标 + 主体名 + 来源账号徽标；
- 点击 = `chrome.tabs.update(当前tab, {url})` → 账号绑定/命名空间/回放规则原样生效；
- 菜单页入口可选：从 `Menu/GetUserMenuPermission` 缓存渲染二级「直达菜单」面板（二期）。

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| 四类页面的路由/主体对应关系未实地确认 | **15 分钟探针**（见 §七）先行，映射表落定再写码 |
| 名称晚于导航到达 | 延迟升级标题（管线天然支持） |
| 嗅探性能 | 白名单路径 + 体积截断 + 仅 JSON |
| 跨账号误跳 | 记录带来源账号徽标；跳转永远发生在当前账号标签页 |
| 代码基线漂移 | 本次调研基于 3.10.8 实读；实现前重读并行页/轮盘现状 |

## 七、下一步（建议顺序）

1. **探针定案（约 15 分钟，需你配合）**：E2E 台架加三个探针（document.title 变化记录 / 面包屑候选 DOM 摘取 / 白名单 API 响应字段 dump），你依次打开菜单、对象、工作流、生命周期各一个配置页 → 产出「路由 slug ↔ 页面类型 ↔ 主体字段」映射表；
2. 实现（预估一个版本周期）：L1+L2 为主、L3 视探针结果取舍 → 新轮盘 + 复合标题 + 最近 5 存储；
3. 回归：六平面 E2E 全套 + 新功能探针；版本号 3.11.0 三处同步 + CHANGELOG（惯例）。
