# claude-kimi-agent-skill

Claude Code skill：通过固定 prompt 模板调用 kimi code CLI，完成 review 与 TDD 开发任务。

## 特性

- **review** — 单文件/文档 review（Critical/Warning/Suggestion 分级）
- **review-plan** — 对照设计文档评审代码实现
- **review-diff** — review 未提交变更或任意 git range（diff 由 kimi 自行查看，不撑爆 prompt）
- **implement** — 强制 TDD 的功能实现（改动留在工作区，不自动 commit）
- **run** — 自由任务透传
- prompt 拼装 100% 由代码完成（模板 + 变量替换），不依赖模型即兴发挥

## 前置条件

1. Node.js >= 20
2. 已安装并登录 kimi code CLI（`kimi login`），或设置 `KIMI_BIN`

## 安装

### 1. 安装 CLI

```bash
npm install -g claude-kimi-agent-skill
```

### 2. 注册 Skill（Claude Code）

```bash
npx skills add ivanon/claude-kimi-skill -y -g
```

注册后在 Claude Code 中明确提到 "kimi" 即可触发，例如"用kimi review一下这个文件"、"让kimi实现登录功能"。

## 用法

见 `SKILL.md` 的示例一节；所有子命令支持 `--model`、`--timeout <sec>`（默认 600）、`--cwd <dir>`、`--dry-run`、`--output <file>`（把过滤后的报告落盘，stdout 始终原样转发）。

专属选项按子命令白名单校验，传错即报错退出：`--focus` 仅 review / review-diff；`--scope` 仅 review-plan / implement；`--plan` 仅 implement。

`--output` 语义：kimi 非零退出时仍会写入已捕获的部分报告（便于排查），退出码照常透传；超时（进程被 kill）则不落盘。

## 开发

```bash
npm test        # node:test，无外部依赖
```

## Troubleshooting

- **找不到 kimi 命令**：确认 `kimi` 在 PATH 中或设置 `KIMI_BIN`
- **review-diff 报"没有可 review 的变更"**：确认工作区有未提交改动（未跟踪的新文件需先 git add），或显式传 range（如 `main..HEAD`、`--cached`）
- **超大仓库 diff**：kimi 自行执行 git diff 查看变更；必要时用 range 缩小范围
- **超时**：默认 600s，长任务加 `--timeout 1800`
- **超长 prompt**：prompt 经命令行参数传递，极长任务描述可能触及 OS 限制，请精简描述并用 --plan 指向文档

## License

MIT
