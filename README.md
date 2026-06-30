# xlent Skills

A collection of CLI skills for **Agent Info** that transform files into rich interactive visualizations.

一组用于 **Agent Info** 的命令行技能，将文件转换为丰富的交互式可视化内容。

**Demo / 演示**: https://github.com/deathxlent/xlent-skills-demo

---

## Integration with Agent Info / Agent 集成

### 安装到 Agent

1. **克隆仓库到 Agent 的 skills 目录**

```bash
cd /path/to/agent/skills
git clone https://github.com/deathxlent/xlent-skills.git
```

2. **配置技能**

在 Agent 的配置文件中添加以下技能定义：

```json
{
  "skills": [
    {
      "name": "xlent-trail",
      "description": "生成地图轨迹可视化",
      "triggerWords": ["trail", "地图显示", "轨迹", "路线", "位置"],
      "command": "npx -y bun run ${skillPath}/xlent-trail/scripts/main.ts",
      "inputType": ["file", "text"],
      "needsLlmExtraction": true
    },
    {
      "name": "xlent-timeline",
      "description": "生成交互式时间线",
      "triggerWords": ["timeline", "时间线", "时间轴", "历史事件"],
      "command": "npx -y bun run ${skillPath}/xlent-timeline/scripts/main.ts",
      "inputType": ["file", "text"],
      "needsLlmExtraction": true
    }
  ]
}
```

### Agent 使用方式

#### 方式一：上传文件

```
用户：分析我的旅行照片，生成路线地图
Agent：正在分析图片的 GPS 信息...
Agent：地图轨迹已生成 → trail.html
```

#### 方式二：自然语言描述

```
用户：生成红军四渡赤水的行进轨迹
Agent：正在提取地点信息...
Agent：地图轨迹已生成 → trail.html

用户：生成西游记八十一难的时间线
Agent：正在提取时间线事件...
Agent：时间线已生成 → timeline.html
```

---

## Skills / 技能

### xlent-trail - 地图轨迹

Creates map route visualizations from files and directories. Extracts GPS locations from images/videos and uses LLM to extract places from text files. Generates interactive HTML maps with Leaflet.

从文件或目录创建地图路线可视化。从图片/视频中提取 GPS 坐标，通过 LLM 从文本文件提取地点，使用 Leaflet 生成交互式地图。

**Features / 特性：**
- ✅ GPS 轨迹动画播放（支持暂停、调速 1x/2x/4x/8x、循环）
- ✅ 点击点位设置播放起点
- ✅ 点位聚合与单独显示模式
- ✅ 通过 Agent 的 LLM 提取文本中的地点信息

**Agent 触发词**: `trail`, `地图显示`, `轨迹`, `路线`, `位置`

**支持输入**:

| Type / 类型 | Processing / 处理方式 |
|------|-----------|
| Images & videos / 图片视频 | 读取 EXIF GPS 坐标和拍摄时间 |
| Text files / 文本文件 | 通过 Agent 的 LLM 提取地名和时间 |

**Options / 选项：**

| Option / 选项 | Description / 描述 | Default / 默认 |
|--------|-------------|---------|
| `--output <path>` | Output HTML file path / 输出文件路径 | `trail.html` |
| `--title <text>` | Map title / 地图标题 | `地图轨迹` |
| `--osm` | Use OpenStreetMap tiles | Amap tiles / 高德瓦片 |
| `--nogroup` | Disable point clustering / 禁用点位聚合 | `false` |
| `--events-file <path>` | JSON file with pre-extracted places / 预提取地点数据 | — |
| `--prompt <text>` | Natural language prompt / 自然语言提示 | — |

---

### xlent-timeline - 时间线

Creates interactive timeline visualizations from files and directories. Uses LLM to extract events from text files and reads EXIF metadata for media files. Generates HTML using TimelineJS3.

从文件或目录创建交互式时间线可视化。通过 LLM 从文本文件提取事件，从媒体文件读取 EXIF 元数据，使用 TimelineJS3 生成 HTML。

**Features / 特性：**
- ✅ 图片/视频读取 EXIF 创建时间
- ✅ 多文件合并为单一时间线
- ✅ 通过 Agent 的 LLM 提取文本中的时间线事件

**Agent 触发词**: `timeline`, `时间线`, `时间轴`, `历史事件`

**支持输入**:

| Type / 类型 | Processing / 处理方式 |
|------|-----------|
| Text files / 文本文件 | 通过 Agent 的 LLM 提取日期和事件 |
| Images & videos / 图片视频 | 读取 EXIF 原始拍摄时间作为起始时间 |
| Other files / 其他文件 | 显示文件名、大小和元数据 |

**Options / 选项：**

| Option / 选项 | Description / 描述 | Default / 默认 |
|--------|-------------|---------|
| `--output <path>` | Output HTML file path / 输出文件路径 | `timeline.html` |
| `--title <text>` | Timeline title / 时间线标题 | `时间线` |
| `--llm-events-file <path>` | JSON file with extracted events / 外部提取事件数据 | — |
| `--prompt <text>` | Natural language prompt / 自然语言提示 | — |

---

## LLM Extraction Protocol / LLM 提取协议

当技能需要 LLM 提取时，会输出以下格式的指令：

```json
{
  "needsLlmExtraction": true,
  "prompt": "提取指令..."
}
```

### Trail 数据格式

```json
{
  "route": [
    {
      "name": "地点名称",
      "description": "描述",
      "latitude": 39.9042,
      "longitude": 116.4074,
      "time": "2024-01-15 10:30"
    }
  ]
}
```

### Timeline 数据格式

```json
{
  "events": [
    {
      "year": 2024,
      "month": 1,
      "day": 15,
      "headline": "事件标题",
      "text": "事件描述"
    }
  ]
}
```

---

## Manual Usage / 手动使用（调试）

```bash
# 克隆仓库
git clone https://github.com/deathxlent/xlent-skills.git
cd xlent-skills

# Trail - 使用图片目录
npx -y bun run skills/xlent-trail/scripts/main.ts ./photos/ --output trail.html

# Trail - 使用预提取数据
npx -y bun run skills/xlent-trail/scripts/main.ts --events-file events.json --title "四渡赤水"

# Timeline - 使用文档目录
npx -y bun run skills/xlent-timeline/scripts/main.ts ./documents/ --output timeline.html

# Timeline - 使用预提取数据
npx -y bun run skills/xlent-timeline/scripts/main.ts --llm-events-file events.json --title "项目时间线"
```

---

## Requirements / 环境要求

- [Node.js](https://nodejs.org/) - 提供 `npx` 命令
- [Bun](https://bun.sh/) - `npx -y bun` 会自动下载
- **Agent Info** - 推荐在 Agent 环境中使用以获得完整的 LLM 集成

---

## Project Structure / 项目结构

```
xlent-skills/
  skills/
    xlent-trail/          # 地图轨迹技能
      SKILL.md            # 技能定义
      scripts/
        main.ts           # 入口文件
    xlent-timeline/       # 时间线技能
      SKILL.md            # 技能定义
      scripts/
        main.ts           # 入口文件
  test_data/              # 测试数据
  package.json
  README.md
```

---

## Release Notes / 更新日志

### v1.0.0
- ✅ trail 技能：GPS 轨迹动画播放，支持暂停、调速、循环
- ✅ trail 技能：点击点位设置播放起点
- ✅ timeline 技能：图片读取 EXIF 创建时间
- ✅ 完整的 Agent LLM 集成支持
- ✅ 中英双语文档

---

## License / 许可证

MIT License