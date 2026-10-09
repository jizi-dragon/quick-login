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
> | **踩过的坑（24 条，只增不改，含判据）** | [docs/PITFALLS.md](docs/PITFALLS.md) |
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
| 3 | **平台口令加密存放，且永不入日志、永不出现在诊断埋点里**。历史教训：`mergeCookieSnapshot` 的 token 门禁、`IDENTITY_COOKIE_BLACKLIST` 的身份键过滤——**凭据类的键名要在一处集中声明**，不要在各个调用点各写一份黑名单。<br>★ **日志落盘/输出只有一个通道**：`shared/log.ts` 的 `log()`，它**无条件先打码**（`shared/redact.ts`）。取 logger 一律 `getLogger('模块名')`。<br>★ **`src/` 下除 `shared/log.ts` 外不许出现裸 `console.*`** —— `console.debug('...', obj)` 这种**对象直传**是最容易顺手泄密的形态（今天对象里只有计数，明天有人塞 `{ username, password }` 做"排障方便"）。<br>★ **打码顺序固定：先做 `%s` 替换 → 再拼多余参数 → 最后整体打码。** 顺序反了会失效：`logger.info('password=%s', pw)` 若先拼成 `password=%s pw`，`%s` 把**键和值分开**，打码规则完全命中不了（`PITFALLS #4`）。<br>判据：`node tools/verify/verify-log-redaction.mjs`（**121 条**：含对象直传、分隔参数、结构性扫描、**闭环**、**三通道分工**、**离线判定唯一**、**SW 入口不静默落空**、**网络平面失败可见**、**凭据不进日志调用**、**DOM 双向一致性**）+ 反证 `node tools/verify/verify-falsify-logredaction.mjs`（**23/23**）。见 `PITFALLS #3`、`#4`、`#5`、`#14`、`#15`、`#16`、`#17`、`#18`、`#19` |
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
| 18 | **删代码后必须与 HEAD 逐行对照**（不是"看 typecheck 绿不绿"）。<br>实测教训（v3.18，见 §6.3）：删"数据源按钮的 UI 状态块"时，一条跨多行正则**吞掉了紧邻的设备流代码**（三个监听器 + `openApprovalTab` + `deviceApprovalUrl`）。合成出的文件**语法合法**，`tsc` 与 `npm run build` **都通过**，唯一信号是"`deviceUserCodeOpen` 声明但未使用"——那读起来像"清理未用变量"，实际是**功能被删掉**。<br>判据：`git show HEAD:<file>` 与当前文件逐行比，列出**"HEAD 有、现在没有"**的行，**逐条确认它们在删除清单里**。<br>★ **typecheck 只说明"剩下的代码自洽"，不说明"该留的还在"。** |
| 19 | **跨多行正则删代码时，锚点必须唯一且紧贴目标**。同上教训：那条正则用 `(?:\s*[^\n]*\n)*?` 这样的**开放量词**往后吃，把不相邻的块也吞了。<br>⇒ 优先用**精确的多行字面量**（整块原样写出来）而不是正则。 |
| 20 | **删 DOM 标记后必须核对 `HTML id ↔ TS getElementById` 一致性**。TS 里 `getElementById('x')` 拿到 `null` 的类型仍是 `HTMLElement`（因为断言了 `as`）⇒ **编译期不报错**，运行时点一下就崩。<br>判据：`id="..."` 的集合与 `getElementById('...')` 的集合做差集，**`TS − HTML` 必须为空**。本轮的检查脚本当场抓到一处（`help-reset-confirm-btn`）。 |
| 21 | **"零裸 `console.*`"只证明了"没有绕过 A 通道"，证明不了"没有 B 通道"。**<br>实测（`PITFALLS #12`）：扩展端有**三个**写出进程的出口 —— `console` / `chrome.storage` / 网络。其中 `forensics()` 与 `diag()` 都直接写 `chrome.storage.local` 且**不做任何打码**，而它们的产物**会进诊断包被一键导出**。"零裸 console"当时是全绿的。<br>⇒ **打码必须落在通道上，而不是靠调用点自觉**。落盘点（`storage.local.set` / `console.*` / `fetch` 的发包体）是**该有打码的地方**；调用点不是。<br>★ 找这类洞的方法是**枚举出口**（谁会写到进程外？），不是搜索已知的坏模式。<br>★ 凡是"安全靠约定"的地方，问一句：**这条约定如果被违反，谁会知道？** 答不上来 = 它是约定而不是机制。<br>判据：`node tools/verify/verify-forensics-redaction.mjs`（25 条，**真的把模块求值、真的调 `forensics()` 再读回落盘内容**）+ 反证 `verify-falsify-forensics.mjs`（3/3） |
| 22 | **"加日志"是三件事，缺一件就等于没加**：① 有出口、② **有人读**、③ **有用的那条活得到被读的时候**。<br>实测（`PITFALLS #14`）：打码全绿、零裸 console 全绿，但 `drain()` **零调用点**（日志只进 DevTools，**诊断包里一条都没有**），而 `diag()` 被一个**每次调用都会走到**的热路径占满（`ql:diag` 是**环形 60**、45 个写入点）。⇒ 病不是"日志少"，是**日志系统没闭环**。<br>★ **三通道分工是硬约定，不要混用**：<br>&nbsp;&nbsp;· `log.debug()` → 内存环形 200 + DevTools。**热路径**用它（默认 `info` 级 ⇒ 生产静默、零存储开销）<br>&nbsp;&nbsp;· `diag()` → `storage.local` 环形 **60**。**罕见但关键**：失败 / 降级 / 状态跃迁<br>&nbsp;&nbsp;· `forensics()` → `storage.local` 环形 **120**。**结构化事件**（可按字段过滤）<br>★ 判断"这条日志会不会挤掉别的"：看**它所在的控制流多久走一次**，不是看"它是不是写在一个重要函数里"。<br>判据：`verify-log-redaction.mjs` 第 6 节（闭环）+ 第 7 节（分工）+ 第 8 节（离线判定唯一）⇒ **121 条**；反证 **23/23**（拆 `drain`、拆 `appLogs`、热路径改回 `diag`、重复 `OfflineError`、拆 `dispatch` 的 `default`、契约加 kind、`log.error` 降级为 `debug`、裸传凭据、`${deviceCode}` 插值、孤儿 HTML id —— 各自变红） |
| 23 | **写"零命中"或"某函数里没有 X"这类判据时，先剥注释与字符串字面量**，并且**把范围按代码的真实控制流划**。<br>实测（`PITFALLS #14`，本仓第四次踩第一个坑）：我在代码旁写了"这里原先写的是 `diag(...)`"来解释降级，而裸正则命中了**那句注释**。历史：`urlTransform`（#1）、`RETURNING`（akso-vault #13）、`is_admin`（akso-vault #19）。规律：**"解释为什么不用 X"的文本必然包含 X**。<br>★★ 而**第二次假红推翻的是判据的「范围」**：我断言"整个 `isEnforceable` 里没有 `diag()`"，实证打印函数体后发现另外两处 `diag()` **每个 host 只走一次**（之后进缓存）、**根本不是热路径**。真正每次调用都走到的是**缓存命中那一支**。<br>⇒ 顺序：① **实证打印**你要断言的那段（别猜）；② 剥注释/字符串；③ 断言落到**那个具体分支**；④ 加一条**自证前提**的断言（"我确实取到了这段代码"）。<br>★ 剥离顺序：**先剥字符串再剥行注释** —— 否则 `'//'` 这类字面量会把后面的真代码当注释吃掉（反向失效更坏）。 |
| 24 | **`stripLiterals` 只能用于"怕被自己的解释性文字弄红"的断言；凡是要读「字符串字面量的内容」的断言必须用原始源码。** 并且**所有 `every` / `some` / `includes` 类判据都要先问"集合会不会是空的？"**<br>实测（`PITFALLS #16`）：我顺手用 `stripLiterals` 去读消息契约 —— 而 `kind: 'par.list'` 里的 **`'par.list'` 本身就是字符串字面量**，被剥成 `''` ⇒ 提取到 **0 个 kind** ⇒ `[].every(...)` **恒返回 `true`** ⇒ 那条"契约同步"判据**什么都没验**。<br>★ `@ts-expect-error` **也是注释** ⇒ 它同样要在原始源码里找。<br>★★ 这是本仓**第三次**"门禁退化成永远绿"（另见 #11 幽灵依赖、akso-vault #17），三次都是**为了让判据不被自己的注释弄红而引入的剥离，顺手把判据要读的东西也剥掉了**。<br>⇒ 三条措施：① 结构断言用剥过的源码、读字面量用原文（**分开**）；② 对"集合可能为空"的判据一律加 `check('判据前提：集合非空', size > 0)`，让"集合为空"与"契约不同步"在输出里**分得开**；③ 反证必须**真的加一个 kind**（`\| { kind: 'definitely.not.implemented' }`）⇒ 判据必须红 —— 别的反证都验不到这个形态。 |
| 25 | **加日志前先问"这条路径失败时，用户会看到什么？"** —— 如果答案是**"和成功一样"**，那它必须有 `warn`/`error`，**且不能是 `debug`**（`debug` 在生产默认不输出 ⇒ 等于没加）。<br>实测（`PITFALLS #17`）：`tab-rules.ts`（**网络平面**）有 4 条静默失败路径，而它们**全都和成功长得一样** ——<br>&nbsp;&nbsp;· AUTH 规则装不上 ⇒ 请求**不带正确 Bearer**<br>&nbsp;&nbsp;· COOKIE 规则装不上 ⇒ 既不回放也不剥离<br>&nbsp;&nbsp;· **两条都失败** ⇒ 页签**完全没有网络平面保护**，却**照样能打开平台**，只是**以错误的身份在跑**<br>&nbsp;&nbsp;· 移除规则失败 ⇒ **本该失效的旧规则继续生效**（表现是"切了账号还带着上一个账号的头"）<br>★ 判断依据：`meta.authId` / `meta.cookieId` 是否 `undefined` —— 它们**只在成功时才写入**，所以那个 `undefined` 就是"该装却没装上"的现成判据。<br>★★ 本轮我一度打算把"规则装上"也记成 `debug` —— 那是对的（**中频轨迹**）。但**失败若也走 `debug`，默认 `info` 级下生产一个字都不输出** ⇒ 我们"加了日志"而缺陷依然静默。**同一个日志调用，`debug` 与 `error` 的差别就是"没日志"与"有日志"。**<br>⇒ 一句话：**`debug` 记"发生了什么"；`warn`/`error` 记"失败了但看起来像成功"。**<br>判据：`verify-log-redaction.mjs` 第 10 节 ⇒ **121 条**；反证 **23/23**（把那行 `log.error` **降级为 `log.debug`** ⇒ 如期变红）。<br>★ 反证器的一个小坑：缺陷版必须让被断言的**字符串真的消失**。最初我写成"把 `log.error(` 拆成两半"，于是 marker 仍在源码里 ⇒ 判据不红 ⇒ 反证 `SKIP`（**验的是空气**）。另：锚点**不要带 `\n`**（行尾 CRLF，会匹配不上）。 |
| 26 | **白名单式判据（"这段里含安全痕迹就放过"）必须先问：那个痕迹**会不会来自别的对象**？** 会 ⇒ 范围划错了，要**逐个对象**判。<br>实测（`PITFALLS #18`，与 #23 同源、**第二次**出现）：我加了一条静态判据验"凭据值没被交给 `log()`"，实现是"**参数区**里若有凭据标识符，就必须同时有存在性判断的痕迹（`有`/`无`/`Boolean(`/`.length`）"。<br>它在真实代码上**通过**。而反证注入缺陷后 ——<br>&nbsp;&nbsp;`log.info('...', token, fernetKey ? '有' : '无', ...)` —— 判据**仍然绿**：那个**裸 `token`** 被**旁边 `fernetKey` 的 `'有'`** 一起放过了。反证器直接报 `FAIL 这条验收是空断言！`<br>⇒ 修法：安全形态只有四种，且必须**紧贴该标识符本身** —— `cred ? … : …`、`cred.length`、`cred.slice(`、`cred !== null`、`Boolean(cred)`；其余一律算出界。**逐标识符**判定，不看整段。<br>★ 这是 #23 那条教训的第二次：**范围划大了，判据就会在真实缺陷面前放行。** 第一次是 `isEnforceable`（我划成整个函数体，真实热路径只是缓存命中那一支）；这一次是日志参数（我划成整段，真实要逐个值看）。<br>★ 而**发现它的唯一方法是反证**：把缺陷真的注进去，看判据红不红。这一次反证不但发现了缺陷，还**否证了我自己的判据**。<br>判据：`verify-log-redaction.mjs` 第 11 节 ⇒ **121 条**；反证 **23/23**（裸传凭据 ⑩、`${deviceCode}` 插值 ⑪ 各自变红）。 |
| 27 | **删除一个 UI 功能的完成判据是「四处都没有它」：TS 引用 / HTML 标记 / CSS 规则 / 说明文字。**<br>实测（`PITFALLS #19`）：v3.18 废除本地数据源时 `renderSourceSwitch` 删干净了、`dataSource` **全仓零残留**（当时判据通过），但并行页上**还留着三样** ——<br>&nbsp;&nbsp;· `<div id="source-switch">` **空容器**（TS 零引用）<br>&nbsp;&nbsp;· 一整套**死 CSS**（`.source-switch` / `.source-opt` / `.source-busy`，约 40 行）<br>&nbsp;&nbsp;· ★★ **一段说明文字**，讲"本地 → 云端会**合并上传**、**本地数据不会被删除**、随时可以切回来" —— 而**这套功能已经不存在了**<br>★ 三处的**漏网方式各不相同**：`typecheck` 只管 TS（引用没了就绿）；HTML 多一个 `id` **不报错**，而规则 20 只查**反方向**；**死 CSS 不被任何门禁覆盖**；而**说明文字是字符串，没有任何机制检查它是否还在说真话** —— 它不是崩溃，是**对用户说谎**。<br>⇒ 判据：**HTML ↔ TS 双向一致性**（`verify-log-redaction.mjs` 第 12 节 ⇒ **121 条**）。`id="…"` 里除白名单外**都必须在 TS 源码里出现过**；白名单要写清"为什么它可以不被引用"。反证 **23/23**（重新放一个孤儿 id ⇒ 如期变红）。<br>★ 每次删 UI，去搜一遍那个功能**在人话里怎么被称呼**（"本地""云端""切换"），不只是搜它的标识符。<br>★ 实现坑（同一教训的**第三次**）：探针第一版直接对 HTML 跑 `\bid="([^"]+)"`，而我在清理时写了注释"原先有个 `<span id="auth-bar-text">`" ⇒ **正则命中了注释里的字面量** ⇒ 误报。必须**先剥 HTML 注释**（同 #23 / #26）。 |
| 28 | **文档审计的判据是「逐条分类」，不是「命中数」——"X 没同步"这句话本身需要判据；而报告里不要写不可复现的计数。**<br>实测（`PITFALLS #20`）：我在 §6.5 写下"三份文档**仍在描述** `credentials.ts` 与数据源切换"，本轮去执行时先量化 —— 三份文档**一批**命中，看去像"三份都烂了"。<br>★★ 而逐条读下来：**绝大多数是正确的历史留痕**（句子带"v3.18 已删"），**真正与现状相反的只有 7 处**。**如果按命中数去改，我会把大量正确的历史标注一起改掉** —— 而"已删除的东西也需要留痕"，改掉它等于让下一个人以为从来不存在。<br>★★★ **而我随后犯了同一个错的第二层**：我写了精确计数"命中 **15** 处……只有 **3** 处" —— **既不可复现、方法也不成立**：① 那是**编辑前**的测量（改完文件数字自然失效）；② 我为了分类写了个**关键词分类器**，实测它在 25 处命中上把 **19 处判成"现状陈述"，其中绝大部分是误报**（"这段讲的是**旧格式**"、"这些**全部删除**"、我新加的解释块…）。<br>⇒ ★★ **关键词分类器判不出"这句话是否在说谎"** —— 判据是**语义**的（这句是现状还是史料），不是词面的。**这个任务没有便宜的机械化判据，只能逐条读。**<br>⇒ **判据**：<br>&nbsp;&nbsp;· **历史留痕** —— 句子里有"已删 / 已废除 / 历史上 / vX.Y 起"等**时间标记** ⇒ **不要动**；<br>&nbsp;&nbsp;· **现状陈述** —— 用**一般现在时**描述当前行为（"账号密码 AES-GCM 加密存于本机"）⇒ **必须改**。<br>&nbsp;&nbsp;· ★★ **报告里禁止写"N 处"除非能给出可复现的判据** —— 写不出来就**逐条列举**。**一个不可复现的计数比不给数字更坏**：它看起来是测量结果，实际是印象。<br>★ 辅助判据（更快）：那句命中**所在的小节是不是自称现状**？本例真缺陷里两处正是在「**现状快照**」标题下与「**Summary**」里 —— **"自称现状"的文档里出现已废除的行为 = 确定的缺陷**，不必再判语气。<br>★ 另一半：**锚定式文档必须标锚点**。`docs/CODEBASE_OVERVIEW.md` 是**快照**（架构，允许滞后，已标 `1e61985`／当前差 20 个 commit），`AGENTS.md` 是**活文档**（规则，改了必须同步）。两者维护义务不同，**混读就会把过时的行号当精确定位**。<br>★ 写"某文件已删除"这类断言时**当场实测一次**：本轮验了 5 个"已删除"的文件确实不存在、3 个"新增"的确实存在（`git ls-files` 也对上）。<br>★★ 这是"**『解释为什么删掉 X』的文本必然包含 X**"这条规律的**第四次**变体（前三次：#1 `urlTransform`、#14 `diag(`、#19 注释里的 `id=`）—— 而这次它以**文档审计**的形态出现。 |
| 29 | **日志覆盖面的判据是「静默失败」的条数，不是「有 logger 的文件数」——而"哪个 catch 必须留痕"要**逐条白名单**，不能机械扫。**<br>实测（`PITFALLS #21`）：测覆盖面时我先量的是"有 `getLogger` 的文件"（**8/35**）—— 那是**行数指标，不是有效性指标**。真正的指标是 **静默 catch 103 处**（吞掉异常且不记录）。<br>★★ 而 103 处里**绝大多数是有意的静默**：存储命名空间清扫、单键回滚、CacheStorage 封控、"读失败不阻断写入"…它们的共同点是"**一条失败不阻断其余**"，且跑在**热路径**上（每个页面每次存储操作）⇒ 给它们加 `diag/error` 会挤爆 `ql:diag` 环形 **60**，把真正重要的记录挤掉（规则 22）。<br>★★★ **所以"哪个 catch 必须留痕"不能机械化**（与规则 28 同源：语义判断没有便宜的判据）⇒ 用**显式白名单**，每条写明"**失败时用户看到什么**"，只有答案是"和成功一样"的才进来。本轮收了 **3 条**，其中一条**对用户说谎**：<br>&nbsp;&nbsp;· `account-cache.loadSnapshot` 读缓存抛错 ⇒ 静默 `null` ⇒ 离线时列表是空的，**与"从未同步过"长得一样**<br>&nbsp;&nbsp;· ★ `favorites.listFavorites` 读 storage 失败 ⇒ 回落 `DEFAULT_FAVORITES` ⇒ **用户自建的收藏整份消失，界面上显示的是默认书签**（用户以为扩展改了他的数据）<br>&nbsp;&nbsp;· `site-auth.probeScheme` 两个探测都失败 ⇒ 静默按 https 兜底 ⇒ 用户只看到"页签打开后一片错误页"<br>⇒ 判据：`verify-log-redaction.mjs` **第 13 节**（⇒ **121 条**）+ 反证 **23/23**。<br>★ 实现要点一：断言必须落在 **catch 块内部** —— 只查"函数体里有 log"会被函数里**别处**的 log 弄成假绿。<br>★★ 实现要点二：**承认两种形态**。第一版只写"catch 里要有 log"，于是对 `probeScheme` **假红** —— 它**根本没有 catch**（异常在 `probeOnce` 里被吞成 `false`，`probeScheme` 只看到"都没探到"）。⇒ 判据分 `kind: 'catch'` 与 `kind: 'fallback'` 两种，**先确认形态再选判据**（把不适用的形态硬套一个判据，就会得到 `[].every()` 那种恒真/恒假，见规则 24）。<br>★ 实现要点三：反证的缺陷版必须让被断言的**字符串真的消失**（拆成两半会让 marker 仍在 ⇒ 反证 SKIP）。<br>★ 顺带修掉一处**不对称**：`parallel-store.persistSnapshot` 的写失败**早就**记了 `log.error`，而 `account-cache.loadSnapshot` 的读失败一声不响 —— 镜像的两条路径，只有一条有留痕。 |
| 30 | **"接口/机制摆在那里"≠"它被接上了" —— 每条注入点都要问「谁调它」，而判据必须盯「那个调用」，不是「文件里出现过那个 token」。**<br>实测（`PITFALLS #22`）：`shared/log.ts` 早就提供了 `setSink()`（可选落盘注入点），而它**全仓零调用**。后果：环形缓冲只在 **SW 的内存里**，而 **MV3 空闲会回收 SW** ⇒ 用户**事后**导出诊断包时环常常已经空了 —— **最需要日志的时刻日志已经没了**。<br>★ 为什么之前的判据发现不了：判据一直是"`drain()` 有没有调用点"（规则 22 那条，当时确实是零调用点，已修）。修好之后它**有**调用点了 ⇒ **那条判据变绿**，而"**读得到吗**"从来没被问到。<br>★★ 这是规则 21 的**镜像**：那条说"安全靠约定时要问『违反了谁会知道』"；这里是"**机制摆在那里时要问『它真的被接上了吗』**"。与 v3.19 修掉的 `.side-collapsed` 同型（样式齐备、没人接线）。<br>⇒ 处置：`setSink()`（写出去）+ **新增 `restoreToRing()`**（读回来）在 SW 模块级接线，落盘键 `LOCAL_KEYS.logPersist`，攒 10 条或 800ms 批写。<br>★★★ **而判据设计本身踩了两次，两次都值得记**：<br>&nbsp;&nbsp;① **第一版写"文件里有没有 `setSink(` 调用"** ⇒ 通过。而把 `installLogPersist();` 注释掉后**判据仍然全绿** —— 因为 `setSink((r) => {…})` 就在 `installLogPersist` 的**函数体内部**，"文件里出现过 `setSink(`"在**函数定义**处就已满足，与"有没有调用它"无关。反证器直接报 `FAIL 缺陷版下仍然绿 ⇒ 这条验收是空断言！`<br>&nbsp;&nbsp;⇒ 判据必须盯**模块级的那个调用**（`/^installLogPersist\(\);$/m`），不是"某处出现过某个 token"。<br>&nbsp;&nbsp;② **反证撞了两次"锚点"的坑**：`installLogPersist();\nvoid replayLogPersist();` 这种**带 `\n` 的多行锚点没匹配上** ⇒ 文件没被改 ⇒ 判据当然绿 ⇒ 又报"空断言"。**规则 25 早就记过"锚点不要带 `\n`"** —— 这是它第二次咬人。<br>★ 顺带：一条**已有的判据**因为我在文件顶部插了新的顶层代码而假红 —— 它用 `/async function dispatch\(…\)[\s\S]*?\n  \}\n\}/` **靠缩进猜函数收尾**。⇒ 锚点应依赖**这段代码自己的内容**（如那句独特的 `fail(`），不依赖缩进/边界。<br>★ 反证器的**还原核对自检**又抓到一次疏漏（新文件没进 `COVERED`）。<br>判据：`verify-log-redaction.mjs` **第 14 节**（⇒ **121 条**）+ 反证 **23/23**（⑯ 注释掉安装调用 / ⑰ 拆回灌 / ⑱ 让 `restoreToRing` 喂回 sink ⇒ 各自变红）。 |
| 31 | **"产物对"不能推出"源对" —— 每组「源 → 产物」都要问：源在仓库里吗 / 源与产物一致吗 / 有判据能识破源被换掉吗？**<br>实测（`PITFALLS #23`）：审计【两端图标】时产物**全对**（128/48 是源的 **LANCZOS 直缩、逐像素全等**；32/16 **有意**手调；两端 4 档**逐字节相同**；`manifest` 声明齐全）。<br>★★ 而往回查"源在哪"时发现：**仓库里被跟踪的"图标源"没有一个是真 logo** ——<br>&nbsp;&nbsp;· `assets/src-icon.svg` / `src-icon512.svg` 是**另一个设计的占位图**（圆角渐变方块 + 三段圆弧，`#2E7BFF`/`#7CE0C3`/`#FFD166`，**不含任何品牌色**）<br>&nbsp;&nbsp;· `src-icon-master.png` / `src-icon512.png` 与它们**同源**（也是占位图）<br>&nbsp;&nbsp;· 真 logo（422×422 蓝 `A` + 橘 `W` + **®**）**根本不在仓库里**，只在工作区 `tmp/icons/`<br>★ 危险不是"多了几个文件"：它们**零引用**（`manifest` 只引 4 个 `Icon*.png`）却因 `build.mjs` 的 `cpSync(assets → dist/assets, recursive)` **全被打进 dist**；★★ 更坏的是**下一个人会以为那是源** —— 拿它重渲染得到一个**完全不同的图标**，而全过程"看起来就是从源生成的"。<br>★ 为什么所有门禁都绿：`akso-vault` 侧的 favicon 判据管住了 **404 坏引用**与**非方形**，但管不住"**这张方形图画的是什么**"。<br>⇒ 处置：真 logo 入库为 `assets/logo-master-422.png`（唯一权威源）；删掉那 5 个假源；**新增 `tools/verify/verify-icons.mjs`（39 条）** + 反证（**4/4**）。<br>★★ **判据要盯「这个东西区别于冒牌货的那个性质」**，而不是"它存在" —— 本例是"**源必须同时含品牌蓝与强调橘**"，那正是占位图不具备的。<br>★ 另外两条有价值的判据：① 大档的不透明覆盖率与源相近（把"确实来自这个源"钉死）；② ★ **小档覆盖率必须与大档不同** —— 断言"它们**有意**不是简单缩放"，防止有人"顺手统一成缩放"而毁掉 16px 可读性（16px 上 ® 只有 1–2px）。<br>★ 还有一条**运行时**判据：manifest 里的相对路径要在**它真正被解析的位置**（`dist/`）存在 —— `build.mjs` 若忘了拷 assets，图标全裂而 `chrome://extensions` 只报"找不到文件"。<br>★★★ **没写生成脚本是刻意的**：32/16 的算法我试了三种模型都**复现不出来**。写一个"复现不出来"的生成器是**假的可复现性**（它会让人以为产出可重建），比不写更坏 ⇒ 如实记下"大档可复现、小档是手工挑选"。<br>★ 实现坑：仓库**没有任何 PNG 解码依赖**，为它新加一个正是**幽灵依赖**的入口（规则 14）⇒ 用 Node 内置 `zlib` **手写最小解码器**（只支持 8-bit 非隔行 RGBA/RGB，遇别的形态**明确抛错**而不是给错像素）。<br>★ 又一次"**我『知道』某件事该在哪，并据此写判据**"：我以为 ® 在**右下**，只扫右下 35% ⇒ 报"没找到"（实际在**右上**）。**先看图再写判据**（规则 23）。 |
| 32 | **"工具不可用"会伪装成"没人用" —— 看到一个环境里某项实践**系统性缺失**时，先查"那件事在那个环境里能不能做成"，再查"要不要做"。**<br>实测（`PITFALLS #24`）：三个环境的日志覆盖面差得**有规律**，而不是零散遗漏 ——<br>&nbsp;&nbsp;· `background/`（SW）13 个文件，**9 个有 logger**<br>&nbsp;&nbsp;· `content/` 7 个文件，**1 个有**（静默 catch 30）<br>&nbsp;&nbsp;· `ui/` 9 个文件，**0 个有**（静默 catch 22）<br>★★ 根因不是"勤快程度"，而是**通道可达性**：`log()` 的环形缓冲与 `setSink()` 的落盘**都在 SW 里**，而 content script 与扩展页面**各有自己的 JS 环境** ⇒ 它们记的日志**永远进不了诊断包**。**在那里加日志是白加 ⇒ 于是没人加。**<br>★ 这是 `PITFALLS #22`（`setSink()` 从没被调用）的**同一形态第二处**：机制只接到了 SW 这一端。而 #22 修完后**判据变绿了**，"其他环境够得到吗"**又一次**没被问到。<br>⇒ 处置：新增 `setForwarder()` + **`getForwardingLogger()`**（`log.ts`），契约加 `ql.log`，SW 侧 `restoreToRing(records.slice(0,50))` **入同一个环**并额外落一条 `forensics`；`parallel.ts` 模块级接线 + 三条静默失败补留痕。<br>★ 四个刻意设计：① 转发器用**注入**而非 import 消息类型（否则 `shared/log.ts` 会依赖业务契约 —— **耦合方向反了**，而且注入可测）；② `getForwardingLogger` **不改变本环境行为**（SW 不可达时 DevTools 照样看得到 —— 转发是**增强**不是替代）；③ **转发前再打一次码**（进通道的文本必须已打码是**通道级**约定，不靠调用点自觉 —— 规则 21 的思路）；④ `sendSafe` 用 **`debug`** 而非 `warn`（它是**正常路径之一**，SW 冷启必然发生几次 ⇒ `warn` 会挤掉环形 60 里的真失败，规则 22），并在 SW 侧用 `forensics` 兜住"排障时才发现"的缺口。<br>判据：`verify-log-redaction.mjs` **第 15 节**（⇒ **121 条**）+ 反证 **23/23**。★ 第 15 节与第 14 节的分工：14 管"**SW 自己**的日志有没有落盘"，15 管"**别的环境的**日志有没有到 SW"。 |

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

# 打码通道 + 闭环：**四个**脚本，秒级，都**不需要浏览器**
node tools/verify/verify-log-redaction.mjs           # 日志通道（**121 条**）
node tools/verify/verify-falsify-logredaction.mjs    # ↑ 的反证（**23/23**）
node tools/verify/verify-forensics-redaction.mjs     # 取证/诊断通道（25 条）
node tools/verify/verify-falsify-forensics.mjs       # ↑ 的反证（3/3）

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
  ★ 本仓 **2026-10-09 起有 `docs/PITFALLS.md` 了**（当前 **24 条**）——在此之前这类教训
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

## 6. 本地数据源已废除（v3.18，2026-10-09 完成）

**用户决定：彻底废除扩展端的本地账号保存，强制登录云端账号。**
本节保留**侦察结论与踩过的坑** —— 下次改这块周边时仍会需要它们。

### 6.1 结果

| 维度 | 结果 |
|---|---|
| 数据源 | **只剩云端**。`dataSource` / `getDataSource` / `setDataSource` / `DataSource` **全仓零残留** |
| 删除的文件 | `core/credentials.ts`（本地 AES-GCM 凭据）、`core/cloud-migrate.ts`（本地→云端合并）、`core/navigation.ts` + `core/session-manager.ts` + `core/account-registry.ts`（**旧 Session 模型三者**） |
| 新增的文件 | `core/account-cache.ts`（只读快照缓存）、`core/offline.ts`（`OfflineError`）、`core/auto-login-cache.ts`（待登录凭据的临时缓存，从 `navigation.ts` 摘出） |
| 消息 | 删 `session.*`（5 个）、`cloud.migrate`、`cloud.source.set`；`CloudState` 去掉 `source` |
| 类型 | 删 `Session`、`EncryptedCredentials`、`ParallelAccount.credentials`、`updateCredentials`（**实测无调用点**） |
| 规模 | 12 个文件，**−796 / +164 行** |

**保留**：云端会话、设备流（RFC 8628）、以及**离线时的只读列表缓存**
（不含口令；可看、可开页签；**不可新增/编辑，填表失效**）。

### 6.2 ★ `session.*` 曾经"看起来是死代码" —— 这个排查值得复述

第一眼它像遗留物：5 个消息 + `sessionManager` + `db.sessions`，
而 **UI 一处都不发**（实测 UI 只发 `par.*`）。
但 `navigation.switchAccount(session, …)` 收的是 `Session`，`accountRegistry`
用 `sessionManager.get(sessionId)` 取**标签页标题** ⇒ 两个模型**交叉**。

**实测结论（与第一眼相反）**：`parallel-session.ts` **完全不 import**
`navigation` / `session-manager` / `accountRegistry` —— 它有自己的一套
（`applyTitle` / `SESSION_KEYS.parTabBindings` / `resolveAccountPlaintext`）。
⇒ 旧模型只服务那 5 个死消息，**可以整体删除**。

★ 教训：**"看起来像死代码"与"是死代码"必须分开验证。**
判据是"**谁真的 import 它**"，不是"谁看起来用得上它"。

### 6.3 ★★ 本轮最贵的一次教训：一条正则吞掉了相邻的功能块（→ 规则 18）

删"数据源按钮的 UI 状态块"时，我用了一条跨多行正则，它**吞掉了紧邻的设备流代码**
（`deviceCancelBtn` / `deviceRetryBtn` / `deviceUserCodeOpen` 的监听，
以及 `openApprovalTab` 函数与 `deviceApprovalUrl` 变量）。

**为什么危险**：

- 合成出的文件**语法完全合法**，`tsc` 与 `npm run build` **都通过**；
- 唯一的信号是 **"`deviceUserCodeOpen` 声明但未使用"** ——
  那读起来像"清理未用变量"，实际是**功能被删掉了**。

**判据（已写进规则 18）**：删代码后必须**与 HEAD 逐行对照**，列出
"HEAD 有、现在没有"的行，并**逐条确认它们在删除清单里**。
**typecheck 绿不是判据** —— 它只说明"剩下的代码自洽"。

### 6.4 导出/导入已降级为"只含元数据"

旧备份带 `cryptoSeed` + 每账号 AES-GCM `credentials`，导入时现场解密。
本地凭据存储废除后**那份密文再也解不开**（我们刻意让它如此）。
⇒ 新格式只带**配置**（站点 / 标题 / 盒子 / 用户名），导入时口令为空。
**旧备份文件的口令部分不可恢复** —— 这是设计取舍，已写在类型注释里。

### 6.5 已知未做（下一步）

- **文档同步**：★ **v3.19（2026-10-09）已做** ——
  按关键词量化出**一批**命中，但**绝大多数本来就是正确的**（都带"v3.18 已删"标注）；
  真正**与现状相反**的逐条列在下面那张表里（**以那张表为准，不要引用"命中 N 处"**）。

  | # | 文档 | 问题 | 处置 |
  |---|---|---|---|
  | ① | `docs/CODEBASE_OVERVIEW.md:18` | Summary 里写「账号密码 **AES-GCM 加密存于本机 IndexedDB**」——**该功能已废除** | 改成"账号存云端、本机只留不含口令的只读副本"，并加一段说明 |
  | ② | `AGENTS.md` 本节（原第 262-264 行） | 声称上述三份文档"仍在描述 `credentials.ts` 与数据源切换" | 就是你现在读到的这段 |
  | ③ | `docs/PROJECT-STATUS.md:14` | 小标题「**四平面**隔离」而**表内自己就有 6 行**（实际七个，缺平面 1.5） | 改成指向权威源 + 说明这是历史对照 |
  | ④ | `docs/PROJECT-STATUS.md` 文件表 | 仍把 `credentials.ts` 列为**当前**文件 | 加删除线 + "v3.18 已删除" |
  | ⑤ | `docs/PROJECT-STATUS.md:1` | 标题「**现状快照**（v3.9.2）」——落后 8 个中版本 | 加时效警告；**保留旧版本号不改**（改成当前会让它"看起来新、实际只有一半新"） |
  | ⑥ | `packages/extension/docs/DESIGN.md` §2 | 决策表**三条已被推翻**（账号能力 / 持久化 / 凭证安全）却无标记 | 加「当时 → 现在」逐行对照 |
  | ⑦ | `packages/extension/docs/DESIGN.md` 横幅 | 「六平面（v3.7.2）」 | 改成**七个**（新增平面 1.5） |

  ★★ **修正我这句原话（两次）**：

  1. 我写的"**仍在描述** `credentials.ts` 与数据源切换"是**没核实的概括**。
     实际核对下来，`CODEBASE_OVERVIEW.md` 有 **63 处** `文件:行号` 引用，
     而它的 `credentials` 命中里**大部分都带"v3.18 已删"标注** —— 它维护得不错。
  2. ★ 我随后又在本文里写了"实测命中共 **15** 处……真正与现状相反的只有 **3** 处" ——
     **那个数字也不可复现**：它是**编辑前**的测量（改完文件数字自然失效），
     而且我为了"分类"写了个关键词分类器，**实测它在 25 处上把 19 处判成了"现状陈述"
     —— 其中绝大多数是误报**（比如"这段讲的是**旧格式**"、以及"这些**全部删除**"那种句子）。
     ⇒ **关键词分类器判不出"这句话是否在说谎"**，因为判据是**语义**的，不是词面的。
     ⇒ 已改成**逐条列出那 7 条**（可核对、可复现），**删掉所有"N 处"的计数**。

  ⇒ **"文档没同步"这句话本身也要有判据**（逐条看那句话是"现状陈述"还是"历史留痕"），
  否则会变成一次没有依据的指责，而**改掉对的注释**比不改更坏（规则 12）。

  ★ 另外加了一条**时效说明**在 `CODEBASE_OVERVIEW.md` 顶部：
  它锚定 `1e61985`，而当前 HEAD 已在其后 **20 个 commit / 4 个中版本**
  （v3.13.2 → **v3.17.1**），**全文 63 处行号不可当作精确定位**。
  ⇒ 本仓的分工：**`AGENTS.md` 是活文档**（规则，改了就得同步），
  **`CODEBASE_OVERVIEW.md` 是锚定式快照**（架构，允许滞后，但必须标锚点）。

- **UI 实机验证**：`src/ui/**` 无自动化覆盖 ⇒ 必须在 `chrome://extensions`
  **重新加载**后手工点一遍（登录 / 列表 / 开页签 / 盒子 / 设备流 / 离线降级）。
- **离线只读缓存的界面层**：★ **v3.19（2026-10-09）已完成** ——
  新增 `par.offline` 消息，`#cloud-banner` 的 `warn` 分支会明说
  "这是 **N 分钟前同步的只读副本**，可以看、可以打开页签，
  但不能新增/编辑，自动填表也不生效"。
  ★ 判据从"快照年龄"启发式改成了**发生地记账**（`lastListFellBack`）——
  年龄猜不准（刚断网时猜不到；长期没打开而网络正常时会误报），
  而 `listWithFallback()` **确实知道**自己走了哪一支。
  ★ 同时清掉了这块周边**已废除功能的三处残留**（见 `docs/PITFALLS.md` #19）：
  空的 `#source-switch` 容器、整套死 CSS、以及**一段讲"本地→云端合并上传"的说明文字**
  （那段字已经与行为相反 —— 它对用户说谎）。

---

_本文件遵循 [AGENTS.md](https://agents.md) 约定：仓库根目录的 `AGENTS.md` 就是 AI 协作者的规则入口
——短、规则形状、可执行。如果你发现自己需要在这里加"背景介绍"，那说明它该去
`README.md` 或 `docs/USER-MANUAL.md`。_
