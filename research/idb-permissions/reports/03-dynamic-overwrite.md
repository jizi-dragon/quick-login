# 报告 03 · 登录态下动态覆盖 IndexedDB 能否控制账号权限（终审）

生成：2026-08-28 · 环境：3.7.2 隔离档案，管理员 A(lyl/d3de54c2) + 普通 U(T0601/b1656bc9) 双开

## 实验矩阵与结果

| # | 操作 | 观察点 | 结果 |
|---|---|---|---|
| 1 | `SETADMIN 2 true`（U 库内翻转 isAdmin） | 不刷新 | **UI 无变化**——内存态不回读 IDB |
| 2 | 承上 + `RELOAD 2` | 管理端入口 | **未出现**；四条目被网络重取全部回写（sha1 全变新值） |
| 3 | `COPYENTRY 1 2 ed312510`（A 导航条目整条移植）+ reload | 管理端入口 | **未出现**；移植被重取冲掉（1402 字节第三版） |
| 4 | A→U 移植全部三数据条目（菜单 130KB/页面 99 页/导航）+ isAdmin:true + **免密恢复重开** | 管理端入口 | **仍未出现**；SNAP 证实全部条目再次被重取回写（26847/10016/3538/1402） |
| 5 | API 重放（U 的 Bearer 直调管理侧 GET） | 服务端判定 | 全部 200（见下） |

## 终审结论

**否——动态覆盖 IndexedDB 无法控制账号权限。**

机制：该平台的 DBFetch 是**网络优先、写穿镜像**——所有启动路径（账密登录、F5 刷新、免密恢复）都先重取再回写，IDB 从不作为渲染源被读取。覆盖条目在任何一次引导中都会被服务端新鲜数据冲掉，存活时间为零。

连带修正：v3.7 之前观测到的「U 获得管理员」（四象限泄漏）并非「应用读缓存渲染」，其渲染源是当时共享 HTTP 缓存与恢复时序的复合（现已被 `_qlck` 分区 + 六平面隔离切断；3.7.x 回归全绿佐证）。IDB 共享是**污染存储**而非**渲染源**。

## 暴力化方向（模拟暴力入侵）的替代表面

UI 层赋权不可行（上述），真正有效的是 **API 层**。两轮重放（U 的 Bearer）：

| 接口 | U | A | 判定 |
|---|---|---|---|
| `/api/platform/AuditLog/GetsByPage` | 405 | 405 | 方法不符（POST+body），未判 |
| `/api/platform/BasicObject/BasicObjectList` | 200（936 条，与 A 全同） | 200 | 管理侧读未过滤 |
| `/api/platform/UserView/GetHomeViewList` | 200 | 200 | 未过滤 |
| `/api/platform/biz/BasicObject/Fields` | 200（字段定义全同） | 200 | 未过滤 |
| `/api/platform/ConfigPackage/GetOutboundPackagePageList` | 200（部署配置包清单） | 200 | **管理配置读未过滤** |
| `/api/platform/WorkflowInstance/GetActiveWorkflowInstanceCount` | 200（=2） | 200（=8） | 用户域数据，按身份区分 ✓ |
| `/api/platform/Notice/GetUnreaddLetterCount` | 200（=57） | 200（=1008） | 用户域数据 ✓ |

- **读面**：管理配置/元数据类 GET 对普通账号全开放（信息泄露面，见报告 02）；
- **写面**：具破坏性，研究明确不测——若平台写接口有同样的过滤缺失，才构成真实越权，需平台方自查；
- **数据面**：用户自有数据严格按身份区分，鉴权锚点（GUID→配置）工作正常。

## 精细化控制方向

- 对象/字段/菜单级细粒度配置**不在客户端**（`user_center_power`="2" 为版本标记），无法通过客户端单点开关实现精细化授权；
- 若 QuickLogin 需要产品化的「精细化控制」，正确层次是**策略层的 per-tab API 过滤**（DNR blockRules 按路径命中 `/api/platform/...` 白/黑名单），而非客户端数据篡改——这属于扩展功能候选，不属于本研究所动代码。

## 方法可复现性

全部操作由 `research/idb-permissions/driver.mjs` 命令流驱动（`SNAP/SETADMIN/COPYENTRY/RELOAD/PROBE/LS/APITEST/EDIT`），原始事件与快照在 `tmp/research-idb/`（gitignored），命令历史在 `tmp/research-idb/log.jsonl`。
