---
description: "按 principal/Session 汇总 provider 上报的 token 与费用，提供 JSON/CSV 导出与真实模型对账。"
---

# 租户成本报表

## Summary

`GET /api/browser-native/usage-report` 汇总 backend 已记录的 provider 上报 usage，按 principal（租户）和 Session 分组，并按配置的每百万 token 单价计算费用。`format=csv` 返回附件下载，`hosted/export-usage-report.mjs` 从数据目录读取本地 token 后导出文件。报表不估算 token：输入与输出计数直接来自 provider 响应，与 `/usage-audit` 同源。

## 请求与字段

```sh
# 需要本地进程 token
curl -H "x-browser-native-auth: $(cat $DSH_POC_DATA_DIR/browser-native-auth-token)" \
  "$ORIGIN/api/browser-native/usage-report?format=json"
```

JSON 报表：

```json
{
  "generatedAt": "2026-11-04T06:00:00.000Z",
  "model": "gpt-5.6-sol",
  "pricing": { "inputUsdPer1M": 1.25, "outputUsdPer1M": 2.5 },
  "totals": { "requests": 2, "inputTokens": 1200, "outputTokens": 240, "totalTokens": 1440, "costUsd": 0.0021 },
  "principals": [
    {
      "principalId": "0f0e…",
      "requests": 1, "inputTokens": 640, "outputTokens": 120, "totalTokens": 760, "costUsd": 0.0011,
      "sessions": [
        { "sessionId": "s-1", "requests": 1, "inputTokens": 640, "outputTokens": 120, "totalTokens": 760, "costUsd": 0.0011 }
      ]
    }
  ]
}
```

- `principalId` 来自发起 LLM 代理请求的 principal cookie；归属不明的旧条目为 `null`，不被丢弃。
- `sessionId` 来自请求体的 Session id；没有 id 的条目归入 `null` Session 行。
- `costUsd` 为 `inputTokens × inputUsdPer1M / 10^6 + outputTokens × outputUsdPer1M / 10^6`；未配置价格时为 `null`。
- `format=csv` 列固定为 `principal_id,session_id,requests,input_tokens,output_tokens,total_tokens,cost_usd`，每行一个 principal/Session 组合，响应带 `Content-Disposition: attachment` 与日期文件名。
- 端点与 `/usage-audit` 一样只对持有本地进程 token 的运维调用方开放；不同 principal 的报表合并展示，供租户计费汇总，不向租户自身暴露。

## 价格配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_POC_INPUT_USD_PER_1M` | 无 | 输入 token 每百万美元单价；与输出价必须同时设置 |
| `DSH_POC_OUTPUT_USD_PER_1M` | 无 | 输出 token 每百万美元单价 |

两项都未设置时仍输出 token 汇总，`pricing` 与 `costUsd` 为 `null`。价格在进程启动时读取；修改价格需重启进程。报表按当前进程价格重算历史条目，因此价格变更后同一历史窗口的 `costUsd` 会变化；这是汇总视图，不是不可变账单。

## 导出

```sh
node docs/drafts/browser-native-dsh-poc/hosted/export-usage-report.mjs \
  --origin http://127.0.0.1:4185 \
  --data-dir /srv/browser-native-dsh-data \
  --format csv \
  --out usage-report.csv
```

`--format json` 输出完整分组结构并把摘要写到 stderr；省略 `--out` 时把报表写到 stdout，便于管道。token 文件必须是 `0600`，脚本只读不写数据目录。

## 真实模型对账

```sh
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/usage-report.e2e.mjs
```

`tests/usage-report.e2e.mjs` 用两个浏览器 context 创建两个 principal，各自发送一轮真实模型请求，然后：

- 断言 `/usage-audit` 的每条 provider usage 都带 principal；
- 报表 `totals` 的请求数、输入/输出/总 token 与 audit 逐项相等；
- 报表 `totals.costUsd` 等于按配置单价对 provider token 求和；
- 两个 principal 各自归组自己的 Session，principal 内 Session 行可逐项相加得到该 principal 汇总；
- CSV 行数等于 Session 组数，CSV 各行 token 与费用之和等于报表 `totals`。

实测（2026-11-04，`LongCat-2.5`，Chrome 156，单价 1.25/2.5 美元每百万）：两 principal、两 Session，provider 上报 2 次请求、4,692 输入 token、52 输出 token、4,744 总计；报表 `totals` 与 provider usage 逐项相等，`costUsd` 为 `0.005995`（与单价求和一致），CSV 导出 2 行且汇总相等。具体数字随模型输出变化，测试以相等断言而非固定快照记录。

另用 `DSH_POC_INPUT_USD_PER_1M=1.25`、`DSH_POC_OUTPUT_USD_PER_1M=2.5` 启动 scripted 托管进程并执行 `export-usage-report.mjs`：JSON 输出 `principals: []`、`pricing` 生效；CSV 只有表头。该步骤验证了 token 文件读取、HTTP 取数与文件写入路径。

## 边界

报表只覆盖 real 模式的 provider usage；scripted 模式没有外部用量，报表为空但端点可用。费用只按 token 单价计算，不含请求重试、网络、存储或人工成本，不做币种换算与税率。usage 记录来自 provider 响应而非独立账单系统，断流或 provider 未返回 usage 的请求不会进入报表。报表不是不可变计费账本：没有逐条冻结、对账签名或配额扣减；租户预算拒绝仍由既有预算路径负责。

相关边界见[服务端交付边界](server-delivery-boundaries.md)与[托管模式部署](hosted-deployment.md)。
