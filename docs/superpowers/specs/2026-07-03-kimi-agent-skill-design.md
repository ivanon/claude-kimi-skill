# kimi-agent Skill 设计文档

日期：2026-07-03
状态：已批准（待用户审阅书面 spec）

## 1. 目标

做一个 Claude Code skill（参考 `claude-cursor-skill`），让用户在 Claude 对话中通过自然语言调用 kimi code CLI 完成代码/文档 review 和开发任务。

核心诉求：**prompt 模板固定化**。review / 实现任务的 prompt 结构（项目范围、文档位置、review 目标等）由模板文件 + 代码填空保证，不允许 Claude 每次即兴生成 prompt。

## 2. 背景与前提

- kimi code CLI 已安装（`~/.kimi-code/bin/kimi`）且已登录，原生支持非交互模式：`kimi -p "<prompt>"`、`-y`（自动批准）、`-m <model>`。已实测可用。
- 参考项目 `claude-cursor-skill` 因 Cursor 只有 SDK 而写了 TypeScript 包装 CLI；kimi 本身就是 CLI，因此本项目采用更轻的形态。
- kimi `-p` 模式输出包含思考行（`• ` 前缀）和尾部 "To resume this session" 提示行。

## 3. 方案选型

三个候选方案：

- **A. 零构建 Node 脚本 + 模板文件（选定）**：单文件零依赖 Node 脚本做参数解析、模板填空、子进程调用；模板是 markdown 文件。代码保证 prompt 拼装确定性，无构建链、无 node_modules。
- B. 完整 TypeScript CLI（对齐 cursor 项目结构）：类型安全、可 npm 发布，但内部逻辑很薄，构建链收益有限。
- C. 纯 SKILL.md + 模板：无代码，拼装仍由模型执行，不满足"固定化"核心诉求。

选 A：拿到 B 的确定性、避开 B 的维护成本。

## 4. 目录结构

```
claude-kimi-skill/
├── SKILL.md                  # skill 定义：触发条件、子命令用法、示例
├── bin/
│   └── kimi-agent.mjs        # 单文件零依赖 Node 脚本（ESM）
├── prompts/
│   ├── review-file.md        # 单文件/文档 review 模板
│   ├── review-plan.md        # plan-based review 模板
│   ├── review-diff.md        # diff review 模板
│   └── implement.md          # TDD 实现模板
├── test/
│   └── kimi-agent.test.mjs   # node:test 测试
├── package.json              # 注册 bin 便于 npm link；无 dependencies
├── README.md
└── LICENSE
```

## 5. 数据流

1. Claude 识别到用户明确提到 kimi 且意图为 review/实现/编码任务。
2. Claude 通过 Bash 调用 `node <skill目录>/bin/kimi-agent.mjs <子命令> <参数>`。
3. 脚本读取对应模板，代码完成变量替换生成最终 prompt。
4. `execFile(KIMI_BIN, ['-p', prompt, '-y', ...])` 在目标项目目录执行（非 shell 调用，无转义问题）。
5. kimi 输出实时流回 stdout，Claude 读取结果向用户汇报；`--output` 时同时落盘。

## 6. CLI 接口

```bash
kimi-agent review <file> [--focus "关注点"] [--output <file>]
kimi-agent review-plan <plan文件> [--scope <目录/文件...>] [--output <file>]
kimi-agent review-diff [<git range>] [--output <file>]    # 不带 range 默认 review 未提交变更
kimi-agent implement "<需求描述>" [--scope <目录>] [--plan <设计文档>]
kimi-agent run "<自由prompt>"

# 通用选项
--model <m>      # 透传 kimi -m
--timeout <sec>  # 默认 600，超时 kill
--cwd <dir>      # 默认当前目录
```

五类任务：文件/文档 review、plan-based review、diff review、TDD 实现、自由任务透传（`run` 不套模板，直接把 prompt 交给 kimi）。

权限模式：所有子命令统一 `kimi -y` 全自动执行；review 类靠模板中写死的"只读"约束保证不改文件。

## 7. Prompt 模板设计

模板是普通 markdown 文件，占位符 `{{VAR}}`。脚本处理规则：

- **必填变量**缺失：报错退出（exit 2）。
- **可选变量**未提供：占位符所在的独立段落整体删除（占位段落约定独占一段）。

| 模板 | 必填变量 | 可选变量 | 核心约束 |
|------|---------|---------|---------|
| review-file | `TARGET_FILE` | `FOCUS` | 只读；Critical/Warning/Suggestion 分级；每条问题带 位置+描述+建议 |
| review-plan | `PLAN_FILE` | `SCOPE`（默认全仓库） | 只读；逐条对照设计文档检查实现完整性/一致性 |
| review-diff | `DIFF_RANGE`（脚本始终填入：用户给的 range，或默认值"未提交变更"） | `FOCUS` | 只读；聚焦变更本身及其影响面 |
| implement | `TASK` | `SCOPE`、`PLAN_FILE` | 强制 TDD：先写失败测试→实现→跑通；遵循项目现有风格 |

所有模板共同要求：先阅读项目 README/CLAUDE.md（如存在）了解项目约定；以 markdown 输出最终报告；review 类模板明确"不要修改、创建或删除任何文件"。

## 8. 错误处理

| 场景 | 处理 |
|------|------|
| kimi 命令不存在 | 报错并提示安装/登录方式，exit 1 |
| 未知子命令 / 缺参数 / 必填变量缺失 | 打印 usage，exit 2 |
| 目标文件/plan 文件不存在 | 调 kimi 前预检查，快速失败 |
| review-diff 不在 git 仓库或 range 无效 | 预检查 `git rev-parse`，清晰报错 |
| 超时（默认 600s） | kill kimi 进程，报超时，exit 1 |
| kimi 非零退出 | 透传 stderr 与退出码 |
| `--output` 落盘 | 实时转发 stdout 的同时捕获；写文件时过滤思考行（`• ` 前缀）和 "To resume this session" 尾行，只保留报告正文 |

不做自动重试：kimi 是本地 CLI，失败通常源于配置/登录问题，重试无意义（与 cursor 项目针对网络 API 的重试策略不同）。

kimi 可执行文件解析顺序：`KIMI_BIN` 环境变量 → PATH 中的 `kimi`。

## 9. SKILL.md 触发设计

- **触发**：仅当用户明确提到 "kimi" 且意图为 review/实现/编码任务，如"用kimi review这个文件"、"让kimi实现登录功能"、"用kimi检查一下这个PR"。
- **不触发**：未提 kimi 的 review/开发请求（Claude 自行处理）；浏览器/网页类请求（归 `kimi-webbridge` skill）。
- skill 命名 `kimi-agent`，与 `kimi-webbridge` 区分。
- SKILL.md 含意图→子命令映射表（如"review这个PR/这次改动" → `review-diff`）与各子命令示例。

## 10. 输出约定

- 默认：kimi 的 review/执行结果实时回传到 stdout，Claude 在对话中提炼汇报。
- 用户要求存档时：Claude 传 `--output <file>` 落盘 markdown 报告。
- 不自动落盘。

## 11. 测试策略

框架：`node:test`（零依赖）。

- **单元测试**：参数解析；模板变量替换（必填缺失报错、可选段落删除）；kimi 命令行参数构造。
- **集成测试**：通过 `KIMI_BIN` 指向 stub 脚本冒充 kimi，端到端验证 子命令 → 最终 prompt 内容 → 参数传递 → 输出过滤，不依赖真实 kimi。
- **冒烟（手动）**：`kimi-agent run "回复ok"` 走一次真实 kimi。

## 12. 明确不做（YAGNI）

- 不做自动重试。
- 不做会话续接（每次调用都是一次性 `kimi -p`）。
- 不做 TypeScript / 构建链 / 运行时依赖。
- 不做 review 结果自动归档目录。
- v1 不做 npm 发布（package.json 仅为 npm link 与元数据服务）。
