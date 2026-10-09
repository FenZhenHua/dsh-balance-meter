# @fenzhenhua123/dsh-balance-meter

在 DeepSeek Harness **会话页面底部统计条**（`会话统计` / `Token 用量` / `上下文已用` 同一行）追加一个「余额 · 本次」胶囊，显示：

- **API 余额**：DeepSeek 开放平台充值余额（含赠金，左键单击可见明细）
- **本次使用金额**：按 **DeepSeek 官方计费方式**逐请求精确累计（见下方「计费方式」）
- **本次 Tokens**：输入未缓存 / 缓存读 / 缓存写 / 输出 四桶合计（左键单击可见）

> 仓库：<https://github.com/FenZhenHua/dsh-balance-meter> · npm：`@fenzhenhua123/dsh-balance-meter`

## 安装

```powershell
# 通过 npm（已发布到 1024 Store / npm）
dsh plugin add @fenzhenhua123/dsh-balance-meter
# 或
npm install @fenzhenhua123/dsh-balance-meter
```

安装后到「插件」页找到「余额与本次费用」卡片，点开关即可一键启用/禁用（即时生效，无需重启；浏览器端可能需刷新一次页面）。

本地安装（未发布前的方式）：把本目录放到 `%DSH_HOME%\profiles\node_modules\@fenzhenhua123\dsh-balance-meter\`，并在 `%DSH_HOME%\profiles\<profile>\package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中登记 `@fenzhenhua123/dsh-balance-meter`。

## 计费方式（官方）

费用在 **Host 侧逐请求重放会话日志**计算，而不是用拍平的单价估算：

1. **分模型**：`deepseek-v4-pro` / `deepseek-flash`（旧名 `deepseek-v4-flash*` 按 Flash 计；未知模型回退到 v4-pro 以免低估）。
2. **分缓存**：输入缓存命中（便宜）/ 缓存未命中 + 缓存写入（全价）/ 输出，三个独立价档。
3. **分时段**：北京时间峰谷时段，`高峰 = 空闲 × 2`。工作日（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰；其余均为空闲，包括**周末（含调休上班的周末）与法定节假日全天**。

**价格自动刷新**：Host 每 6 小时抓取官方价格页 `api-docs.deepseek.com/zh-cn/quick_start/pricing/` 并解析最新单价；抓取或解析失败时回退到内置价格表（点击弹层会标注当前用的是「官方价」还是「内置价」）。

> 已知近似：法定节假日表内置了 2026 年（国办发明电〔2025〕7 号），跨年后需在 `lib/index.js` 的 `CN_WEEKDAY_HOLIDAYS_2026` 更新下一年度日期。费用为估算值，实际以平台扣费为准。

## 文件结构

```
├── package.json      # dsh.bundle（补丁层）+ dsh.client（浏览器清单）+ icon
├── cordis.patch.yml  # 向 Loader 插入 balance-meter 宿主条目
├── icon.svg          # 插件区显示的图标
├── locale/           # 插件区显示名称/描述（en / zh）
├── lib/
│   ├── index.js      # Host 半侧：会话日志重放 + 官方价格解析/刷新 + 费用路由
│   └── client.js     # 浏览器半侧：余额 + 本次费用胶囊（已构建 bundle 形态）
└── README.md
```

## 调整内置价格（官方价抓取失败时的兜底）

编辑 `lib/index.js` 顶部的 `EMBEDDED_PRICING`（单位：人民币 / 百万 tokens，空闲时段；高峰自动 ×2）：

```js
const EMBEDDED_PRICING = {
  "deepseek-v4-pro": { miss: 4.5, hit: 0.15, output: 13.5 },
  "deepseek-flash":  { miss: 1.0, hit: 0.02, output: 4.0 }
};
```

## License

MIT
