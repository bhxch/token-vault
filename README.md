# token-inbox

把消息里的 token（API 密钥、PAT 等）截入本地保险箱，对模型脱敏：真值不发给后端 LLM，但 Claude Code 可以用——模型调度落值动作，却读不到值。

## 安装

方式一（正式安装，终端会话里）：

```
/plugin install token-inbox --marketplace /解包后的目录路径/token-inbox
```

方式二（快速试用）：

```
claude --plugin-dir /解包后的目录路径/token-inbox
```

## 用法

1. 把 token 直接发在消息里（如「帮我配 gh，token 是 ghp_xxx」），mod 自动截获入箱、消息脱敏，模型只见占位符。编号格式为 `YYYYMMDD-NNN`，每日从 001 起；
2. 告诉 Claude 落值目标和变量名，它会调用 `vault-apply` 并携带占位符里的编号，把真值写进目标文件——返回内容只有长度，没有明文。箱内仅一个 token 时可省略编号；
3. `/token-flush` 仅作恢复手段（当日脱敏额度满或保险箱异常时），日常无需使用。

## 覆盖的 token 格式

`ghp_` / `gho_` / `ghu_` / `ghs_`（GitHub PAT）、`github_pat_`（细粒度 PAT）、`sk-ant-` / `sk-`（API key）、`glpat-`（GitLab）、`xox[baprs]-`（Slack）；长度下限贪婪匹配，超长也全段截获。

## 边界说明

- 真值保存在引擎托管的本地存储（`~/.claude/plugins/store/` 下，明文 JSON），防的是发给后端模型，不防本机其他进程；
- 脱敏发生在入口：已进入会话的历史内容不可改写；
- 保险箱全箱至多 999 个 token，超出按入箱时间 FIFO 淘汰最旧，被淘汰的编号不再可落值（报错会列出当前可用编号）；
- 单日新 token 至多 999 个（与 `NNN` 三位编号格式一致，编号恒为三位），超出当天消息将被整体拦截，需 `/token-flush` 清空后重试。
