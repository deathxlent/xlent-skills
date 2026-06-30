---
name: xlent-timeline
description: Creates interactive timeline visualizations from files and directories. Parses events with LLM for text files, extracts metadata for media files, and generates HTML using TimelineJS3. Use when user says "timeline", "时间线", "时间轴", "历史事件".
version: 1.0.0
metadata:
  openclaw:
    homepage: https://github.com/xlent/xlent-skills#xlent-timeline
    requires:
      anyBins:
        - bun
        - npx
---

# Timeline 时间线技能

## 功能描述
将文件或目录中的内容解析为时间线事件，生成交互式时间线可视化 HTML 页面。

## User Input Tools

When this skill prompts the user, follow this tool-selection rule (priority order):

1. **Prefer built-in user-input tools** exposed by the current agent runtime — e.g., `AskUserQuestion`, `request_user_input`, `clarify`, `ask_user`, or any equivalent.
2. **Fallback**: if no such tool exists, emit a numbered plain-text message and ask the user to reply with the chosen number/answer for each question.
3. **Batching**: if the tool supports multiple questions per call, combine all applicable questions into a single call; if only single-question, ask them one at a time in priority order.

Concrete `AskUserQuestion` references below are examples — substitute the local equivalent in other runtimes.

## Script Directory

**Agent Execution**: Determine this SKILL.md directory as `{baseDir}`. Resolve `${BUN_X}` runtime: if `bun` installed → `bun`; if `npx` available → `npx -y bun`; else suggest installing bun. Replace `{baseDir}` and `${BUN_X}` with actual values.

| Script | Purpose |
|--------|---------|
| `scripts/main.ts` | Main entry point |

## 触发条件
当用户提及以下关键词时触发：
- timeline
- 时间线
- 时间轴
- 历史事件

## 支持的输入类型
- 单个文件
- 多个文件
- 单个目录

## 处理流程

### Step 1: 收集输入
接收文件路径或目录作为输入。支持多个输入。

### Step 2: 文件分类处理

#### 纯文本类 (txt, html, md)
脚本自动解析文本中的时间事件：
- **日文格式**：匹配 `YYYY年MM月DD日`、`YYYY年MM月`、`YYYY年`
- **英文格式**：匹配 `年份 + 描述` 的段落（如 "1980 A missing slice..."）
- HTML 文件会先剥离标签再解析
- **无法解析时间则跳过该文件**：时间线必须有时间和事件，纯地点/无时间的数据不纳入

#### 图片、视频类
读取文件元信息，使用创建时间和最后修改时间作为时间范围，直接显示图片或视频播放器。

#### 其他类
读取文件元信息，显示文件名、大小等元数据。

### Step 3: 合并事件
所有输入文件的事件合并为一个时间线，按日期排序。

### Step 4: 生成时间线HTML
使用 TimelineJS3 生成交互式时间线页面，顶部显示标题栏。


## Usage

```bash
${BUN_X} {baseDir}/scripts/main.ts <input> [input2] ... [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--output <path>` | Output HTML file path | timeline.html |
| `--title <text>` | Timeline title | 时间线 |
| `--llm-events-file <path>` | JSON file with externally extracted events | — |

**Examples:**

```bash
# 处理单个文件
${BUN_X} {baseDir}/scripts/main.ts article.md

# 处理目录
${BUN_X} {baseDir}/scripts/main.ts ./documents/

# 处理多个文件
${BUN_X} {baseDir}/scripts/main.ts file1.txt file2.md --output my_timeline.html --title "项目时间线"

# 处理 URL（Agent 先抓取保存为文件）
${BUN_X} {baseDir}/scripts/main.ts ./temp/url_content.txt --title "网页时间线"
```

## Output

**File location**: Current working directory.

**JSON output to stdout:**

```json
{
  "success": true,
  "message": "时间线已生成",
  "outputPath": "/path/to/timeline.html",
  "eventsCount": 10
}
```
