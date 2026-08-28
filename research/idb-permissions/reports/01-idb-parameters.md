# 报告 01 · IndexedDB 全量参数解析（权限控制粒度）

生成时间：2026/8/28 16:31:20，快照 2 份

---

## 快照 snap-001-T1.json · T1 · https://tonbridge-config.aksoegmp.com/admin/config/basic-objects/list?_searchKey

### 库 `CacheDb`

### 仓 `TableCache`（0 条，keyPath=undefined）

| 条目 id | len | sha1(前8) | 权限相关参数（path=preview） | 全部参数路径数 |
|---|---|---|---|---|

### 库 `DBFetch`

### 仓 `DBFetch`（4 条，keyPath=undefined）

| 条目 id | len | sha1(前8) | 权限相关参数（path=preview） | 全部参数路径数 |
|---|---|---|---|---|
| ? | 100005 | 0841d201 |  | 1 |
| b50d8804255dbc1a7a489ce08c507dcb | 9132 | 9e6f9600 | `isAdmin`=true<br>`interfaceAddressConfig.interfaceAddress`=<br>`systemInformationConfig.domainName`=https://tonbridge-config.aksoegmp.com<br>`systemInformationConfig.isShowName`=false<br>`systemInformationConfig.systemId`=0<br>`systemInformationConfig.name`=<br>`systemInformationConfig.version`=v3.7.0.0<br>`systemInformationConfig.serverAddress`=<br>`systemInformationConfig.environmentName`=Akso eGMP<br>`systemInformationConfig.environmentType`=null<br>`systemInformationConfig.displayEnvironmentType`=false<br>`systemInformationConfig.configVersion`=1.0.0.71<br>…共256项 | 304 |
| b9bb337de897319e7be9a91a9510bdb4 | 41464 | 0155c81d | `[0].pageType`=2<br>`[0].pageList[]`=len=99<br>`[0].pageList[0].name`=密码策略设置<br>`[0].pageList[0].code`=PasswordPolicyList__c<br>`[0].pageList[0].route`=/admin/system-setting/password-policy<br>`[0].pageList[0].url`=/admin/system-setting/password-policy/list<br>`[0].pageList[0].isEnabled`=true<br>`[0].pageList[0].type`=2<br>`[0].pageList[0].sort`=60<br>`[0].pageList[0].createdBy`=dc1b129b-10de-4898-894d-7d3fa4a33159<br>`[0].pageList[0].createdTime`=2025-05-12 15:44:21<br>`[0].pageList[0].modifiedBy`=00000000-0000-0000-0000-000000000000<br>…共15项 | 16 |
| ed312510c3a96ccb74d44edecc0408e9 | 1604 | ec1ef3d5 |  | 17 |

---

## 快照 snap-002-T2.json · T2 · https://tonbridge-config.aksoegmp.com/web/view?mid=ad055a82-eadf-2612-55dc-3a1c9

### 库 `CacheDb`

### 仓 `TableCache`（0 条，keyPath=undefined）

| 条目 id | len | sha1(前8) | 权限相关参数（path=preview） | 全部参数路径数 |
|---|---|---|---|---|

### 库 `DBFetch`

### 仓 `DBFetch`（4 条，keyPath=undefined）

| 条目 id | len | sha1(前8) | 权限相关参数（path=preview） | 全部参数路径数 |
|---|---|---|---|---|
| 90bf918a0cfba668405e4fe2adb547b9 | 24200 | 24962006 | `[0].menuId`=00000000-0000-0000-0000-000000000000<br>`[0].parentMenuId`=null<br>`[0].menuFunctionType`=0<br>`[0].menuActionType`=2 | 22 |
| b50d8804255dbc1a7a489ce08c507dcb | 9133 | 992b1246 | `isAdmin`=false<br>`interfaceAddressConfig.interfaceAddress`=<br>`systemInformationConfig.domainName`=https://tonbridge-config.aksoegmp.com<br>`systemInformationConfig.isShowName`=false<br>`systemInformationConfig.systemId`=0<br>`systemInformationConfig.name`=<br>`systemInformationConfig.version`=v3.7.0.0<br>`systemInformationConfig.serverAddress`=<br>`systemInformationConfig.environmentName`=Akso eGMP<br>`systemInformationConfig.environmentType`=null<br>`systemInformationConfig.displayEnvironmentType`=false<br>`systemInformationConfig.configVersion`=1.0.0.71<br>…共256项 | 304 |
| b9bb337de897319e7be9a91a9510bdb4 | 3169 | 7749f83c | `[0].pageType`=2<br>`[0].pageList[]`=len=7<br>`[0].pageList[0].name`=页面模板<br>`[0].pageList[0].code`=ApprovalForm__c<br>`[0].pageList[0].route`=/admin/business-management/template/approval-form<br>`[0].pageList[0].url`=/admin/business-management/template/approval-form<br>`[0].pageList[0].isEnabled`=true<br>`[0].pageList[0].type`=2<br>`[0].pageList[0].sort`=74<br>`[0].pageList[0].createdBy`=dc1b129b-10de-4898-894d-7d3fa4a33159<br>`[0].pageList[0].createdTime`=2025-05-12 15:44:21<br>`[0].pageList[0].modifiedBy`=00000000-0000-0000-0000-000000000000<br>…共15项 | 16 |
| ed312510c3a96ccb74d44edecc0408e9 | 1205 | 1ce07df4 |  | 17 |

---

## 跨账号同键差异（同一 entry id 在不同账号下的参数级 diff）

### 条目 b50d8804255dbc1a7a489ce08c507dcb

- 9e6f9600 len=9132（snap-001-T1.json T1）
- 992b1246 len=9133（snap-002-T2.json T2）
  - diff(9e6f9600 → 992b1246)：1 处
    - `isAdmin`：true ⇒ false

### 条目 b9bb337de897319e7be9a91a9510bdb4

- 0155c81d len=41464（snap-001-T1.json T1）
- 7749f83c len=3169（snap-002-T2.json T2）
  - diff(0155c81d → 7749f83c)：135 处
    - `0.pageList.0.name`："密码策略设置" ⇒ "页面模板"
    - `0.pageList.0.code`："PasswordPolicyList__c" ⇒ "ApprovalForm__c"
    - `0.pageList.0.route`："/admin/system-setting/password-policy" ⇒ "/admin/business-management/template/approval-form"
    - `0.pageList.0.url`："/admin/system-setting/password-policy/list" ⇒ "/admin/business-management/template/approval-form"
    - `0.pageList.0.sort`：60 ⇒ 74
    - `0.pageList.0.id`："007773cb-0a1e-dbd8-0eb4-3a19d5a0892d" ⇒ "11859d68-b9ae-c77e-c780-3a19d5a089f7"
    - `0.pageList.1.name`："工作流设置" ⇒ "全景图"
    - `0.pageList.1.code`："WorkflowSetting__c" ⇒ "Panoramic__c"
    - `0.pageList.1.route`："/admin/config/workflow-setting" ⇒ "/admin/business-management/template/panoramic"
    - `0.pageList.1.url`："/admin/config/workflow-setting" ⇒ "/admin/business-management/template/panoramic"
    - `0.pageList.1.sort`：95 ⇒ 103
    - `0.pageList.1.createdTime`："2025-05-12 15:44:21" ⇒ "2025-09-17 09:58:00"
    - `0.pageList.1.id`："0807dd97-712b-833d-edca-3a19d5a08b90" ⇒ "65bc4382-f08d-1c2c-90fe-3a1c679173bc"
    - `0.pageList.2.name`："报表类型" ⇒ "运行报告模板"
    - `0.pageList.2.code`："ReportType__c" ⇒ "RunTimeTalk__c"
    - `0.pageList.2.route`："/admin/config/report-type" ⇒ "/admin/business-management/template/run-time-talk"
    - `0.pageList.2.url`："/admin/config/report-type/list" ⇒ "/admin/business-management/template/run-time-talk"
    - `0.pageList.2.sort`：53 ⇒ 71
    - `0.pageList.2.id`："0c890f63-5ec7-5b39-443e-3a19d5a088c4" ⇒ "6ad158fc-36c1-d16f-e603-3a19d5a089bf"
    - `0.pageList.3.name`："调用接口作业日志" ⇒ "标签模板"
    - `0.pageList.3.code`："newCallInterfaceMonitor__c" ⇒ "DocumentTag__c"
    - `0.pageList.3.route`："/admin/maintenance-management/new-call-interface-monitor" ⇒ "/admin/business-management/template/document-tag"
    - `0.pageList.3.url`："/admin/maintenance-management/new-call-interface-monitor/li ⇒ "/admin/business-management/template/document-tag"
    - `0.pageList.3.sort`：78 ⇒ 72
    - `0.pageList.3.id`："0e656bdd-b8be-edc3-a83b-3a19d5a08a41" ⇒ "8d708023-2217-b2ae-6932-3a19d5a089d3"
    - `0.pageList.4.name`："文件编号规则" ⇒ "页面模板包"
    - `0.pageList.4.code`："DocumentNumberRules__c" ⇒ "DocumentPageTemplatePackage__c"
    - `0.pageList.4.route`："/admin/config/document-config/number-rules" ⇒ "/admin/business-management/template/template-pack-list"
    - `0.pageList.4.url`："/admin/config/document-config/number-rules" ⇒ "/admin/business-management/template/template-pack-list/list
    - `0.pageList.4.sort`：93 ⇒ 97

### 条目 ed312510c3a96ccb74d44edecc0408e9

- ec1ef3d5 len=1604（snap-001-T1.json T1）
- 1ce07df4 len=1205（snap-002-T2.json T2）
  - diff(ec1ef3d5 → 1ce07df4)：6 处
    - `2.name`："管理端" ⇒ "打印中心"
    - `2.code`："admin__sys" ⇒ "print_center__sys"
    - `2.icon`："SettingOutlined" ⇒ "PrinterOutlined"
    - `2.sort`：3 ⇒ 4
    - `2.id`："7653b278-a2ca-490e-8f0a-2a1c0557f1e3" ⇒ "e5a49712-31ed-4f55-ba3a-82ae9336c282"
    - `3`：{"companyId":null,"belongId":null,"name":"打印中心","code":"prin ⇒ undefined
