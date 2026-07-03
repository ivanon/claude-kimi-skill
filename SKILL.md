---
name: kimi-agent
version: 0.1.0
description: "调用 kimi code CLI 执行代码/文档 review 和 TDD 开发。支持单文件 review、plan-based review、diff review、TDD 实现与自由任务。仅在用户明确提到 'kimi' 且意图为 review/实现/编码任务时触发，例如 '用kimi review这个文件'、'让kimi实现登录功能'。浏览器/网页类请求不归本 skill（走 kimi-webbridge）。"
---

# kimi-agent

## 触发条件

**仅当用户明确提到 "kimi" 且意图为 review/实现/编码任务时触发**，例如：

- "用kimi review一下 src/auth.ts"
- "让kimi对照 docs/design.md 检查实现"
- "用kimi检查一下这个PR / 这次改动"
- "让kimi实现登录功能"
- "让kimi随便看看这个项目"

**不触发**：

- 未提 kimi 的 review/开发请求 → Claude 自行处理
- 浏览器、网页、截图类请求 → 归 kimi-webbridge skill

## 调用方式

通过全局安装的 `kimi-agent` 命令调用（skill 注册只包含本说明文件，脚本随 npm 包分发）：

```bash
kimi-agent <子命令> [参数...]
```

若提示找不到 `kimi-agent` 命令，先执行 `npm install -g claude-kimi-agent-skill`。

## 意图 → 子命令映射

| 用户说法 | 子命令 |
|---------|--------|
| review 某个文件/文档 | `review <file>` |
| 对照设计文档/plan 检查实现 | `review-plan <plan>` |
| review 这个 PR / 这次改动 / 提交前检查 | `review-diff [<range>]` |
| 实现/开发/加功能/加测试 | `implement "<需求>"` |
| 其他明确指名 kimi 的编码任务 | `run "<prompt>"` |

模糊意图默认路由：能对上前四行的优先用模板化子命令，对不上的才落到 `run`。

## 示例

```bash
kimi-agent review src/auth.ts --focus "并发安全"
kimi-agent review-plan docs/design.md --scope src/ --output review.md
kimi-agent review-diff main..HEAD
kimi-agent implement "给 auth.ts 加 JWT 验证" --plan docs/design.md
kimi-agent run "总结这个项目的架构"
kimi-agent review src/auth.ts --dry-run   # 调试：只看 prompt
```

## 风险提示

- `implement` 会直接修改仓库文件（kimi 的 `-p` 非交互模式默认自动批准所有操作，改动留在工作区、不 commit）
- `implement` 成功判定：exit 0 **且**报告末尾含「验证摘要」（测试命令与通过/失败计数）；缺摘要视为"实现未经验证"，须向用户如实说明
- review 类的"只读"是 prompt 级软约束，无技术强制；异常改动靠 git 兜底
- `run` 仅用于四个模板覆盖不了的场景

## 配置

- 依赖已安装并登录的 kimi code CLI（`kimi login`）
- `KIMI_BIN` 环境变量可覆盖 kimi 可执行文件路径
- `--model` 透传 kimi 的模型别名
