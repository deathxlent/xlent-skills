---
name: xlent-trail
description: Creates map route visualizations from files and directories. Extracts GPS locations from images/videos and places from text files, clusters nearby points, and generates HTML with Leaflet + OpenStreetMap (no API key needed). Use when user says "trail", "地图显示", "轨迹", "路线", "位置".
version: 1.0.0
metadata:
  openclaw:
    homepage: https://github.com/xlent/xlent-skills#xlent-trail
    requires:
      anyBins:
        - bun
        - npx
---

# Trail 地图轨迹技能

## 功能描述
将文件中的地点信息解析出来，在地图上创建标记点，并按时间顺序连接成路线。

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
- trail
- 地图显示
- 轨迹
- 路线
- 位置

## 支持的输入类型
- 单个文件
- 多个文件
- 单个目录

## 处理流程

### Step 1: 收集输入
接收文件路径或目录作为输入。

### Step 2: 文件分类处理

#### 纯文本类 (txt, html, md)
通过地名词典匹配文本中的地点。**纯文本不要求包含时间信息**：
- 如果文本中有时间信息，则使用文本中的时间
- 如果文本中没有时间信息，则使用文件创建时间作为起点，按地名出现顺序每处递增10分钟分配时间
- 从文本中提取所有地名，按出现顺序生成路径点位

#### 图片、视频类
读取文件的EXIF GPS信息，如果有GPS坐标，在地图上显示标记点。

### Step 3: 点位聚合
当多个点位距离较近时（最大点位差的5%范围内），合并显示为一个标记点。

### Step 4: 生成地图HTML
使用 Leaflet + 高德瓦片生成交互式地图，无需 API 密钥。加 `--osm` 可切换为 OpenStreetMap 瓦片。

## 点位聚合规则
- 计算所有点位的最大纬度差和最大经度差
- 当两点之间的纬度差小于最大纬度差的5%且经度差小于最大经度差的5%时，合并为一个点位
- 聚合后的点位显示所有合并点位的内容

## Usage

```bash
${BUN_X} {baseDir}/scripts/main.ts <input> [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--output <path>` | Output HTML file path | trail.html |
| `--title <text>` | Map title | 地图轨迹 |
| `--osm` | Use OpenStreetMap tiles (default: Amap tiles) | Amap |
| `--cluster-threshold <percent>` | Cluster threshold percentage | 5 |
| `--nogroup` | Disable point clustering, show all markers | false |

**Examples:**

```bash
# 处理单个文件（Leaflet + 高德瓦片）
${BUN_X} {baseDir}/scripts/main.ts travel_diary.md

# 处理目录（使用 OpenStreetMap）
${BUN_X} {baseDir}/scripts/main.ts ./photos/ --osm

# 指定输出文件和标题
${BUN_X} {baseDir}/scripts/main.ts ./images/ --output my_trail.html --title "旅行轨迹"

# 显示所有点位，不聚合
${BUN_X} {baseDir}/scripts/main.ts travel_diary.md --nogroup
```

## Output

**File location**: Current working directory.

**JSON output to stdout:**

```json
{
  "success": true,
  "message": "地图轨迹已生成",
  "outputPath": "/path/to/trail.html",
  "pointsCount": 15,
  "clustersCount": 8
}
```
