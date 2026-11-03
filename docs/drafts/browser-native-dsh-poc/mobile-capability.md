---
description: "记录 iOS Safari 与 Android Chrome 设备仿真的能力探测结果：Worker、OPFS 同步句柄、Service Worker、存储与内存上限，以及移动端启动 preview 的结论与替代方案。"
---

# 移动端能力探测

## Summary

[移动端探测](tests/mobile-capability.e2e.mjs)用 Playwright 设备仿真跑两个 profile：`iPhone 15` + WebKit 代表 iOS Safari，`Pixel 7` + Chromium 代表 Android Chrome。两者都暴露 Dedicated Worker、module worker、`BroadcastChannel`、Web Locks、`crypto.subtle`、IndexedDB 和 Service Worker，也都不提供 `SharedArrayBuffer`（未启用跨源隔离）。

差别集中在 OPFS。Android Chrome 在 Worker 内能创建 sync access handle，durable Workspace preview 同步成功，测试通道写入/回读一致，并完成一个包含 19 个事件的 scripted turn。iOS WebKit 的 `navigator.storage.getDirectory()` 在页面返回 `UnknownError`，在 Worker 内直接失败，没有 sync access handle；boot payload 因此在 Host 创建前失败，启动门明确报 `OPFS_SYNC_ACCESS_UNAVAILABLE`，不是静默降级。

内存与配额上限只有部分浏览器提供 API。Android Chromium 仿真报告 `jsHeapSizeLimit` 约 3.76 GB、`deviceMemory` 32 GB、存储 quota 约 4.1 GB；iOS WebKit 的 `navigator.deviceMemory`、`performance.memory` 与 `measureUserAgentSpecificMemory` 全部不可用，只能拿到存储 quota 约 1 GB（仿真环境的 1 GiB 默认值）。iOS 的真实内存上限没有 Web API，任何数字都必须来自真机观测。

## 能力对照

| 能力 | iOS Safari（WebKit 26.4、iPhone 15 仿真） | Android Chrome（Chromium 147、Pixel 7 仿真） |
| --- | --- | --- |
| Dedicated Worker / module worker | 可用 | 可用 |
| OPFS `getDirectory()`（页面） | 返回 `UnknownError` | 可用 |
| OPFS `getDirectory()`（Worker） | 失败 | 可用 |
| OPFS sync access handle（Worker） | 不可用 | 可用（写入 + `flush` 成功） |
| Service Worker 注册 | 成功（`activating`） | 成功（`activating`） |
| IndexedDB | 可用 | 可用 |
| `BroadcastChannel` / Web Locks | 可用 | 可用 |
| `crypto.subtle` / `SharedArrayBuffer` | 可用 / 不可用 | 可用 / 不可用 |
| `crossOriginIsolated` | `false` | `false` |
| `navigator.deviceMemory` | 不提供 | 32 |
| `performance.memory.jsHeapSizeLimit` | 不提供 | 约 3.76 GB |
| `measureUserAgentSpecificMemory` | 不提供 | 不提供（需要跨源隔离） |
| 存储 quota / usage | 约 1.0 GB / 0 | 约 4.1 GB / 264 B |
| durable Workspace 启动 | 阻塞：`OPFS_SYNC_ACCESS_UNAVAILABLE` | `synced`，写入回读通过 |
| scripted turn | 未执行 | 完成，`turn: 1`，19 个事件 |

两个 profile 的外部请求都是 0；Android 运行没有页面错误，iOS 的唯一页面错误就是启动门的 OPFS 诊断。

## 判定

- Android Chrome 的移动端形态是可用路径：能力集合与桌面 Chromium 一致，durable Workspace 与一次工具闭环都在仿真设备视口内完成。这里的限制来自仿真引擎而不是 Pixel 真机，仍需要真机确认存储配额、后台回收和软键盘行为。
- iOS 当前不可启动。结论不是“iOS 不支持 OPFS”，而是“当前可复现的 WebKit 构建在此路径上 fail closed”。启动门给出的显式诊断说明产品在该环境下是拒绝启动，而不是读写错误数据。
- Service Worker 在两个 profile 都能注册，但[后台常驻结论](background-residency-feasibility.md)已经证明 Service Worker 没有 `Worker` 构造器、没有同步 OPFS 句柄，不能承载 Agent Loop。移动端的 Service Worker 可用性不改变该结论。
- 内存上限无法由 API 判定。Chromium 的 `jsHeapSizeLimit` 是 V8 堆上限，不等于 OS 给浏览器的可用内存；iOS 没有任何等价接口，只能以真机崩溃/回收观测为准。

## iOS 的替代方案

| 方案 | 可行性 | 代价与未决问题 |
| --- | --- | --- |
| Safari 真机 + 启用 `Allow remote automation` | 可测，需要在设备或模拟器上交互式授权 | 只能得到证据，不能解决 OPFS 缺失；需要一台真机与 `safaridriver` |
| iOS 模拟器 + Safari WebDriver | 可测，需 Xcode 与已启动的模拟器 | 模拟器 OPFS 实现与真机可能不同，仍属构建相关结论 |
| 异步 OPFS（页面 API）替代 sync access handle | 部分可行 | 当前 VFS 与工具路径按同步句柄设计；改成异步需要重写 Workspace 存储层，且 Service Worker 仍无同步句柄 |
| IDB 兜底 + 内存 VFS | 可实现 | 大文件与 chunk-backed edit 失去 OPFS 的直接字节寻址，需要重新验证容量与恢复；等于第二条存储实现 |
| 服务端 durable host + 浏览器只做 UI | 可行 | 回到服务端 Session/Workspace 所有权模型，移动端不再执行 Agent Loop；与本 PoC 的浏览器内 Host 目标相反 |
| 真机云（BrowserStack/Sauce/自建设备农场） | 可测 | 需要外部账号与网络；只能采集证据，不改变能力结论 |

建议顺序：先用 iOS 模拟器 + Safari WebDriver 确认真实 Safari 构建的 OPFS 行为；如果同样缺少同步句柄，再决定是投入异步存储改造，还是把 iOS 归入“仅 UI + 服务端 host”的产品形态。不要在未验证前按 WebKit 仿真结果对外宣称 iOS 不可用。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 设备仿真能否作为移动端结论 | 只能作为引擎与 API 结论，不能作为真机结论 | 仿真复现 UA、视口、触摸与 DPR，但运行桌面引擎，内存、回收和后台策略都不同。 |
| iOS 探测失败是否算测试失败 | 不算；必须记录显式阻塞原因 | 目标是把“不可用”和“可用”都变成可判定输出；静默通过才是缺陷。 |
| 是否为了 iOS 立即实现 IDB 兜底 | 暂不实现 | 需要第二条存储实现与完整容量/恢复验证；先补齐真机证据再决定。 |
| Android 仿真通过是否代表 Android 可用 | 代表 Chromium 引擎可用，不代表 Pixel 真机 | 真机的存储配额、低内存回收与后台冻结仍未测。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [tests/mobile-capability.e2e.mjs](tests/mobile-capability.e2e.mjs) | 两个设备 profile 的能力探测、Service Worker 注册、OPFS 页面/Worker 探测、存储与内存 API 采样，以及 durable preview 启动与 scripted turn。 |
| [README.md](README.md) | 新增本节入口。 |
| [operational-compatibility-matrix.md](operational-compatibility-matrix.md) | 新增移动端行。 |

harness 不修改 Worker、profile、Session 格式或 Agent Loop；探测页与 Service Worker 脚本由测试通过路由临时提供，不进入 preview 构建产物。

## 证据

```sh
node docs/drafts/browser-native-dsh-poc/tests/mobile-capability.e2e.mjs
```

输出（节选，`capabilities` 已裁剪为判定相关字段）：

```json
{"result":"passed","scope":"mobile-capability-probe","profiles":[
 {"profile":"ios-safari","engine":"webkit","device":"iPhone 15","browserVersion":"26.4",
  "capabilities":{"hardwareConcurrency":8,"deviceMemory":null,"jsHeapSizeLimit":null,
   "measureUserAgentSpecificMemory":false,"secureContext":true,"maxTouchPoints":0,
   "page":{"opfs":true,"syncAccessHandle":false,"failure":"The operation failed for an unknown transient reason (e.g. out of memory)."},
   "worker":{"opfs":false,"syncAccessHandle":false,"failure":"The operation failed for an unknown transient reason (e.g. out of memory).","indexedDB":true},
   "dedicatedWorker":true,"moduleWorker":true,"sharedArrayBuffer":false,"crossOriginIsolated":false,
   "broadcastChannel":true,"locks":true,"indexedDb":true,
   "serviceWorker":{"available":true,"registered":true,"state":"activating"},
   "storage":{"quota":1048576000,"usage":0,"persisted":false}},
  "boot":{"synced":false,"startupBlocked":"Error: browser-native startup blocked: OPFS_SYNC_ACCESS_UNAVAILABLE"},
  "verdict":"startup-blocked"},
 {"profile":"android-chrome","engine":"chromium","device":"Pixel 7","browserVersion":"147.0.7727.15",
  "capabilities":{"hardwareConcurrency":14,"deviceMemory":32,"jsHeapSizeLimit":3760000000,
   "page":{"opfs":true,"syncAccessHandle":false},
   "worker":{"opfs":true,"syncAccessHandle":true,"indexedDB":true},
   "dedicatedWorker":true,"moduleWorker":true,"sharedArrayBuffer":false,"crossOriginIsolated":false,
   "serviceWorker":{"available":true,"registered":true,"state":"activating"},
   "storage":{"quota":4149263964,"usage":264,"persisted":false}},
  "boot":{"synced":true,"state":{"state":"synced","revision":0},"writeReadBack":true,"turn":1,"events":19},
  "verdict":"durable-workspace-supported"}]}
```

- Android 的 `syncAccessHandle: true` 来自 Worker 内真实 `write`/`flush`/`close` 与目录清理；回读断言来自 durable preview 的测试通道。
- iOS 的 `syncAccessHandle: false` 同时出现在页面与 Worker，且 `boot` 命中启动门外；两者口径一致。
- `maxTouchPoints: 0` 是 iPhone 描述符未设置触摸点数所致，不能作为触摸能力结论。

## 限制

- 仿真不是真机：iOS 内存上限、后台回收、软键盘、安全区域、真实 Service Worker 生命周期与 Android 的存储配额都可能与仿真不同。
- 未在 iOS 模拟器或真机上运行 Safari WebDriver；本机 Safari 远程自动化仍未开启。
- 只跑了 1 个 scripted turn，未测移动端长转录、滚动、真实模型延迟、网络切换、低电量模式与后台冻结。
- Android profile 使用 bundled Chromium 而非设备上的 Chrome 应用；两者引擎同源但版本与系统内存管理不同。
- 未验证移动端 OPFS 配额耗尽、附件上传和多标签内存压力。
