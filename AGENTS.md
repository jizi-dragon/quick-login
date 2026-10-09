# AGENTS.md —— 给在这个仓库里干活的 AI 协作者

> **这份文件是写给 AI 编码助手的，不是写给人看的。**
>
> 人能容忍模糊的说明——他会问、会试、会从上下文推断。AI 不会：它会把"没写下来的约定"
> 当成"不存在这个约定"，然后用**看起来完全正常**的代码违反它。
>
> 所以下面每一条都是**规则形状的**（祈使句 + 判据），且尽量注明它来自哪次真实事故。
> 没有事故背书的偏好不写在这里——`README.md` 与 `docs/USER-MANUAL.md` 才是人的入口。
>
> **本文件只放「祈使句 + 判据 + 出处指针」，不复述事故经过。** 叙事抄一遍，
> 两处迟早不一致，而读的人**不知道哪份是真的**（参见本文件规则 12）。
>
> | 想了解 | 去哪 |
> |---|---|
> | **隔离平面总表（权威口径）** | [docs/CODEBASE_OVERVIEW.md](docs/CODEBASE_OVERVIEW.md) §Architecture |
> | **踩过的坑（11 条，只增不改，含判据）** | [docs/PITFALLS.md](docs/PITFALLS.md) |
> | 功能清单与使用说明（给人看的） | [docs/USER-MANUAL.md](docs/USER-MANUAL.md) |
> | 现状快照与安全边界 | [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) |
> | 现场排障与诊断埋点怎么读 | [docs/DIAG-GUIDE.md](docs/DIAG-GUIDE.md) |
> | 纯扩展方案的论证与先例（历史调研） | [docs/BROWSER-ONLY-MULTILOGIN-RESEARCH.md](docs/BROWSER-ONLY-MULTILOGIN-RESEARCH.md) |
> | 验证脚本怎么跑、每个脚本覆盖什么 | [tools/verify/README.md](tools/verify/README.md) |
> | 版本里程碑与每次缺陷的根因 | [CHANGELOG.md](CHANGELOG.md) |

---

## 0. 这个扩展是什么（一句话建立正确的心智模型）

**在一个浏览器窗口里，对同一个内部低代码平台并行在线多个账号。**
每个账号一个独立标签页，账号间的**呈现层与网络层全链路隔离**。

**它解决的不是"多开标签页"，而是"同一 origin 的多份共享资源会互相污染"**：

| 共享资源 | 不处理的后果 |
|---|---|
| `localStorage` | 后登录的账号把身份写进同一个键，前一个账号"变成"后一个 |
| Cookie jar | 同 origin 只有一份 jar，登录 B 会顶掉 A |
| HTTP 缓存 | 同 URL 的响应被全 profile 共享 |
| `IndexedDB` | **平台把 `isAdmin` 与菜单树缓存在 origin 级共享 IDB 里**——这是历史"四象限串号"的直接载体 |
| `ServiceWorker` / `CacheStorage` | 站点自建缓存在网络栈内，无视 DNR 规则 |

⇒ 所以本项目的核心是**七个隔离平面**（存储 / 广播 / AUTH / COOKIE / CACHE / SW·Cache / IDB），
每个平面都对应上表里的一个共享资源。**新增功能前先问：它会不会引入第八个共享资源？**

---

## 1. 铁律

> 违反这些**不会抛异常**，只会让某个账号静默串号——而串号看起来像"平台抽风"。

### 隔离与安全

| # | 规则 |
|---|---|
| 1 | **七个平面缺一不可，且每个平面都要问"这条路径绕过了谁"**。历史教训：平面 4（HTTP 缓存）曾用 DNR 的 `redirect.urlTransform` 实现——**该字段是 Firefox 专属、Chrome 从未支持**（Chromium 以 `Unexpected property: 'urlTransform'` 拒绝），而 `updateSessionRules` 是**原子批量** ⇒ 同批的 COOKIE/AUTH 规则被一起拒绝，**网络平面全死**。现在改为页面层实现 + **逐条安装降级**。<br>判据（**必须是精确的**）：`Get-ChildItem packages/extension/src -Recurse -Filter *.ts \| Select-String -Pattern 'urlTransform\s*:'` ⇒ **零命中**。<br>★ 判据要匹配**作为键**的 `urlTransform:`，**不要**只搜这个词——它在解释"为什么不用它"的注释里有 4 处（`types.ts` / `shield-main.ts` / `tab-rules.ts`），只搜词会**永远为红**。已实测：精确判据零命中，且构造一个真实使用后**能红**（反证通过） |
| 2 | **MAIN 世界与 ISOLATED 世界的分工不能混**：`shield-main.ts`（`"world": "MAIN"`）负责**补丁页面 API**；`shield-bridge.ts`（ISOLATED）负责**与 background 通信**。补丁必须落在 MAIN，通信必须落在 ISOLATED。判据：`manifest.json` 里 `shield-main` 的 `"world": "MAIN"` 必须存在 |
| 3 | **平台口令加密存放，且永不入日志、永不出现在诊断埋点里**。历史教训：`mergeCookieSnapshot` 的 token 门禁、`IDENTITY_COOKIE_BLACKLIST` 的身份键过滤——**凭据类的键名要在一处集中声明**，不要在各个调用点各写一份黑名单。<br>★ **日志落盘/输出只有一个通道**：`shared/log.ts` 的 `log()`，它**无条件先打码**（`shared/redact.ts`）。取 logger 一律 `getLogger('模块名')`。<br>★ **`src/` 下除 `shared/log.ts` 外不许出现裸 `console.*`** —— `console.debug('...', obj)` 这种**对象直传**是最容易顺手泄密的形态（今天对象里只有计数，明天有人塞 `{ username, password }` 做"排障方便"）。<br>★ **打码顺序固定：先做 `%s` 替换 → 再拼多余参数 → 最后整体打码。** 顺序反了会失效：`logger.info('password=%s', pw)` 若先拼成 `password=%s pw`，`%s` 把**键和值分开**，打码规则完全命中不了（`PITFALLS #4`）。<br>判据：`node tools/verify/log-redaction.mjs`（37 条，含对象直传、分隔参数、结构性扫描三侧）+ 反证 `node tools/verify/falsify-log-redaction.mjs`（3/3）。见 `PITFALLS #3`、`#4`、`#5` |
| 4 | **真实 cookie jar 不得驻留扩展账号的会话**（会话卫生三层防线：`preJar` 基线 → 快照差集清扫 → `cookies.onChanged` 持续驱逐），**且全部按写入者归属门控**——原生页签自己写的 cookie **不能动**，否则会破坏用户不用扩展时的正常登录 |
| 5 | **DNR 规则按 `tabIds` 限定，不要写全局规则**。全局规则会改到用户自己开的普通标签页，那是"帮倒忙" |
| 6 | **`main_frame` 导航刻意不改写**（保护静态资源与 SSO 跳转语义）。改这条之前先读 `docs/CODEBASE_OVERVIEW.md` 的风险清单 |

### 构建与契约

| # | 规则 |
|---|---|
| 7 | **版本号三处必须同步**：`package.json` / `packages/extension/manifest.json` / `src/shared/constants.ts` 的 `EXT_VERSION`。判据：三处字符串**逐字相等**（实测当前 `3.17.1` × 3）。改版本用 `node tools/bump.mjs <from> <to>`，**不要手改三处** |
| 8 | **构建目标锁死 `chrome110` + `format: 'iife'`**（`scripts/build.mjs`）。`iife` 是刻意的：MV3 的 `service_worker` 与 content script **都不是 ES module 环境**，改 `esm` 会直接坏掉。判据：`Select-String -Path scripts/build.mjs -Pattern "format: 'iife'"` 必须命中 |
| 9 | **`manifest.json` 的 CSP 是 `script-src 'self'`** ⇒ **扩展页面不能引外链脚本，也不能用 `eval`**。新增 UI 依赖时这是第一道否决门槛（**不要**为此放宽 CSP） |
| 10 | **`content_scripts` 的注入体积是敏感资源**：它注入**每一个页面**。新增依赖前先问"这东西值得被注入到用户的每一个网页里吗"。⇒ 这也是**不引入前端框架**的核心理由（框架会进 content script） |
| 11 | **`dist/` 是构建产物，不入库、不手工编辑**。改行为改 `packages/extension/src/**`，然后 `npm run build` |
| 12 | **文档只有一个权威源，其余地方写指针**。已有实例：`docs/CODEBASE_OVERVIEW.md` 的平面总表**明确标注**"README 与 PROJECT-STATUS 的『六平面』表未收录平面 1.5，PROJECT-STATUS 的小标题写作『四平面』与表内 6 行自相矛盾——**以本节为准**"。⇒ 改架构时**只改权威源**，其余地方加一行指针，**不要**同时改三处 |

### 验证资产（2026-10-09 立，因为这里退化了两次）

| # | 规则 |
|---|---|
| 13 | **验证脚本必须放在被 git 跟踪的 `tools/` 下**，**不许放 `tmp/`**。历史：20 个脚本曾在 gitignored 的 `tmp/` 里（`git ls-files tmp/` = **0**），换机器 / 新 clone / CI **一个都拿不到**；同类损失此前已发生过一次（`tools/e2e/` 整套在收束清理中被删） |
| 14 | **脚本的依赖必须写进 `package.json`**。历史：**3 个幽灵依赖**（`playwright-core` 全部脚本用、`@peculiar/x509` 与 `reflect-metadata` 3 个自签 https 脚本用）只存在于 `node_modules/`，`package.json` 与 `package-lock.json` 里都没有 ⇒ `npm ci` 直接失败。判据：`npm run check-deps` |
| 15 | **脚本换目录后必须重验它的"仓库根"算法**。惯用法是 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')`——**`tmp/x.mjs` 里一层即仓库根，迁到 `tools/verify/` 后必须两层**，而**少一层不报错，只会指向错目录**（表现为去读 `tools/dist/manifest.json`）。判据：把表达式**真的求值**并断言等于仓库根，**并做对照实验**证明旧参数确实指错 |
| 16 | **跑验证前必须先 `npm run build`**：所有脚本都要读 `dist/manifest.json` 的 `key` 反推扩展 ID（`sha256(Base64(key))` 前 32 位 → 映射 a–p）。没有 `dist/` 会直接抛错 |
| 17 | **门禁必须先反证再相信**：写完判据先问**"拆掉什么它才会红？"**。实测教训：`check_deps.mjs` 的第一版在源码上跑正则 ⇒ 假阳性（把注释里的 `import` 当依赖）；为修它改成"先剥字符串" ⇒ 模块说明符被清空、正则的 `[^'"]+` 匹配不到 ⇒ **检查数从 27 掉到 0，门禁退化成"永远绿"**，而它打印的「检查 0 处」看起来完全正常。⇒ 它现在带一个自检：一处三方模块都没扫到就报 `DEP_SUSPECT` |

---

## 2. 命名与分层约定

- **`src/` 五层**：`background/`（SW 与核心逻辑）、`content/`（注入脚本）、`ui/`（popup / parallel / wheel）、
  `shared/`（类型 / 常量 / 消息协议）、`storage/`（IndexedDB 封装）。**新增文件按职责归层，不要放根。**
- **消息协议单一定义**：所有 `chrome.runtime` 消息的请求/响应类型在 `src/shared/messages.ts`。
  **不要在调用点就地写对象字面量**——那会让"某个字段改了但另一边没改"静默失效。
- **localStorage 的键集中在 `src/shared/constants.ts` 的 `LOCAL_KEYS`**（如 `ql:cloudAuth` / `ql:siteSchemes`）。
  **不要在业务代码里写裸键名字符串。**
- **`manifest.json` 的 `permissions` 只加真正需要的**。`optional_host_permissions` 走
  `permissions.request` 时**必须在用户手势里最先发起**——晚一步手势失效、`fetch` 必然失败
  （`ui/parallel/parallel.ts` 的 `ensureCloudOriginPermission` 就是为此而写，别把它挪到 `await` 之后）。

---

## 3. 改哪跑哪（门禁矩阵）

### 基线（动手前 + 改完后各跑一次）

```powershell
npm ci                    # 依赖现在已显式声明（含 playwright-core）
npm run typecheck         # tsc --noEmit，strict
npm run build             # esbuild → dist/
npm run check-deps        # 幽灵依赖门禁（三方裸模块必须已声明）
node tools/verify/log-redaction.mjs          # 日志打码验收（37 条，秒级，**不需要浏览器**）
node tools/verify/falsify-log-redaction.mjs  # 上一条的反证（3/3）
npm run verify:list       # 列出回归脚本（不跑）
```

### 改了什么 → 必须额外跑什么

| 你改了什么 | 必须额外验证 |
|---|---|
| `src/background/core/tab-rules.ts`（DNR 规则） | `npm run verify -- --only v310` + **手工确认规则是逐条安装的**（`updateSessionRules` 是原子批量，一批被拒会连坐） |
| `src/content/shield-main.ts`（平面补丁） | 至少跑 `--only defect` 与 `--only jarhygiene`（这两个覆盖串号与会话卫生） |
| `src/content/auto-login.ts`（填表节奏） | `--only fillrhythm`（9/9）与 `--only autologin`（5/5） |
| 云端数据源相关（`cloud-device` / `cloud-store` / `cloud-migrate`） | `--only dynsnap` + **手工走一遍设备流**（它依赖真实服务端与 host 授权手势，脚本覆盖有限） |
| `src/ui/**`（popup / parallel / wheel） | 无自动化覆盖 ⇒ **必须浏览器装载实测**。★ 改完要在 `chrome://extensions` **点「重新加载」**——Chrome 会缓存扩展 SW 脚本，直接重启浏览器也可能复用旧脚本 |
| `manifest.json` | ① 版本号与另两处一致（规则 7）；② 新增权限是否真的必要；③ `content_scripts` 的 `world` / `run_at` 未被动过 |
| `scripts/build.mjs` | ① `format: 'iife'` 与 `target: chrome110` 未变；② `entryPoints` 与 `manifest.json` 引用的产物**一一对应**（漏一个 = 装载时报"找不到文件"，而那是运行期才发现的） |
| `tools/**` | `node tools/check_deps.mjs` 必须仍绿 |

### 跑验证脚本

```powershell
npm run verify                      # 跑全部 12 个（几分钟，真起 Chromium）
npm run verify -- --only v310       # 只跑名字含 v310 的
npm run verify -- --only jarhygiene
```

★ **`npm run verify` 故意要求显式 `--browser`**（脚本内部检查）：
每个脚本都真起一个带扩展的 Chromium（数十秒）并往 `tmp/` 写档案。
不加这个开关会**拒绝运行并列出待跑清单**——因为"默认跑完几分钟"会让人不敢按，
于是"批量验证"这件事会重新退化（规则 13 的同类风险）。

### 提交与文档

- **提交信息用 Conventional Commits**（`feat:` / `fix:` / `chore:` / `docs:` / `tools:`），
  与服务器端统一。
- **每修一个"看起来正常但其实是坏的"缺陷，就把它的判据写进脚本注释或
  [`docs/PITFALLS.md`](docs/PITFALLS.md)。**
  ★ 本仓 **2026-10-09 起有 `docs/PITFALLS.md` 了**（11 条）——在此之前这类教训
  只散在 `CHANGELOG.md` 里，而两者的分工不同：
  `CHANGELOG.md` 记"每次发布改了什么"（历史），
  `PITFALLS.md` 记"**哪些错会静默发生、怎么一眼认出来**"（可复用的判据）。
  **不要在两处都写全量**（规则 12）——叙事抄一遍，两处迟早不一致。
  格式照服务器端 `akso-vault/docs/PITFALLS.md`：五段（症状/根因/判据/处置/推广）、
  编号是稳定 ID 永不重编、**每条必须有可执行判据**，已修的改状态标注而不是删除。

---

## 4. 本机环境速查

| 项 | 实际情况 |
|---|---|
| Node | **最低 20**（`.nvmrc` = 20，`engines` = `>=20` 无上界）。实测本机日常为 Node 24 |
| 包管理器 | **npm**（workspaces：`packages/*`）。构建与工具链都用它 |
| 构建 | `scripts/build.mjs`（esbuild）。产物 `dist/`，**iife + 11 个入口**（实测：`background` 1 + `content` 6 + `ui` 4） |
| 类型检查 | `tsc --noEmit`，`strict` + `noUnusedLocals/Parameters` + `noFallthroughCasesInSwitch` |
| **没有的东西** | **无单元测试框架、无 lint、无 CI**（`.github/` 不存在）。这不是遗漏，是现状——所以**规则 13–17 的验证资产就是全部保障** |
| 浏览器 | Chrome / Edge，**`minimum_chrome_version: 110`**。装载：`chrome://extensions` → 开发者模式 → 加载已解压的 `dist/` |
| 云端服务 | `https://www.dragonrain.top:8443`（`akso-vault`）。设备流（RFC 8628）授权，`CLOUD_ORIGIN_PATTERN` 在 `parallel.ts` 里 |
| 目标平台 | `tonbridge-config.aksoegmp.com`（无状态 JWT Bearer）。内网形态为 **纯 http**（`10.100.0.105`）⇒ scheme 必须数据化（v3.10.9 的教训） |
| **测试档案** | 脚本在 `tmp/` 下建 Chrome 档案（`tmp/ui-*`）。**`tmp/` 是 gitignored**——脚本入库、运行产物不入库。这些档案会占数百 MB，可随时删 |
| **Node 的坑** | `npm install --no-save` 装的包**不会进 `package.json`**，但会留在 `node_modules` ⇒ 这正是 3 个幽灵依赖的成因（规则 14）。**加依赖一律走 `npm install --save-dev`** |

---

## 5. 不要做的事

| 不要 | 为什么 |
|---|---|
| 在 `content_scripts` 里引入前端框架 | 它注入用户的**每一个页面**（规则 10）。UI 框架只允许用在 `ui/`（popup / parallel / wheel 是扩展自己的页面） |
| 用 DNR 的 `urlTransform` | Chrome 从未支持（Firefox 专属），且 `updateSessionRules` 是原子批量 ⇒ 一批被拒会连坐 AUTH/COOKIE 规则（规则 1） |
| 把 `format` 改成 `esm` | MV3 的 SW 与 content script 都不是 ES module 环境（规则 8） |
| 放宽 `manifest.json` 的 CSP 来引外链脚本 | CSP 是 `script-src 'self'` 是刻意的安全带（规则 9） |
| 手改 `dist/` | 构建产物，下次 `npm run build` 会被覆盖。改 `src/`（规则 11） |
| 把验证脚本写进 `tmp/` | 那是 gitignored ⇒ 等于没写（规则 13，已退化过两次） |
| 为省事把 `permissions.request` 放到 `await` 之后 | 用户手势会失效，`fetch` 必然失败，而报错不指向根因 |
| 假设 `npm install` 之后 `node_modules` 里有什么就能用什么 | 那可能是残留（规则 14）。**能跑 ≠ 可复现** |
| 同时改 README / PROJECT-STATUS / CODEBASE_OVERVIEW 三处的架构描述 | 权威源只有一个（规则 12）。改三处 = 制造三个会各自漂移的副本 |

---

## 6. 当前进行中的改造（写在这里，因为它会改变多条规则的前提）

**用户 2026-10-09 决定：彻底废除扩展端的本地账号保存，强制登录云端账号。**

现状是**双数据源**（`dataSource: 'local' | 'cloud'`，v3.14/v3.14.1 已实现云端），
本次要**删掉 local 那一半**：

| 要删的 | 位置线索 |
|---|---|
| `local` 数据源分支与切换 UI | `ui/parallel/parallel.ts` 的 `switchDataSource` / `source-local` / `source-cloud` |
| 本地 → 云端迁移合并 | `background/core/cloud-migrate.ts`、`cloud.migrate` 消息 |
| 本地凭据加密存储 | `credentials` / `hasPassword` 的本地分支（云端模式下口令在服务端 Fernet 密文里） |
| 切换确认弹窗（含"不再提示"标志） | `LOCAL_KEYS.skipSwitchConfirm` |

**保留**：云端会话、设备流、以及**离线时的"列表只读缓存"**（不含口令；可看、可开页签，
**不可新增/编辑，填表失效**）——这是用户在"彻底删本地"与"离线可用"之间选的折中。

⇒ **动这块之前先读本节**。这条改造会让"数据源"这个概念消失，
凡是按 `dataSource === 'cloud'` 分支的地方都要一并简化。

---

_本文件遵循 [AGENTS.md](https://agents.md) 约定：仓库根目录的 `AGENTS.md` 就是 AI 协作者的规则入口
——短、规则形状、可执行。如果你发现自己需要在这里加"背景介绍"，那说明它该去
`README.md` 或 `docs/USER-MANUAL.md`。_
