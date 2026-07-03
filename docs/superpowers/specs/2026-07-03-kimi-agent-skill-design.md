# kimi-agent Skill 设计文档

日期：2026-07-03
状态：Pending review（设计对话中已批准，书面 spec 待用户审阅；已吸收 cursor 评审的 P0/P1 意见）

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
4. `spawn(KIMI_BIN, ['-p', prompt, ...])` 在目标项目目录执行（参数数组、非 shell 调用，无转义问题；用 spawn 而非 execFile 是为了 tee 流式转发 stdout）。**冒烟修订**：不传 `-y`——kimi 的 `-p` 模式不能与 `-y`/`--auto` 组合（CLI 直接报错），且 `-p` 模式本身默认自动批准所有操作，权限语义与原设计等同。
5. kimi 输出实时流回 stdout，Claude 读取结果向用户汇报；`--output` 时同时落盘。

## 6. CLI 接口

```bash
kimi-agent review <file> [--focus "关注点"] [--output <file>]
kimi-agent review-plan <plan文件> [--scope <路径>]... [--output <file>]
kimi-agent review-diff [<git range>] [--focus "关注点"] [--output <file>]    # 不带 range 默认 review 未提交变更
kimi-agent implement "<需求描述>" [--scope <路径>]... [--plan <设计文档>]
kimi-agent run "<自由prompt>"

# 通用选项
--model <m>      # 透传 kimi -m
--timeout <sec>  # 默认 600，超时 kill
--cwd <dir>      # 默认当前目录
--dry-run        # 只打印最终 prompt 与将执行的 kimi 命令行，不实际调用（调试用）
```

五类任务：文件/文档 review、plan-based review、diff review、TDD 实现、自由任务透传（`run` 不套模板，直接把 prompt 交给 kimi）。

**参数语义细则**：

- `--scope` 可重复出现，多个值在模板中拼接为换行的 `- <路径>` 列表。
- `review-diff` 的 `<git range>` 接受任何 `git diff` 兼容的参数形式（如 `main..HEAD`、`main...HEAD`、单个 commit、`--cached`），原样嵌入模板文案；不传时默认为 `HEAD`（即 `git diff HEAD`，含工作区+暂存区全部未提交变更）。
- diff 内容**不嵌入 prompt**：模板只告诉 kimi 应执行的 diff 命令（如 `git diff HEAD`），由 kimi 自己在项目内执行查看。这同时规避了大 diff 撑爆 prompt/argv 长度的问题。
- `<file>`、`<plan文件>`、`--scope`、`--plan` 的路径在预检查时规范化为绝对路径，且必须位于 `--cwd` 目录子树内，越界即报错（exit 2）。
- **冒烟后修订**：`--output` 为通用选项（所有子命令可用，含 implement/run）；`--focus`/`--scope`/`--plan` 按子命令白名单校验（`--focus` 仅 review/review-diff，`--scope` 仅 review-plan/implement，`--plan` 仅 implement），不适用即 exit 2，防止静默无效。

**权限模式**：所有子命令统一走 kimi `-p` 非交互模式，该模式默认自动批准所有操作（冒烟修订：不传 `-y`，`-p` 与 `-y` 组合会被 kimi 拒绝，见第 5 节）。review 类的"只读"是 **prompt 级软约束**（模板写死"不要修改/创建/删除任何文件"），没有技术层面的强制——kimi 理论上仍可能误写文件，风险由 git 工作区兜底（可 diff 可回滚）。SKILL.md 与 README 中须明确披露这一点，并强调 `implement` 会修改仓库。kimi 只读/沙箱模式若后续版本提供，review 类应优先改用（记入 P2 迭代方向，v1 不做 review 前后 `git status` 快照对比）。

## 7. Prompt 模板设计

模板是普通 markdown 文件，占位符 `{{VAR}}`。模板文件路径解析：相对脚本自身位置，即 `dirname(fileURLToPath(import.meta.url))/../prompts/<名称>.md`，与调用时的 cwd 无关。

脚本处理规则：

- **必填变量**缺失：stderr 输出含变量名的错误信息，exit 2。
- **可选变量**未提供：删除对应的**可选块**。可选块的 markdown 约定：以 `{{#VAR}}` 独占一行开始、`{{/VAR}}` 独占一行结束；变量有值时去掉首尾标记行并替换块内 `{{VAR}}`，无值时整块（含标记行）删除。

before/after 示例（`--focus` 未提供时）：

```markdown
## Review 要求                      ## Review 要求
- 只读分析                          - 只读分析
{{#FOCUS}}                    →
## 重点关注                         ## 输出格式
{{FOCUS}}
{{/FOCUS}}

## 输出格式
```

`--focus "并发安全"` 提供时：

```markdown
## 重点关注
并发安全
```

`review-plan` 的 `SCOPE` 未提供时同样走可选块删除，模板中该块之外的正文已写死"评审范围为整个仓库，以下如列出具体范围则以其为准"，因此删除后语义自然回落到全仓库。

| 模板 | 必填变量 | 可选变量 | 核心约束 |
|------|---------|---------|---------|
| review-file | `TARGET_FILE` | `FOCUS` | 只读；Critical/Warning/Suggestion 分级；每条问题带 位置+描述+建议 |
| review-plan | `PLAN_FILE` | `SCOPE`（默认全仓库） | 只读；逐条对照设计文档检查实现完整性/一致性 |
| review-diff | `DIFF_RANGE`（由脚本生成：用户传的 range 或默认 `HEAD`；用户视角可选，模板视角始终有值） | `FOCUS` | 只读；聚焦变更本身及其影响面 |
| implement | `TASK` | `SCOPE`、`PLAN_FILE` | 强制 TDD：先写失败测试→实现→跑通；遵循项目现有风格 |

所有模板共同要求：先阅读项目 README/CLAUDE.md（如存在）了解项目约定；**报告使用中文撰写**、以 markdown 输出；review 类模板明确"不要修改、创建或删除任何文件"。

`implement` 模板额外要求 kimi 在报告末尾输出「验证摘要」：实际执行的测试命令及通过/失败计数。成功判定 = kimi 退出码为 0 **且**报告含验证摘要；缺少摘要时 Claude 应视为"实现未经验证"并向用户如实汇报。

## 8. 错误处理

| 场景 | 处理 |
|------|------|
| kimi 命令不存在 | 报错并提示安装/登录方式，exit 1 |
| 未知子命令 / 缺参数 / 必填变量缺失 | 打印 usage，exit 2 |
| 目标文件/plan 文件不存在 | 调 kimi 前预检查，快速失败 |
| review-diff 不在 git 仓库或 range 无效 | 预检查 `git rev-parse`，清晰报错 |
| 超时（默认 600s） | kill kimi 进程，报超时，exit 1 |
| kimi 非零退出 | 透传 stderr 与退出码 |
| 路径越界（目标不在 `--cwd` 子树内） | 预检查报错，exit 2 |
| `--output` 落盘 | tee 式双写：stdout **原样**实时转发（不过滤），同时缓冲一份，进程结束后过滤再写文件 |

**落盘过滤规则**（仅作用于 `--output` 文件，绝不影响 stdout；已按 2026-07-03 真实冒烟样本校准）：kimi `-p` 的真实输出把**每条消息**（思考与最终回复）都渲染为 `• ` 开头的块，续行缩进 2 空格，"To resume this session: kimi -r <id>" 可能直接粘在正文最后一个字符后。过滤算法：先正则删除 resume 提示（任意位置），然后取**最后一个 bullet 块**为最终报告（去掉首行 `• ` 前缀与续行的 2 空格缩进），无 bullet 块时保留全文兜底；最后压缩 3+ 连续空行并规范末尾换行。tee 转发遇下游管道关闭（EPIPE）时停止转发但继续缓冲，`--output` 仍正常落盘。

不做自动重试：kimi 是本地 CLI，失败通常源于配置/登录问题，重试无意义（与 cursor 项目针对网络 API 的重试策略不同）。

kimi 可执行文件解析顺序：`KIMI_BIN` 环境变量 → PATH 中的 `kimi`。

## 9. SKILL.md 触发设计

- **触发**：仅当用户明确提到 "kimi" 且意图为 review/实现/编码任务，如"用kimi review这个文件"、"让kimi实现登录功能"、"用kimi检查一下这个PR"。
- **不触发**：未提 kimi 的 review/开发请求（Claude 自行处理）；浏览器/网页类请求（归 `kimi-webbridge` skill）。
- skill 命名 `kimi-agent`，与 `kimi-webbridge` 区分。

**SKILL.md 最小规格**（必须包含的章节）：

1. **触发条件**：正例 + 反例（同上）。
2. **调用方式**：`node <skill基目录>/bin/kimi-agent.mjs <子命令> ...`。skill 加载时 Claude Code 会在 skill 内容前注入 "Base directory for this skill" 行，SKILL.md 指示 Claude 用该基目录拼出脚本绝对路径，不依赖 cwd。
3. **意图→子命令映射表**：

   | 用户说法 | 子命令 |
   |---------|--------|
   | review 某个文件/文档 | `review <file>` |
   | 对照设计文档/plan 检查实现 | `review-plan <plan>` |
   | review 这个 PR / 这次改动 / 提交前检查 | `review-diff` |
   | 实现/开发/加功能/加测试 | `implement "<需求>"` |
   | 其他明确指名 kimi 的编码相关任务（如"让 kimi 随便看看这个项目"） | `run "<prompt>"` |

   模糊意图默认路由：能对上前四行的优先用模板化子命令，对不上的才落到 `run`。
4. **各子命令示例命令行**。
5. **风险提示**：`implement` 会修改仓库文件；review 只读为 prompt 级软约束；`run` 仅用于模板覆盖不了的场景。

## 10. 输出约定

- 默认：kimi 的 review/执行结果实时回传到 stdout，Claude 在对话中提炼汇报。
- 用户要求存档时：Claude 传 `--output <file>` 落盘 markdown 报告。
- 不自动落盘。

## 11. 测试策略

框架：`node:test`（零依赖）。

- **单元测试**：参数解析；模板变量替换（必填缺失时 exit 2 且 stderr 含变量名；可选块有值/无值的快照对比，覆盖 `FOCUS`/`SCOPE`/`PLAN_FILE`）；kimi 命令行参数构造；`--scope` 多值拼接。
- **集成测试**（`KIMI_BIN` 指向 stub 脚本冒充 kimi）：子命令 → 最终 prompt 内容 → 参数传递；落盘过滤的混合边界样例（思考行 + 正文含 `• ` + resume 尾行）；`review-diff` 预检查三态（非 git 目录、非法 range、空 diff）；`--timeout` 触发后子进程确实被 kill（stub 内 sleep）；路径越界拒绝。
- **冒烟（手动）**：`kimi-agent run "回复ok"` 走一次真实 kimi；用真实输出样本校准落盘过滤规则的 fixture。

## 12. 明确不做（YAGNI）

- 不做自动重试。
- 不做会话续接（每次调用都是一次性 `kimi -p`）。
- 不做 TypeScript / 构建链 / 运行时依赖。
- 不做 review 结果自动归档目录。
- v1 不做 npm 发布（package.json 仅为 npm link 与元数据服务）。
- v1 不做多文件 review（`review` 仅接受单文件；多文件场景用 `review-plan --scope` 或 `review-diff` 覆盖）。
- v1 不做大 diff 截断/分片（diff 由 kimi 自行执行查看，不进 prompt；超大仓库场景在 README troubleshooting 提示）。
- v1 不做 review 前后 `git status` 快照对比、不做 kimi 只读沙箱（记为 P2 迭代方向）。
- 环境变量仅支持 `KIMI_BIN`；超时等一律走 CLI 参数，不设 `KIMI_AGENT_TIMEOUT` 之类的环境变量。

## 13. 评审记录

- 2026-07-03：cursor（composer 模型）对本 spec 做设计评审，结论"推荐批准进入实现"；其 P0/P1 意见（review-diff 默认范围、可选块语法、只读软约束披露、SKILL.md 规格、--output 过滤语义、implement 成功判定等）已全部并入上述章节，P2 项记入第 12 节迭代方向。
- 2026-07-03（实现后冒烟修订）：真实 kimi 冒烟发现三处与原设计不符，已修正并回写第 5、8 节——① `-p` 不能与 `-y` 组合且 `-p` 默认自动批准（移除 `-y`）；② 真实输出为 bullet 块格式（思考与回复同前缀），落盘过滤改为"取最后一个 bullet 块"；③ tee 遇 EPIPE 需防护。
