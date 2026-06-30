import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import exifr from "exifr";

async function callLlm(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  const apiEndpoint = process.env.LLM_API_ENDPOINT || "https://api.openai.com/v1/chat/completions";
  const model = process.env.LLM_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY or LLM_API_KEY environment variable is not set");
    process.exit(1);
  }

  const messages = [
    { role: "system", content: "你是一个历史事件提取专家。请根据用户描述，提取出一系列有序的时间线事件。返回格式是严格的JSON数组，不要有任何额外解释。" },
    { role: "user", content: prompt },
  ];

  try {
    const response = await fetch(apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error(`Error calling LLM: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

interface TimelineEvent {
  start_date: {
    year: number;
    month?: number;
    day?: number;
  };
  end_date?: {
    year: number;
    month?: number;
    day?: number;
  };
  text: {
    headline: string;
    text: string;
  };
  media?: {
    url: string;
    caption?: string;
    credit?: string;
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Read the earliest available timestamp from file system + EXIF metadata.
 * For images/videos: checks EXIF DateTimeOriginal, DateTime, ModifyDate, then fs stats.
 * For other files: uses the earliest of ctime/mtime. */
async function getEarliestFileTime(filepath: string): Promise<string> {
  const stat = fs.statSync(filepath);
  const candidates: Date[] = [
    new Date(stat.ctime),
    new Date(stat.mtime),
  ];
  // birthtime is available on some platforms
  if (stat.birthtimeMs) {
    candidates.push(new Date(stat.birthtime));
  }

  const ext = path.extname(filepath).toLowerCase();
  const isMedia = IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);

  if (isMedia) {
    try {
      const tags = await exifr.parse(filepath, {
        tiff: true,
        xmp: true,
        icc: false,
        iptc: true,
        jfif: true,
        ihdr: false,
      });
      if (tags) {
        // Try common EXIF date fields in priority order
        const dateFields = [
          tags.DateTimeOriginal,
          tags.CreateDate,
          tags.TrackCreateDate,
          tags.MediaCreateDate,
          tags.ModifyDate,
          tags.DateTime,
          tags.DateTimeDigitized,
        ];
        for (const d of dateFields) {
          if (d) {
            const parsed = d instanceof Date ? d : new Date(d);
            if (!isNaN(parsed.getTime())) candidates.push(parsed);
          }
        }
      }
    } catch {
      // EXIF read failed, fall back to fs stats
    }
  }

  // Return the earliest valid date
  let earliest = candidates[0];
  for (const d of candidates) {
    if (d < earliest) earliest = d;
  }
  return earliest.toISOString().slice(0, 19).replace("T", " ");
}

function parseDate(dateStr: string): { year: number; month?: number; day?: number } {
  const match = dateStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) {
    return {
      year: parseInt(match[1]),
      month: parseInt(match[2]),
      day: parseInt(match[3]),
    };
  }
  const dt = new Date(dateStr);
  return {
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
  };
}

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".html", ".htm", ".json", ".xml", ".csv"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogg", ".mov", ".avi", ".mkv"]);

function isTextFile(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function isImageFile(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function isVideoFile(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function generateTimelineHtml(events: TimelineEvent[], outputPath: string, title: string): void {
  const timelineJson = {
    title: {
      text: {
        headline: title,
        text: "基于文件内容生成的交互式时间线",
      },
    },
    events,
  };

  const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link title="timeline-styles" rel="stylesheet" href="https://cdn.knightlab.com/libs/timeline3/latest/css/timeline.css">
    <style>
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .timeline-header {
            background: #1a1a2e;
            color: #eaeaea;
            padding: 24px 32px;
            text-align: center;
        }
        .timeline-header h1 {
            margin: 0;
            font-size: 28px;
            font-weight: 600;
            letter-spacing: 0.5px;
        }
        .timeline-header p {
            margin: 6px 0 0;
            font-size: 14px;
            color: #999;
        }
        #timeline-embed { width: 100%; height: 700px; }
    </style>
</head>
<body>
    <div class="timeline-header">
        <h1>${title}</h1>
        <p>基于文件内容生成的交互式时间线</p>
    </div>
    <div id='timeline-embed'></div>

    <script src="https://cdn.knightlab.com/libs/timeline3/latest/js/timeline.js"></script>
    <script type="text/javascript">
        var timeline_json = ${JSON.stringify(timelineJson, null, 2)};
        window.timeline = new TL.Timeline('timeline-embed', timeline_json, {
            language: 'zh',
            start_at_end: false,
            timenav_height: 200
        });
    </script>
</body>
</html>`;

  fs.writeFileSync(outputPath, htmlContent, "utf-8");
}

/** Strip HTML tags and decode common URL entities to get plain text */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|li|h[1-6]|tr|table|section|main|footer|header|nav|article|aside|ul|ol|blockquote|details|summary|form|fieldset|legend|thead|tbody|tfoot)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(parseInt(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract timeline events from text content using pattern matching */
function extractEventsFromContent(content: string, sourceUrl: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const seen = new Set<string>();

  const jpDateRegex = /(\d{4})年(\d{1,2})月(\d{1,2})日/g;
  const jpMonthRegex = /(\d{4})年(\d{1,2})月/g;
  const jpYearRegex = /(\d{4})年/g;
  const yearStartRegex = /(?:^|[^0-9])(\d{4})\s+([A-Z][A-Za-z\s,.'\-:;()]{20,})/g;

  function addEvent(year: number, month: number | undefined, day: number | undefined, headline: string, text: string) {
    const key = `${year}-${month}-${day}-${headline.slice(0, 50)}`;
    if (!seen.has(key) && year > 1900 && year < 2100) {
      const noisePatterns = [
        /all rights reserved/i,
        /privacy/i,
        /cookie/i,
        /copyright/i,
        /^skip to main content/i,
        /the strong\./i,
      ];
      if (noisePatterns.some(p => p.test(headline) || p.test(text))) return;
      seen.add(key);
      events.push({
        start_date: { year, month, day },
        text: { headline: headline.slice(0, 120), text: text.slice(0, 500) },
        media: { url: sourceUrl },
      });
    }
  }

  // Japanese dates: YYYY年MM月DD日
  for (const m of content.matchAll(jpDateRegex)) {
    const year = parseInt(m[1]);
    const month = parseInt(m[2]);
    const day = parseInt(m[3]);
    const idx = m.index!;
    const start = Math.max(0, idx - 50);
    const end = Math.min(content.length, idx + m[0].length + 150);
    const context = content.slice(start, end).trim();
    const beforeContext = content.slice(Math.max(0, idx - 100), idx).trim();
    const headline = beforeContext.split(/[\n!!]/).pop()?.trim() || `${year}年${month}月${day}日`;
    addEvent(year, month, day, headline.replace(/\s+/g, " "), context.replace(/\s+/g, " "));
  }

  // Japanese month: YYYY年MM月
  for (const m of content.matchAll(jpMonthRegex)) {
    const year = parseInt(m[1]);
    const month = parseInt(m[2]);
    const idx = m.index!;
    if (content.slice(idx, idx + m[0].length + 3).match(/\d{1,2}日/)) continue;
    const start = Math.max(0, idx - 50);
    const end = Math.min(content.length, idx + m[0].length + 150);
    const context = content.slice(start, end).trim();
    const beforeContext = content.slice(Math.max(0, idx - 100), idx).trim();
    const headline = beforeContext.split(/[\n!!]/).pop()?.trim() || `${year}年${month}月`;
    addEvent(year, month, undefined, headline.replace(/\s+/g, " "), context.replace(/\s+/g, " "));
  }

  // Japanese year: YYYY年
  for (const m of content.matchAll(jpYearRegex)) {
    const year = parseInt(m[1]);
    const idx = m.index!;
    if (content.slice(idx, idx + m[0].length + 3).match(/\d{1,2}月/)) continue;
    const start = Math.max(0, idx - 50);
    const end = Math.min(content.length, idx + m[0].length + 200);
    const context = content.slice(start, end).trim();
    const beforeContext = content.slice(Math.max(0, idx - 100), idx).trim();
    const headline = beforeContext.split(/[\n!!]/).pop()?.trim() || `${year}年`;
    addEvent(year, undefined, undefined, headline.replace(/\s+/g, " "), context.replace(/\s+/g, " "));
  }

  // English year-start: "1980 A missing slice..."
  for (const m of content.matchAll(yearStartRegex)) {
    const year = parseInt(m[1]);
    const description = m[2].trim().replace(/\s+/g, " ");
    const headline = description.slice(0, 80).replace(/\.$/, "").trim();
    addEvent(year, undefined, undefined, headline, description);
  }

  return events;
}

interface LlmPendingEvent {
  type: 'llm_pending';
  prompt: string;
}

function isLlmPendingEvent(event: TimelineEvent | LlmPendingEvent): event is LlmPendingEvent {
  return (event as LlmPendingEvent).type === 'llm_pending';
}

async function processFile(filepath: string): Promise<(TimelineEvent | LlmPendingEvent)[]> {
  const filename = path.basename(filepath);
  const fileUrl = `file:///${filepath.replace(/\\/g, "/")}`;

  if (isTextFile(filepath)) {
    try {
      let content = fs.readFileSync(filepath, "utf-8");
      const ext = path.extname(filepath).toLowerCase();
      if (ext === ".html" || ext === ".htm") {
        content = stripHtml(content);
      }

      const llmPrompt = `请从以下文本中提取时间线事件。

要求：
1. 识别所有具有时间信息的事件
2. 每个事件包含：年份、月份（可选）、日期（可选）、标题、描述
3. 如果有持续时间，提供开始和结束时间

返回格式：
{
  "events": [
    {
      "year": 年份,
      "month": 月份（可选）,
      "day": 日（可选）,
      "end_year": 结束年份（可选）,
      "end_month": 结束月份（可选）,
      "end_day": 结束日（可选）,
      "headline": "事件标题",
      "text": "事件描述"
    }
  ]
}

文本内容：
---
${content.slice(0, 3000)}
---`;

      return [{ type: 'llm_pending', prompt: llmPrompt }];
    } catch {
      return [];
    }
  }

  // For images, videos, and other files: read the earliest timestamp from EXIF + fs metadata
  const earliestTime = await getEarliestFileTime(filepath);
  const stat = fs.statSync(filepath);
  const sizeReadable = formatSize(stat.size);

  if (isImageFile(filepath)) {
    return [{
      start_date: parseDate(earliestTime),
      text: {
        headline: filename,
        text: `<p>大小: ${sizeReadable}</p><p>时间: ${earliestTime}</p>`,
      },
      media: {
        url: fileUrl,
        caption: filename,
      },
    }];
  }

  if (isVideoFile(filepath)) {
    return [{
      start_date: parseDate(earliestTime),
      text: {
        headline: filename,
        text: `<p>大小: ${sizeReadable}</p><p>时间: ${earliestTime}</p><video controls src="${fileUrl}" style="max-width: 100%;"></video>`,
      },
    }];
  }

  return [{
    start_date: parseDate(earliestTime),
    text: {
      headline: filename,
      text: `<p>类型: 其他文件</p><p>大小: ${sizeReadable}</p><p>时间: ${earliestTime}</p><p><a href="${fileUrl}" target="_blank">打开文件</a></p>`,
    },
  }];
}

async function processInput(inputPath: string): Promise<(TimelineEvent | LlmPendingEvent)[]> {
  const events: (TimelineEvent | LlmPendingEvent)[] = [];

  if (fs.existsSync(inputPath)) {
    if (fs.statSync(inputPath).isDirectory()) {
      const files = fs.readdirSync(inputPath);
      for (const file of files) {
        const filepath = path.join(inputPath, file);
        if (fs.statSync(filepath).isFile()) {
          events.push(...await processFile(filepath));
        }
      }
    } else {
      events.push(...await processFile(inputPath));
    }
  }

  return events;
}

function printUsage(exitCode = 0): never {
  console.log(`Timeline Generator

Usage:
  npx -y bun main.ts <input> [input2] ... [options]

Inputs:
  File paths or directories. Multiple inputs are supported.

Options:
  --output <path>   Output HTML file path. Default: timeline.html
  --title <text>    Timeline title. Default: 时间线
  --help            Show this help

Examples:
  npx -y bun main.ts article.md
  npx -y bun main.ts ./documents/
  npx -y bun main.ts file1.txt file2.md --output my_timeline.html --title "项目时间线"

Output:
  HTML file with interactive timeline using TimelineJS3.
`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage(0);
  }

  const inputPaths: string[] = [];
  let outputPath = "timeline.html";
  let title = "时间线";
  let llmEventsJson: string | null = null;
  let prompt = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output") {
      outputPath = args[++i];
    } else if (arg.startsWith("--output=")) {
      outputPath = arg.slice(9);
    } else if (arg === "--title") {
      title = args[++i];
    } else if (arg.startsWith("--title=")) {
      title = arg.slice(8);
    } else if (arg === "--llm-events-file") {
      llmEventsJson = fs.readFileSync(args[++i], "utf-8");
    } else if (arg.startsWith("--llm-events-file=")) {
      llmEventsJson = fs.readFileSync(arg.slice(16), "utf-8");
    } else if (arg === "--llm-events") {
      llmEventsJson = args[++i];
    } else if (arg.startsWith("--llm-events=")) {
      llmEventsJson = arg.slice(11);
    } else if (arg === "--prompt") {
      prompt = args[++i];
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice(9);
    } else {
      inputPaths.push(arg);
    }
  }

  const allEvents: TimelineEvent[] = [];

  if (prompt) {
    const llmPrompt = `请根据用户描述"${prompt}"，提取出一系列有序的时间线事件。
请返回一个 JSON 对象，格式如下：
{
  "events": [
    {
      "year": 年份(数字),
      "month": 月份(数字，可选),
      "day": 日(数字，可选),
      "end_year": 结束年份(数字，可选),
      "end_month": 结束月份(数字，可选),
      "end_day": 结束日(数字，可选),
      "headline": "事件标题(120字内)",
      "text": "事件描述(500字内)"
    }
  ]
}
请直接返回 JSON，不要任何多余的解释。`;

    const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
    
    if (apiKey) {
      console.error(`正在调用 LLM 解析提示词: ${prompt}`);
      const llmResponse = await callLlm(llmPrompt);
      
      try {
        const result = JSON.parse(llmResponse);
        const llmEvents = result.events || result;
        
        for (const ev of llmEvents) {
          const event: TimelineEvent = {
            start_date: { year: ev.year, month: ev.month ?? undefined, day: ev.day ?? undefined },
            text: { headline: ev.headline, text: ev.text },
          };
          if (ev.end_year) {
            event.end_date = { year: ev.end_year, month: ev.end_month ?? undefined, day: ev.end_day ?? undefined };
          }
          allEvents.push(event);
        }
      } catch (e) {
        console.error(`Error: Failed to parse LLM response: ${e}`);
        process.exit(1);
      }
    } else {
      const instructions = {
        needsLlmExtraction: true,
        prompt: llmPrompt,
      };
      console.error(JSON.stringify(instructions, null, 2));
      process.exit(1);
    }
  }

  if (inputPaths.length === 0 && !llmEventsJson && !prompt) {
    console.error("Error: No input specified");
    printUsage(1);
  }

  // Parse externally extracted events if provided (e.g., from LLM)
  if (llmEventsJson) {
    try {
      const llmEvents = JSON.parse(llmEventsJson) as Array<{
        year: number; month?: number | null; day?: number | null;
        end_year?: number | null; end_month?: number | null; end_day?: number | null;
        headline: string; text: string;
      }>;
      for (const ev of llmEvents) {
        const event: TimelineEvent = {
          start_date: { year: ev.year, month: ev.month ?? undefined, day: ev.day ?? undefined },
          text: { headline: ev.headline, text: ev.text },
        };
        if (ev.end_year) {
          event.end_date = { year: ev.end_year, month: ev.end_month ?? undefined, day: ev.end_day ?? undefined };
        }
        allEvents.push(event);
      }
    } catch (e) {
      console.error(`Error: Failed to parse --llm-events-file JSON: ${e}`);
      process.exit(1);
    }
  }

  const finalEvents: TimelineEvent[] = [...allEvents];
  const llmPrompts: string[] = [];

  for (const inputPath of inputPaths) {
    const resolved = path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
    const inputEvents = await processInput(resolved);
    for (const e of inputEvents) {
      if (isLlmPendingEvent(e)) {
        llmPrompts.push(e.prompt);
      } else {
        finalEvents.push(e);
      }
    }
  }

  if (llmPrompts.length > 0) {
    const instructions = {
      needsLlmExtraction: true,
      prompt: llmPrompts.join("\n\n---\n\n"),
      inputPaths,
    };
    console.error(JSON.stringify(instructions, null, 2));
    process.exit(1);
  }

  if (finalEvents.length === 0) {
    console.error("Error: No extractable time events found in input files. Timeline requires at least a time + event.");
    process.exit(1);
  }

  // Sort all events by date
  finalEvents.sort((a, b) => {
    const aYear = a.start_date.year;
    const bYear = b.start_date.year;
    if (aYear !== bYear) return aYear - bYear;
    const aMonth = a.start_date.month || 1;
    const bMonth = b.start_date.month || 1;
    if (aMonth !== bMonth) return aMonth - bMonth;
    const aDay = a.start_date.day || 1;
    const bDay = b.start_date.day || 1;
    return aDay - bDay;
  });

  generateTimelineHtml(finalEvents, outputPath, title);

  console.log(JSON.stringify({
    success: true,
    message: "时间线已生成",
    outputPath: path.resolve(outputPath),
    eventsCount: finalEvents.length,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
