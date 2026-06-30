# xLent Skills

A collection of CLI skills that transform files into rich interactive visualizations.

一组命令行技能，将文件转换为丰富的交互式可视化内容。

---

## Installation / 安装

### 方式一：克隆仓库（推荐）

```bash
# 克隆仓库
git clone https://github.com/deathxlent/xlent-skills.git
cd xlent-skills

# 使用 trail 技能生成地图轨迹
npx -y bun run skills/xlent-trail/scripts/main.ts ./photos/ --output my_trail.html --title "旅行轨迹"

# 使用 timeline 技能生成时间线
npx -y bun run skills/xlent-timeline/scripts/main.ts ./documents/ --output my_timeline.html --title "项目时间线"
```

### 方式二：直接运行（无需安装）

```bash
# 直接从 GitHub 运行 trail 技能，无需克隆
npx -y bun run https://raw.githubusercontent.com/deathxlent/xlent-skills/main/skills/xlent-trail/scripts/main.ts ./photos/ --output my_trail.html

# 直接从 GitHub 运行 timeline 技能
npx -y bun run https://raw.githubusercontent.com/deathxlent/xlent-skills/main/skills/xlent-timeline/scripts/main.ts ./documents/ --output my_timeline.html

# 查看帮助
npx -y bun run https://raw.githubusercontent.com/deathxlent/xlent-skills/main/skills/xlent-trail/scripts/main.ts --help
```

---

## Skills / 技能

### xlent-trail - 地图轨迹

Creates map route visualizations from files and directories. Extracts GPS locations from images/videos and places from text files, clusters nearby points, and generates HTML with Leaflet (no API key needed).

从文件或目录创建地图路线可视化。从图片/视频中提取 GPS 坐标，从文本文件中匹配地名，聚合附近点位，使用 Leaflet 生成交互式地图（无需 API 密钥）。

**Features / 特性：**
- ✅ GPS 轨迹动画播放（支持暂停、调速、循环）
- ✅ 点击点位设置播放起点
- ✅ 点位聚合与单独显示模式
- ✅ 支持自然语言提示（通过 LLM 提取地点）

**Trigger words / 触发词：** `trail`, `地图显示`, `轨迹`, `路线`, `位置`

**Supported input / 支持输入：**

| Type / 类型 | Processing / 处理方式 |
|------|-----------|
| Text files (txt, md, html) | Matches place names from gazetteer; assigns times from text or auto-increments by 10 min |
| 文本文件 | 通过地名词典匹配地名；使用文本中的时间或按 10 分钟递增自动分配 |
| Images & videos / 图片视频 | Reads EXIF GPS coordinates and capture time |
| | 读取 EXIF GPS 坐标和拍摄时间 |

**Point clustering / 点位聚合：** Nearby points within 5% of the max lat/lng spread are merged into a single marker.

附近点位（在最大经纬度差的 5% 范围内）合并为一个标记。

**Usage / 用法：**

```bash
# Single file (Amap tiles, default)
npx -y bun run skills/xlent-trail/scripts/main.ts travel_diary.md

# Directory with OpenStreetMap tiles
npx -y bun run skills/xlent-trail/scripts/main.ts ./photos/ --osm

# Custom output and title
npx -y bun run skills/xlent-trail/scripts/main.ts ./images/ --output my_trail.html --title "旅行轨迹"

# Show all markers, no clustering / 显示所有点位，不聚合
npx -y bun run skills/xlent-trail/scripts/main.ts travel_diary.md --nogroup

# Use externally extracted events (from LLM)
npx -y bun run skills/xlent-trail/scripts/main.ts --events-file events.json --title "四渡赤水"

# Natural language prompt (requires LLM integration)
npx -y bun run skills/xlent-trail/scripts/main.ts --prompt "生成丝绸之路的路线地图"
```

**Options / 选项：**

| Option / 选项 | Description / 描述 | Default / 默认 |
|--------|-------------|---------|
| `--output <path>` | Output HTML file path / 输出文件路径 | `trail.html` |
| `--title <text>` | Map title / 地图标题 | `地图轨迹` |
| `--osm` | Use OpenStreetMap tiles | Amap tiles / 高德瓦片 |
| `--cluster-threshold <percent>` | Cluster threshold percentage / 聚合阈值百分比 | `5` |
| `--nogroup` | Disable point clustering, show all markers / 禁用点位聚合，显示所有标记 | `false` |
| `--events-file <path>` | JSON file with pre-extracted place data / 预提取地点数据的 JSON 文件 | — |
| `--prompt <text>` | Natural language prompt for LLM extraction / 用于 LLM 提取的自然语言提示 | — |

---

### xlent-timeline - 时间线

Creates interactive timeline visualizations from files and directories. Parses dates from text files, extracts metadata for media files, and generates HTML using TimelineJS3. Input files must contain extractable time information; location-only data is skipped.

从文件或目录创建交互式时间线可视化。从文本文件中解析日期，从媒体文件中提取元数据，使用 TimelineJS3 生成 HTML。输入文件必须包含可提取的时间信息，纯地点数据将被跳过。

**Features / 特性：**
- ✅ 图片/视频读取 EXIF 创建时间
- ✅ 多文件合并为单一时间线
- ✅ 支持自然语言提示（通过 LLM 提取事件）

**Trigger words / 触发词：** `timeline`, `时间线`, `时间轴`, `历史事件`

**Supported input / 支持输入：**

| Type / 类型 | Processing / 处理方式 |
|------|-----------|
| Text files (txt, md, html) | Parses dates and events; skips files with no extractable time |
| 文本文件 | 解析日期和事件；无可提取时间的文件将被跳过 |
| Images & videos / 图片视频 | Reads EXIF DateTimeOriginal as start time |
| | 读取 EXIF 原始拍摄时间作为起始时间 |
| Other files / 其他文件 | Displays filename, size, and metadata |
| | 显示文件名、大小和元数据 |

**Usage / 用法：**

```bash
# Single file / 单个文件
npx -y bun run skills/xlent-timeline/scripts/main.ts article.md

# Directory / 目录
npx -y bun run skills/xlent-timeline/scripts/main.ts ./documents/

# Multiple files with custom title / 多文件 + 自定义标题
npx -y bun run skills/xlent-timeline/scripts/main.ts file1.txt file2.md --output my_timeline.html --title "项目时间线"

# With externally extracted events (e.g. from LLM) / 使用外部提取的事件
npx -y bun run skills/xlent-timeline/scripts/main.ts --llm-events-file events.json --title "西游记"

# Natural language prompt (requires LLM integration)
npx -y bun run skills/xlent-timeline/scripts/main.ts --prompt "生成中国历史朝代时间线"
```

**Options / 选项：**

| Option / 选项 | Description / 描述 | Default / 默认 |
|--------|-------------|---------|
| `--output <path>` | Output HTML file path / 输出文件路径 | `timeline.html` |
| `--title <text>` | Timeline title / 时间线标题 | `时间线` |
| `--llm-events-file <path>` | JSON file with externally extracted events / 外部提取事件的 JSON 文件 | — |
| `--prompt <text>` | Natural language prompt for LLM extraction / 用于 LLM 提取的自然语言提示 | — |

---

## Requirements / 环境要求

- [Node.js](https://nodejs.org/) (provides `npx`) - 已安装在系统中
- [Bun](https://bun.sh/) - `npx -y bun` 会自动下载最新版本

---

## Project Structure / 项目结构

```
xlent-skills/
  skills/
    xlent-trail/          # Map trail visualization skill / 地图轨迹技能
      SKILL.md            # Skill definition / 技能定义
      scripts/
        main.ts           # Entry point / 入口
    xlent-timeline/       # Timeline visualization skill / 时间线技能
      SKILL.md            # Skill definition / 技能定义
      scripts/
        main.ts           # Entry point / 入口
  test_data/              # Sample test files / 测试数据
  package.json
  README.md
```

---

## Release Notes / 更新日志

### v1.0.0
- ✅ trail 技能：支持 GPS 轨迹动画播放
- ✅ trail 技能：支持点击点位设置播放起点
- ✅ trail 技能：支持变速播放（1x/2x/4x/8x）
- ✅ timeline 技能：图片读取 EXIF 创建时间
- ✅ 支持自然语言提示（--prompt 参数）
- ✅ 支持外部事件数据（--events-file / --llm-events-file）
- ✅ 中英双语文档

---

## License / 许可证

MIT License
