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

★ **脚本会在 `tmp/` 下读写**：Chrome 档案（`tmp/ui-*`）、截图、回归事件流。
`tmp/` 仍是 gitignored（**刻意如此**——里面是浏览器运行时状态，不是源码）。
**规则是：脚本入库，运行产物不入库。**

## 目录结构

| 路径 | 内容 | 何时跑 |
|---|---|---|
| `verify-*.mjs` | **12 个回归用例**。每个脚本自带断言，输出 `✔/✖` 与 `N/M` 汇总 | 改动 `packages/extension/src/**` 后 |
| `probe-create.mjs` | **诊断探针**（不是断言用例）：打印扩展创建页签时的实际状态，用于排障 | 排查"页签没建起来"类问题时 |
| `baseline/*-out.txt` | **12 份历史输出基线**（从 `tmp/` 归档）。用于对照"这次运行与上次是否一致" | 回归出现差异时人工比对 |
| `../e2e-records/vpn-experience-*.mjs` | **4 个真机联调记录**。依赖真实 VPN + `10.100.0.105` 环境，**不参与常规回归** | 只有在那个内网环境里才跑 |

## 12 个回归用例

| 脚本 | 覆盖 | 历史结果 |
|---|---|---|
| `verify-v310.mjs` | 平面 1.5 广播隔离 / 轮盘盒分组 / 默认盒禁用 / 导出导入 | 10/10 |
| `verify-impgrant.mjs` | 导入时的授权失败路径（未授权·已暂停 / 明确告警 / 状态如实） | 3/3 |
| `verify-jarhygiene.mjs` | 会话卫生三层防线（preJar 基线 / 快照差集清扫 / onChanged 驱逐） | 5/5 |
| `verify-defect.mjs` | 身份叛逃处置（继承 / 重载 / 解绑 / 快照护栏 / 命名空间回滚 / 治愈） | 8/8 |
| `verify-autologin.mjs` | 自愈式提交（首击被吞后重试 ≤4 次 / 提交时值完整 / 用户键入即让位） | 5/5 |
| `verify-dynsnap.mjs` | 快照动态化（登录后票据实时进回放 / 轮换 / 作废移除 / 袋回流） | 6/6 |
| `verify-fillrhythm.mjs` | 填充节奏五重门控（iframe 延迟挂载 / 拒绝后重填 / 让位 / 停止重试） | 9/9 |
| `verify-httpscheme.mjs` | scheme 数据化（纯 http 站点探测翻转 / https 不误伤） | 10/10 |
| `verify-adopt.mjs` | opener 亲子继承（同站继承 / 异域解绑 / 手动不继承 / 原页签保持） | 5/5 |
| `verify-boxmgmt.mjs` | 盒子管理（重命名 / 删除两步确认 / 冷启保持） | — |
| `verify-defbox.mjs` | 默认盒重命名 / 新账号归属 / 冷启 | — |
| `verify-track.mjs` | 录制埋点 | — |

## 写新验证脚本的四条规矩

从 `tmp/` 这次退化里总结出来的，加脚本时照做：

1. **必须放在被跟踪的 `tools/` 下**，不要放 `tmp/`。
2. **依赖必须写进 `package.json`**（`tools/check_deps.mjs` 会机检这件事）。
3. **根路径用 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')`**
   —— 本目录深度是两层，写一层会**静默**指向 `tools/` 并去找 `tools/dist/manifest.json`。
4. **断言必须能红**：写完先问"拆掉什么它才会红"，答不上来说明它没在验任何东西
   （同 `akso-mogul` 的 PITFALLS #119）。
