# 专项研究：页签间权限问题 · IndexedDB 深度剖析

> 隶属 QuickLogin，但**不进扩展产物**——本目录是纯研究工程（驱动器 + 分析器 + 报告），
> 对目标站 `tonbridge-config.aksoegmp.com` 使用用户自己的测试账号，在隔离档案中进行。

## 课题

| # | 课题 | 产出 |
|---|---|---|
| 1 | **全量解析 IndexedDB 参数**：权限的控制究竟有多细（全局标志位？菜单节点级？页面/按钮级？字段级？） | `reports/01-idb-parameters.md` + `tmp/research-idb/params-*.json` |
| 2 | **影响账号权限的因素 × 影响账号安全的因素** 剖析 | `reports/02-factors.md` |
| 3 | **登录态下动态覆盖 IDB 能否控制权限**：改 `isAdmin`/换菜单树 → UI 与服务端各信什么、边界在哪 | `reports/03-dynamic-overwrite.md` |

## 组成

- `driver.mjs` —— 实验驱动器：带扩展启动隔离 Chrome（`tmp/research-profile`），
  轮询 `tmp/research-idb/go` 执行命令（每行一条），结果落 `tmp/research-idb/log.jsonl`。
- `analyze-idb.mjs` —— 全量参数分析器：吃 SNAP 快照 → 参数树清单 + 跨账号同键差异 → 报告。

## 命令（写入 `tmp/research-idb/go`，每行一条；由主持方写入）

| 命令 | 作用 |
|---|---|
| `SNAP` | 页面侧**全量** dump 每个站点标签页命名空间 IDB（值全量截 100KB/条）→ `snap-*.json` |
| `SETADMIN <tab> <true\|false>` | 在该标签页**活体改写** DBFetch 中含 `isAdmin` 的条目（页面上下文 → 落本账号命名空间库，应用即刻可读） |
| `COPYENTRY <srcTab> <dstTab> <isAdmin\|menu\|id前缀>` | 把源标签页命名空间库里的指定条目整条复制到目标标签页（跨账号投毒实验） |
| `RELOAD <tab>` | 刷新标签页（观察缓存重建 / 覆盖是否被服务端数据冲回） |
| `PROBE <tab>` | 该标签页身份快照（URL + token 主体） |
| `STATUS` | 列出当前标签页 |
| `LS <tab>` | 命名空间 localStorage 全量 dump；含 `power/perm/menu/auth/config` 的键全文入 `log.jsonl`（`ls-entry` 事件） |
| `APITEST <tab> <path> [method]` | 以该页自身身份（补丁后 Bearer/Cookie）重放接口 → HTTP 状态码 + 正文头 600 字符（服务端鉴权判定） |
| `EDIT <tab> <id前缀> <jsonPath> <JSON字面量>` | 精细编辑条目 values 内嵌套字段（如 `[0].pageList.3.isEnabled` `false`） |

## 数据与安全

- 原始 dump（可能含内部配置数据）一律在 `tmp/research-idb/`（.gitignore）；
- 提交入库的只有：本目录代码 + **脱敏后的分析报告**（不含 token，配置样本截断）；
- 实验仅作用于用户自己的测试账号，不触碰生产数据。

## 复跑

```powershell
node research/idb-permissions/driver.mjs      # 常驻，等 go 命令
node research/idb-permissions/analyze-idb.mjs # SNAP 后生成参数报告
```
