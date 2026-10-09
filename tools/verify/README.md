# tools/verify —— 验证脚本索引

> **这些脚本曾经不存在于版本控制里。**
> 2026-10 之前它们放在 `tmp/`（被 `.gitignore` 忽略，`git ls-files tmp/` = 0），
> 且依赖 `playwright-core` 却**没有在 `package.json` 里声明**——
> 只因为本机 `node_modules/` 里有一次 `npm install --no-save` 的残留才能运行。
> ⇒ **换一台机器、新 clone、CI，一个都跑不起来，而且不报"缺依赖"，只在运行时 `ERR_MODULE_NOT_FOUND`。**
>
> 同样的损失此前已经发生过一次：`tools/e2e/` 一整套（`harness.mjs` / `peek.mjs` /
> `analyze-events.mjs` 等）在"收束清理"中被删除（`git show <删除前提交>:tools/e2e/…` 可取回）。

## 运行前提

```powershell
npm ci            # 依赖现在已显式声明（含 playwright-core）
npm run build     # 必须先构建：脚本从 dist/manifest.json 读 key 来算扩展 ID
npm run verify    # 逐个跑本目录下所有脚本
```

★ **`npm run build` 是硬前提**：每个脚本都做
`JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'manifest.json')))`，
用 manifest 的 `key` 反推稳定扩展 ID（`sha256(Base64(key))` 前 32 位十六进制 → 映射成 a–p）。
没有 `dist/` 会直接抛错。

★ **但有两个脚本不需要浏览器**，可以直接单独跑（**秒级**，适合放进日常动手前的自检）：

```powershell
node tools/verify/verify-log-redaction.mjs          # 日志打码验收：37 条
node tools/verify/verify-falsify-logredaction.mjs   # 上一条的反证：3/3
```

`run-all.mjs` 只收 `verify-*.mjs` 前缀，所以这两个也在 `npm run verify` 的清单里
（会跟着起一次 Chromium —— 它们自己不用，但编排器统一要求 `--browser`）。
**正因为编排器要起浏览器，所以它们必须能单独跑**：日志打码是改动前就该跑的自检，
不该为了它等几分钟。

★ **脚本会在 `tmp/` 下读写**：Chrome 档案（`tmp/ui-*`）、截图、回归事件流。
`tmp/` 仍是 gitignored（**刻意如此**——里面是浏览器运行时状态，不是源码）。
**规则是：脚本入库，运行产物不入库。**

## 目录结构

| 路径 | 内容 | 何时跑 |
|---|---|---|
| `verify-*.mjs` | **22 个回归用例**（`(Get-ChildItem tools/verify/verify-*.mjs).Count` 实测）。每个脚本自带断言，输出 `✔/✖` 与 `N/M` 汇总（★ 数量以本表为准，别在别处再抄一份） | 改动 `packages/extension/src/**` 后 |
| `probe-create.mjs` | **诊断探针**（不是断言用例）：打印扩展创建页签时的实际状态，用于排障 | 排查"页签没建起来"类问题时 |
| `baseline/*-out.txt` | **历史输出基线**（从 `tmp/` 归档）。用于对照"这次运行与上次是否一致" | 回归出现差异时人工比对 |
| `../e2e-records/vpn-experience-*.mjs` | **4 个真机联调记录**。依赖真实 VPN + `10.100.0.105` 环境，**不参与常规回归** | 只有在那个内网环境里才跑 |

## 回归用例

| 脚本 | 覆盖 | 历史结果 | 需要浏览器 |
|---|---|---|---|
| `verify-v310.mjs` | 平面 1.5 广播隔离 / 轮盘盒分组 / 默认盒禁用 / 导出导入 | 10/10 | ✔ |
| `verify-impgrant.mjs` | 导入时的授权失败路径（未授权·已暂停 / 明确告警 / 状态如实） | 3/3 | ✔ |
| `verify-jarhygiene.mjs` | 会话卫生三层防线（preJar 基线 / 快照差集清扫 / onChanged 驱逐） | 5/5 | ✔ |
| `verify-defect.mjs` | 身份叛逃处置（继承 / 重载 / 解绑 / 快照护栏 / 命名空间回滚 / 治愈） | 8/8 | ✔ |
| `verify-autologin.mjs` | 自愈式提交（首击被吞后重试 ≤4 次 / 提交时值完整 / 用户键入即让位） | 5/5 | ✔ |
| `verify-dynsnap.mjs` | 快照动态化（登录后票据实时进回放 / 轮换 / 作废移除 / 袋回流） | 6/6 | ✔ |
| `verify-fillrhythm.mjs` | 填充节奏五重门控（iframe 延迟挂载 / 拒绝后重填 / 让位 / 停止重试） | 9/9 | ✔ |
| `verify-httpscheme.mjs` | scheme 数据化（纯 http 站点探测翻转 / https 不误伤） | 10/10 | ✔ |
| `verify-adopt.mjs` | opener 亲子继承（同站继承 / 异域解绑 / 手动不继承 / 原页签保持） | 5/5 | ✔ |
| `verify-boxmgmt.mjs` | 盒子管理（重命名 / 删除两步确认 / 冷启保持） | — | ✔ |
| `verify-defbox.mjs` | 默认盒重命名 / 新账号归属 / 冷启 | — | ✔ |
| `verify-track.mjs` | 录制埋点 | — | ✔ |
| **`verify-log-redaction.mjs`** | **日志打码通道（15 节）**：该打掉的 / 不该打掉的 / `log()` 端到端（含**对象直传**与**分隔参数**）/ 结构性扫裸 `console` / 闭环 / 三通道分工 / 离线判定唯一 / SW 入口不静默落空 / 网络平面失败可见 / 凭据不进日志调用 / DOM 双向一致性 / 静默失败白名单 / **SW 侧落盘接线** / **跨环境转发** | **121/121** | ✘ |
| **`verify-falsify-logredaction.mjs`** | **上一条的反证（23 条）**：拆 `drain` / 拆 `appLogs` / 热路径改回 `diag` / 重复 `OfflineError` / 拆 `dispatch` 的 `default` / 契约加 kind / `log.error` 降级为 `debug` / 裸传凭据 / `${deviceCode}` 插值 / 孤儿 HTML id / 注释掉 `installLogPersist()` / 拆回灌 / `restoreToRing` 喂回 sink / 拆 `setForwarder` / `ql.log` 不入环 / 转发前不打码 / `sendSafe` 又变静默 ⇒ 各自变红 | **23/23** | ✘ |
| **`verify-forensics-redaction.mjs`** | **取证 / 诊断通道的打码**（`forensics()` / `diag()` 写入 `chrome.storage.local`，而它们**会进诊断包被一键导出**）—— **真的把模块求值、真的调 `forensics()` 再读回落盘内容** | **25/25** | ✘ |
| **`verify-falsify-forensics.mjs`** | **上一条的反证**：`forensics` 不打码 / `diag` 不打码 / 敏感键名单只剩裸 `password` ⇒ 必须变红 | **3/3** | ✘ |
| **`verify-icons.mjs`** | **图标源与派生产物**：源在且**同时含品牌蓝与强调橘**（占位图不具备该性质）/ 4 档方形且含两色 / 大档覆盖率与源相近 / ★ **小档覆盖率必须与大档不同**（有意手调）/ 假源 `src-icon*` 不存在 / manifest 声明的路径在 **`dist/`** 下存在 | **39/39** | ✘ |
| **`verify-falsify-icons.mjs`** | **上一条的反证**：换占位源 / Icon16 弄成 16×9 / 抹掉小档手调 / 放回假源 ⇒ 各自变红 | **4/4** | ✘ |
| **`verify-user-docs.mjs`** | **用户可见的功能描述必须与代码一致**：`USER-MANUAL.md` 里"数据在哪 / 备份含什么"不得与代码相反、**真相必须被明说**、`manifest.description` 不声称本地加密 | **7/7** | ✘ |
| **`verify-falsify-userdocs.mjs`** | **上一条的反证**：把修复前那**五处原文**逐条注回去 ⇒ 各自变红（缺陷版用真句，不是我编的近似句） | **5/5** | ✘ |
| **`verify-load.mjs`** | ★ **装载冒烟**（本篇唯一**需要浏览器**的那条）：真起 Chromium + `--load-extension`，验 ① 扩展被装载 ② 产物齐全性（**能取的从页面内 `fetch`、不能取的查磁盘**）③ 三个自有页面能开且无未捕获错误 ④ ★ **SW 真的活着**（能应答 `ql.diag` 且回了 `logs` 数组）⑤ 无致命错误。<br>★ 它**不验**登录 / 列表 / 开页签 / 盒子 / 设备流 / 离线降级 —— 那些要真实云端账号 + 真实内网平台，**必须人工走**（B7 的剩余部分），本脚本**不冒充**那部分覆盖 | **17/17** | ✔ |
| **`verify-css-vars.mjs`** | ★ **CSS 变量卫生**（静态、秒级，**两个方向都查**）：逐页面按**真实 CSS 依赖链**（`<link rel=stylesheet>` + 递归 `@import`）解析，断言 ① 无「`var()` 无 fallback 又解析不到」（那会让**整条声明被丢弃**）② ★ **反方向**：定义的变量都有人用 ③ 无**自引用** `--x: var(--x)`（等于未定义）。<br>★★ 起因：`wheel.css` 里品牌蓝 `#1e6fff` 散在 **12 处**（8 处 fallback + 4 处裸硬编码），而 `theme.css` 定义了一次 ⇒ **同一个颜色 13 处，改一处必漂**；我整理时又用全局替换把 `:root` 里**那一行自己的值**也换掉，造出 `--acc: var(--acc)`。<br>★ 而"截图逐字节相同"**没能发现它**（轮盘需有账号才渲染）⇒ **这类缺陷只能静态查，不能靠截图**。<br>★★ **② 的"使用者"范围必须按全目录算**：我第一版探针**把 `theme.css` 排除在"使用者"之外** ⇒ 把 `--sb-brand-hover` / `--sb-bg`（**只在 theme.css 自己的第 36/48/56 行被用**）报成死变量 —— **两个假缺陷**。 | **19/19** | ✘ |

★ 上面**八个**是 **2026-10-09 新增 / 扩充**的（`PITFALLS #3`~`#5`、`#12`~`#18`、`#22`~`#25`）；
★ `verify-load.mjs` 是**同日晚些**新增的（`PITFALLS #27`），
**唯一需要真起浏览器**的那条 —— 因为它验的正是"**manifest 合法 ≠ Chrome 装得上**"。
它们的形态与其余脚本不同：**不启动浏览器、秒级**——打码、图标像素、文档文本都是纯静态对象，
用浏览器验只会让"改一行就要等几十秒"。

★ **本表里"20 个"与上面各条的 `N/M` 是活数字** —— 加脚本或加检查项时**同步改这里**。
（此前本表长期写着 `14 个` / `37/37` / `3/3`，而实际是 `20 个` / `121` / `23` ——
**一个没人会去核对的数字，会安静地过期好几个月**。
★ 而我自己在改这一行时**又写错一次**（凭数数写了 `19`，实测 `20`）——
所以这一行现在**直接给出可跑的判据**，而不是一个裸数字。）

## 写新验证脚本的四条规矩

从 `tmp/` 这次退化里总结出来的，加脚本时照做：

1. **必须放在被跟踪的 `tools/` 下**，不要放 `tmp/`。
2. **依赖必须写进 `package.json`**（`tools/check_deps.mjs` 会机检这件事）。
3. **根路径用 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')`**
   —— 本目录深度是两层，写一层会**静默**指向 `tools/` 并去找 `tools/dist/manifest.json`。
4. **断言必须能红**：写完先问"拆掉什么它才会红"，答不上来说明它没在验任何东西
   （同 `akso-mogul` 的 PITFALLS #119）。
