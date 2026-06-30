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
    { role: "system", content: "你是一个地理信息提取专家。请根据用户描述，提取出一系列有序地点及其时间信息。返回格式是严格的JSON数组，不要有任何额外解释。" },
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

interface Point {
  filename: string;
  latitude: number | null;
  longitude: number | null;
  time: string;
  imageUrl?: string;
  videoUrl?: string;
  sourceUrl: string;
  description: string;
  clusterSize?: number;
  items?: Point[];
}

/** Read the earliest available timestamp from file system + EXIF metadata.
 * For images/videos: checks EXIF DateTimeOriginal, CreateDate, TrackCreateDate, MediaCreateDate, then fs stats.
 * For other files: uses the earliest of ctime/mtime. */
async function getEarliestFileTime(filepath: string): Promise<string> {
  const stat = fs.statSync(filepath);
  const candidates: Date[] = [
    new Date(stat.ctime),
    new Date(stat.mtime),
  ];
  if (stat.birthtimeMs) {
    candidates.push(new Date(stat.birthtime));
  }

  const ext = path.extname(filepath).toLowerCase();
  const isMedia = IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);

  if (isMedia) {
    try {
      const tags = await exifr.parse(filepath, {
        tiff: true, xmp: true, icc: false, iptc: true, jfif: true, ihdr: false,
      });
      if (tags) {
        const dateFields = [
          tags.DateTimeOriginal, tags.CreateDate, tags.TrackCreateDate,
          tags.MediaCreateDate, tags.ModifyDate, tags.DateTime, tags.DateTimeDigitized,
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

  let earliest = candidates[0];
  for (const d of candidates) {
    if (d < earliest) earliest = d;
  }
  return earliest.toISOString().slice(0, 19).replace("T", " ");
}

function getFileMetadata(filepath: string): { created: string; modified: string; size: number; sizeReadable: string } {
  const stat = fs.statSync(filepath);
  const ctime = new Date(stat.ctime);
  const mtime = new Date(stat.mtime);
  
  const bytes = stat.size;
  let sizeReadable: string;
  if (bytes < 1024) sizeReadable = `${bytes} B`;
  else if (bytes < 1024 * 1024) sizeReadable = `${(bytes / 1024).toFixed(2)} KB`;
  else sizeReadable = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  
  return {
    created: ctime.toISOString().slice(0, 19).replace("T", " "),
    modified: mtime.toISOString().slice(0, 19).replace("T", " "),
    size: bytes,
    sizeReadable,
  };
}

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".html", ".htm", ".json", ".xml"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);
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

function clusterPoints(points: Point[], thresholdPercent: number = 2): Point[] {
  if (points.length < 2) return points;
  
  const validPoints = points.filter(p => p.latitude !== null && p.longitude !== null);
  if (validPoints.length < 2) return points;
  
  const latitudes = validPoints.map(p => p.latitude!);
  const longitudes = validPoints.map(p => p.longitude!);
  
  const latRange = Math.max(...latitudes) - Math.min(...latitudes);
  const lonRange = Math.max(...longitudes) - Math.min(...longitudes);
  
  const thresholdLat = latRange * thresholdPercent / 100;
  const thresholdLon = lonRange * thresholdPercent / 100;
  
  const clusters: Point[] = [];
  const used = new Set<number>();
  
  for (let i = 0; i < validPoints.length; i++) {
    if (used.has(i)) continue;
    
    const point = validPoints[i];
    const cluster: Point[] = [point];
    used.add(i);
    
    for (let j = 0; j < validPoints.length; j++) {
      if (used.has(j)) continue;
      
      const other = validPoints[j];
      const latDiff = Math.abs(point.latitude! - other.latitude!);
      const lonDiff = Math.abs(point.longitude! - other.longitude!);
      
      if (latDiff <= thresholdLat && lonDiff <= thresholdLon) {
        cluster.push(other);
        used.add(j);
      }
    }
    
    if (cluster.length > 1) {
      const avgLat = cluster.reduce((sum, p) => sum + (p.latitude || 0), 0) / cluster.length;
      const avgLon = cluster.reduce((sum, p) => sum + (p.longitude || 0), 0) / cluster.length;
      
      clusters.push({
        filename: `${cluster.length}个点位`,
        latitude: avgLat,
        longitude: avgLon,
        time: cluster[0].time,
        sourceUrl: cluster[0].sourceUrl,
        description: `${cluster.length}个相关点位`,
        clusterSize: cluster.length,
        items: cluster,
      });
    } else {
      clusters.push(point);
    }
  }
  
  return clusters.sort((a, b) => a.time.localeCompare(b.time));
}

function generateMapHtml(points: Point[], outputPath: string, title: string, useOsm: boolean): void {
  const pointsJson = JSON.stringify(points, null, 2);
  const tileUrl = useOsm
    ? "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
    : "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}";
  const tileSubdomains = useOsm ? "abc" : "1234";
  const attribution = useOsm
    ? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    : '&copy; <a href="https://www.amap.com">高德地图</a>';

  const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
    <style>
        body { margin: 0; padding: 0; }
        #mapContainer { width: 100vw; height: 100vh; }
        .info-window-content { max-width: 300px; font-family: sans-serif; }
        .info-window-content img { max-width: 100%; max-height: 150px; }
        .info-window-content video { max-width: 100%; max-height: 150px; }
        .cluster-badge { background: #ff6b6b; color: white; border-radius: 50%; padding: 2px 8px; font-size: 12px; display: inline-block; }
        .leaflet-popup-content-wrapper { border-radius: 8px; }
        .trail-controls { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); z-index: 1000; display: flex; align-items: center; gap: 12px; background: rgba(0,0,0,0.75); backdrop-filter: blur(8px); padding: 10px 20px; border-radius: 30px; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .trail-controls button { background: none; border: 2px solid rgba(255,255,255,0.8); color: #fff; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
        .trail-controls button:hover { background: rgba(255,255,255,0.2); border-color: #fff; }
        .trail-progress { flex: 1; min-width: 120px; max-width: 260px; height: 4px; background: rgba(255,255,255,0.2); border-radius: 2px; overflow: hidden; }
        .trail-progress-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #3366FF, #00ccff); border-radius: 2px; }
        .trail-point-label { font-size: 13px; white-space: nowrap; min-width: 40px; text-align: center; }
        .trail-speed-btn { font-size: 11px; width: auto; padding: 0 8px; border-radius: 14px; height: 28px; border-width: 1px; }
    </style>
</head>
<body>
    <div id="mapContainer"></div>

    <div class="trail-controls" id="trailControls" style="display: none;">
        <button id="playBtn" title="Play/Pause">&#9654;</button>
        <div class="trail-progress"><div class="trail-progress-bar" id="progressBar"></div></div>
        <span class="trail-point-label" id="pointLabel">0/0</span>
        <button class="trail-speed-btn" id="speedBtn" title="Speed">1x</button>
    </div>

    <script type="text/javascript">
        var map = L.map('mapContainer', {
            center: [39.90923, 116.397428],
            zoom: 10
        });

        L.tileLayer('${tileUrl}', {
            attribution: '${attribution}',
            subdomains: '${tileSubdomains}',
            maxZoom: ${useOsm ? 19 : 18}
        }).addTo(map);

        var points = ${pointsJson};
        var routePoints = [];

        points.forEach(function(point) {
            if (point.latitude !== null && point.longitude !== null) {
                routePoints.push([point.latitude, point.longitude]);

                var content = '<div class="info-window-content">';
                if (point.clusterSize) {
                    content += '<div class="cluster-badge">' + point.clusterSize + ' 个点位</div>';
                    point.items.forEach(function(item) {
                        content += '<div style="margin-top: 10px;">';
                        content += '<h4>' + (item.filename || '未知') + '</h4>';
                        if (item.imageUrl) {
                            content += '<img src="' + item.imageUrl + '" />';
                        } else if (item.videoUrl) {
                            content += '<video controls src="' + item.videoUrl + '"></video>';
                        }
                        content += '<p>' + (item.time || '') + '</p>';
                        if (item.sourceUrl) {
                            content += '<a href="' + item.sourceUrl + '" target="_blank">打开源文件</a>';
                        }
                        content += '</div>';
                    });
                } else {
                    content += '<h4>' + (point.filename || '未知') + '</h4>';
                    if (point.imageUrl) {
                        content += '<img src="' + point.imageUrl + '" />';
                    } else if (point.videoUrl) {
                        content += '<video controls src="' + point.videoUrl + '"></video>';
                    }
                    content += '<p>' + (point.description || '') + '</p>';
                    content += '<p>' + (point.time || '') + '</p>';
                    if (point.sourceUrl) {
                        content += '<a href="' + point.sourceUrl + '" target="_blank">打开源文件</a>';
                    }
                }
                content += '</div>';

                var marker = L.marker([point.latitude, point.longitude]);
                marker.bindPopup(content);
                marker.addTo(map);
            }
        });

        // Base polyline
        if (routePoints.length > 1) {
            var baseLine = L.polyline(routePoints, {
                color: '#3366FF',
                weight: 3,
                opacity: 0.3
            }).addTo(map);
        }

        // Directional animation
        var isPlaying = false;
        var animIdx = 0;
        var subIdx = 0;
        var speedIdx = 0;
        var speeds = [1, 2, 4, 8];
        var animTimer = null;
        var animLine = null;
        var animMarker = null;
        var allMarkers = [];
        var startMarkerIdx = 0; // user-clicked marker index, defaults to 0

        var playBtn = document.getElementById('playBtn');
        var progressBar = document.getElementById('progressBar');
        var pointLabel = document.getElementById('pointLabel');
        var speedBtn = document.getElementById('speedBtn');
        var trailControls = document.getElementById('trailControls');

        // Collect all markers for popup access
        map.eachLayer(function(layer) {
            if (layer instanceof L.Marker && !(layer instanceof L.Marker && layer.options.zIndexOffset === 1000)) {
                allMarkers.push(layer);
            }
        });

        // Click on any marker to set start point
        if (routePoints.length > 1) {
            map.eachLayer(function(layer) {
                if (layer instanceof L.Marker && layer.options.zIndexOffset !== 1000) {
                    layer.on('click', function() {
                        for (var i = 0; i < allMarkers.length; i++) {
                            if (allMarkers[i] === layer) {
                                startMarkerIdx = i;
                                break;
                            }
                        }
                        // If currently playing, restart from clicked point
                        if (isPlaying) {
                            stopAnim();
                            startAnim();
                        }
                    });
                }
            });
        }

        if (routePoints.length > 1) {
            trailControls.style.display = 'flex';

            speedBtn.addEventListener('click', function() {
                speedIdx = (speedIdx + 1) % speeds.length;
                speedBtn.textContent = speeds[speedIdx] + 'x';
                // Don't restart, just continue from current position
            });

            function startAnim() {
                isPlaying = true;
                playBtn.innerHTML = '&#10074;&#10074;';
                if (animLine) map.removeLayer(animLine);
                if (animMarker) map.removeLayer(animMarker);
                map.closePopup();

                animLine = L.polyline([], { color: '#3366FF', weight: 4, opacity: 0.9 }).addTo(map);

                var arrowIcon = L.divIcon({
                    html: '<div style="width:16px;height:16px;background:#ff4444;border-radius:50%;border:3px solid #fff;box-shadow:0 0 12px rgba(255,68,68,0.6);"></div>',
                    iconSize: [16, 16],
                    iconAnchor: [8, 8],
                    className: ''
                });
                animMarker = L.marker(routePoints[startMarkerIdx], { icon: arrowIcon, zIndexOffset: 1000 }).addTo(map);

                animIdx = startMarkerIdx;
                subIdx = 0;

                // Show first point popup and pause 1s before moving
                showPointPopup(animIdx);
                animTimer = setTimeout(function() {
                    map.closePopup();
                    if (isPlaying) tick();
                }, 1000);
            }

            function stopAnim() {
                isPlaying = false;
                playBtn.innerHTML = '&#9654;';
                if (animTimer) clearTimeout(animTimer);
                animTimer = null;
                map.closePopup();
            }

            function showPointPopup(idx) {
                if (idx >= 0 && idx < allMarkers.length) {
                    allMarkers[idx].openPopup();
                }
            }

            function tick() {
                if (!isPlaying) return;
                if (animIdx >= routePoints.length - 1) {
                    animIdx = 0;
                    subIdx = 0;
                    startMarkerIdx = 0;
                    animLine.setLatLngs([]);
                    map.closePopup();
                }
                var from = routePoints[animIdx];
                var to = routePoints[animIdx + 1];
                subIdx++;
                var steps = Math.max(10, Math.floor(60 / speeds[speedIdx]));
                var prog = Math.min(subIdx / steps, 1);
                var lat = from[0] + (to[0] - from[0]) * prog;
                var lng = from[1] + (to[1] - from[1]) * prog;

                var currentPath = routePoints.slice(0, animIdx + 1);
                currentPath.push([lat, lng]);
                animLine.setLatLngs(currentPath);
                animMarker.setLatLng([lat, lng]);

                var totalProg = ((animIdx + prog) / (routePoints.length - 1)) * 100;
                progressBar.style.width = totalProg + '%';
                pointLabel.textContent = (animIdx + 1) + '/' + (routePoints.length - 1);

                if (prog >= 1) {
                    // Arrived at waypoint — show popup and pause 1 second
                    showPointPopup(animIdx + 1);
                    animTimer = setTimeout(function() {
                        map.closePopup();
                        animIdx++;
                        subIdx = 0;
                        if (isPlaying) tick();
                    }, 1000);
                    return;
                }
                animTimer = setTimeout(tick, 50 / speeds[speedIdx]);
            }

            playBtn.addEventListener('click', function() {
                isPlaying ? stopAnim() : startAnim();
            });
        }

        if (routePoints.length > 0) {
            var bounds = L.latLngBounds(routePoints);
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    <\/script>
</body>
</html>`;

  fs.writeFileSync(outputPath, htmlContent, "utf-8");
}

interface PlaceInfo {
  name: string;
  latitude: number;
  longitude: number;
}

interface TextExtractResult {
  places: PlaceInfo[];
  hasTime: boolean;
  baseTime: string;
  description: string;
}

// 全球地理词典：国家、主要城市、一级行政区、中国精确到县一级（用于纯文本解析）
const CITY_DICTIONARY: Record<string, [number, number]> = {
  // ========== 国家名称（全球主要国家） ==========
  // 亚洲国家
  "中国": [35.8617, 104.1954],
  "中华人民共和国": [35.8617, 104.1954],
  "日本": [36.2048, 138.2529],
  "韩国": [35.9078, 127.7669],
  "朝鲜": [40.3399, 127.5101],
  "蒙古": [46.8625, 103.8467],
  "俄罗斯": [61.5240, 105.3188],
  "印度": [20.5937, 78.9629],
  "巴基斯坦": [30.3753, 69.3451],
  "孟加拉国": [23.6850, 90.3563],
  "斯里兰卡": [7.8731, 80.7718],
  "尼泊尔": [28.3949, 84.1240],
  "不丹": [27.5142, 90.4336],
  "缅甸": [21.9162, 95.9560],
  "泰国": [15.8700, 100.9925],
  "越南": [14.0583, 108.2772],
  "老挝": [19.8563, 102.4955],
  "柬埔寨": [12.5657, 104.9910],
  "马来西亚": [4.2105, 101.9758],
  "新加坡": [1.3521, 103.8198],
  "印度尼西亚": [-0.7893, 113.9213],
  "菲律宾": [12.8797, 121.7740],
  "文莱": [4.5353, 114.7277],
  "东帝汶": [-8.8742, 125.7275],
  "阿富汗": [33.9391, 67.7100],
  "伊拉克": [33.2232, 43.6793],
  "伊朗": [32.4279, 53.6880],
  "叙利亚": [34.8021, 38.9968],
  "黎巴嫩": [33.8547, 35.8623],
  "约旦": [30.5852, 36.2384],
  "以色列": [31.0461, 34.8516],
  "巴勒斯坦": [31.9522, 35.2332],
  "沙特阿拉伯": [23.8859, 45.0792],
  "也门": [15.5527, 48.5164],
  "阿曼": [21.4735, 55.9754],
  "阿联酋": [23.4241, 53.8478],
  "卡塔尔": [25.3548, 51.1839],
  "巴林": [26.0667, 50.5577],
  "科威特": [29.3117, 47.4818],
  "土耳其": [38.9637, 35.2433],
  "塞浦路斯": [35.1264, 33.4299],
  "哈萨克斯坦": [48.0196, 66.9237],
  "乌兹别克斯坦": [41.3775, 64.5853],
  "土库曼斯坦": [38.9697, 59.5563],
  "吉尔吉斯斯坦": [41.2044, 74.7661],
  "塔吉克斯坦": [38.8610, 71.2761],
  "格鲁吉亚": [42.3154, 43.3569],
  "阿塞拜疆": [40.1431, 47.5769],
  "亚美尼亚": [40.0691, 45.0382],
  
  // 欧洲国家
  "英国": [55.3781, 3.4360],
  "法国": [46.2276, 2.2137],
  "德国": [51.1657, 10.4515],
  "意大利": [41.8719, 12.5674],
  "西班牙": [40.4637, 3.7492],
  "葡萄牙": [39.3999, 8.2245],
  "荷兰": [52.1326, 5.2913],
  "比利时": [50.5039, 4.4699],
  "卢森堡": [49.8153, 6.1296],
  "瑞士": [46.8182, 8.2275],
  "奥地利": [47.5162, 14.5501],
  "波兰": [51.9194, 19.1451],
  "捷克": [49.8175, 15.4730],
  "斯洛伐克": [48.6690, 19.6990],
  "匈牙利": [47.1625, 19.5033],
  "罗马尼亚": [45.9432, 24.9668],
  "保加利亚": [42.7339, 25.4858],
  "希腊": [39.0742, 21.8243],
  "瑞典": [60.1282, 18.6435],
  "挪威": [60.4720, 8.4689],
  "丹麦": [56.2639, 9.5018],
  "芬兰": [61.9241, 25.7482],
  "冰岛": [64.9631, 19.0208],
  "爱尔兰": [53.1424, 7.6921],
  "爱沙尼亚": [58.5953, 25.0136],
  "拉脱维亚": [56.8796, 24.6032],
  "立陶宛": [55.1694, 23.8813],
  "白俄罗斯": [53.7098, 27.9534],
  "乌克兰": [48.3794, 31.1656],
  "摩尔多瓦": [47.4116, 28.3699],
  "克罗地亚": [45.1000, 15.2000],
  "斯洛文尼亚": [46.1512, 14.9955],
  "塞尔维亚": [44.0165, 21.0059],
  "波黑": [43.9159, 17.6791],
  "黑山": [42.7087, 19.3744],
  "北马其顿": [41.6086, 21.7453],
  "阿尔巴尼亚": [41.1533, 20.1683],
  "马耳他": [35.9375, 14.3754],
  
  // 美洲国家
  "美国": [37.0902, 95.7129],
  "加拿大": [56.1304, 106.3468],
  "墨西哥": [23.6345, 102.5528],
  "巴西": [-14.2350, 51.9253],
  "阿根廷": [-38.4161, 63.6167],
  "智利": [-35.6751, 71.5430],
  "秘鲁": [-9.1900, 75.0152],
  "哥伦比亚": [4.5709, 74.2973],
  "委内瑞拉": [6.4238, 66.5897],
  "厄瓜多尔": [-1.8312, 78.1834],
  "玻利维亚": [-16.2902, 63.5887],
  "巴拉圭": [-23.4425, 58.4438],
  "乌拉圭": [-32.5228, 55.7658],
  "古巴": [21.5218, 77.7812],
  "牙买加": [18.1096, 77.2975],
  "海地": [18.9712, 72.2852],
  "多米尼加": [18.7357, 70.1627],
  "哥斯达黎加": [9.7489, 83.7534],
  "巴拿马": [8.5380, 80.7821],
  "危地马拉": [15.7835, 90.2308],
  "洪都拉斯": [15.2000, 86.2419],
  "尼加拉瓜": [12.8654, 85.2072],
  "萨尔瓦多": [13.7942, 88.8965],
  "伯利兹": [17.1899, 88.4976],
  "圭亚那": [4.8604, 58.9302],
  "苏里南": [3.9193, 56.0278],
  "特立尼达和多巴哥": [10.6918, 61.2225],
  
  // 非洲国家
  "埃及": [26.8206, 30.8025],
  "南非": [-30.5595, 22.9375],
  "尼日利亚": [9.0820, 8.6753],
  "肯尼亚": [-0.0236, 37.9062],
  "埃塞俄比亚": [9.1450, 40.4897],
  "加纳": [7.9465, 1.0232],
  "摩洛哥": [31.7917, 7.0926],
  "阿尔及利亚": [28.0339, 1.6596],
  "突尼斯": [33.8869, 9.5375],
  "利比亚": [26.3351, 17.2283],
  "苏丹": [12.8628, 30.2176],
  "南苏丹": [6.8770, 31.3070],
  "坦桑尼亚": [-6.3690, 34.8888],
  "乌干达": [1.3733, 32.2903],
  "卢旺达": [-1.9403, 29.8739],
  "刚果": [-4.0383, 21.7587],
  "刚果民主共和国": [-4.0383, 21.7587],
  "安哥拉": [-11.2027, 17.8739],
  "莫桑比克": [-18.6657, 35.5296],
  "赞比亚": [-13.1339, 27.8493],
  "津巴布韦": [-19.0154, 29.1549],
  "博茨瓦纳": [-22.3285, 24.6849],
  "纳米比亚": [-22.9576, 18.4904],
  "塞内加尔": [14.4974, 14.4524],
  "马里": [17.5707, 3.9962],
  "尼日尔": [17.6078, 8.0817],
  "乍得": [15.4542, 18.7322],
  "喀麦隆": [7.3697, 12.3547],
  "科特迪瓦": [7.5400, 5.5471],
  "索马里": [5.1521, 46.1996],
  "埃塞俄比亚": [9.1450, 40.4897],
  
  // 大洋洲国家
  "澳大利亚": [-25.2744, 133.7751],
  "新西兰": [-40.9006, 174.8860],
  "巴布亚新几内亚": [-6.3150, 143.9555],
  "斐济": [-17.7134, 178.0650],
  "萨摩亚": [-13.7590, 172.1046],
  
  // ========== 中国省级行政区（省、自治区、直辖市、特别行政区） ==========
  "北京市": [39.9042, 116.4074],
  "天津市": [39.3434, 117.3616],
  "上海市": [31.2304, 121.4737],
  "重庆市": [29.5630, 106.5516],
  "河北省": [38.0428, 114.5149],
  "山西省": [37.8706, 112.5489],
  "辽宁省": [41.8057, 123.4315],
  "吉林省": [43.8171, 125.3235],
  "黑龙江省": [45.8038, 126.5350],
  "江苏省": [32.0603, 118.7969],
  "浙江省": [30.2741, 120.1551],
  "安徽省": [31.8206, 117.2272],
  "福建省": [26.0745, 119.2965],
  "江西省": [28.6829, 115.8579],
  "山东省": [36.6512, 117.1201],
  "河南省": [34.7466, 113.6253],
  "湖北省": [30.5928, 114.3055],
  "湖南省": [28.2282, 112.9388],
  "广东省": [23.1291, 113.2644],
  "海南省": [20.0444, 110.1934],
  "四川省": [30.5728, 104.0668],
  "贵州省": [26.6470, 106.6302],
  "云南省": [25.0406, 102.7125],
  "陕西省": [34.3416, 108.9398],
  "甘肃省": [36.0611, 103.8343],
  "青海省": [36.6171, 101.7782],
  "台湾省": [23.6978, 120.9605],
  "内蒙古自治区": [40.8414, 111.7519],
  "广西壮族自治区": [22.8170, 108.3665],
  "西藏自治区": [29.6500, 91.1409],
  "宁夏回族自治区": [38.4872, 106.2309],
  "新疆维吾尔自治区": [43.8256, 87.6168],
  "香港": [22.3193, 114.1694],
  "香港特别行政区": [22.3193, 114.1694],
  "澳门": [22.1987, 113.5439],
  "澳门特别行政区": [22.1987, 113.5439],
  
  // ========== 中国地级市 ==========
  "北京": [39.9042, 116.4074],
  "天津": [39.3434, 117.3616],
  "上海": [31.2304, 121.4737],
  "重庆": [29.5630, 106.5516],
  "广州": [23.1291, 113.2644],
  "深圳": [22.5431, 114.0579],
  "成都": [30.5728, 104.0668],
  "杭州": [30.2741, 120.1551],
  "南京": [32.0603, 118.7969],
  "武汉": [30.5928, 114.3055],
  "西安": [34.3416, 108.9398],
  "苏州": [31.2989, 120.5853],
  "青岛": [36.0671, 120.3826],
  "济南": [36.6512, 117.1201],
  "大连": [38.9140, 121.6147],
  "郑州": [34.7466, 113.6253],
  "长沙": [28.2282, 112.9388],
  "昆明": [25.0406, 102.7125],
  "厦门": [24.4798, 118.0894],
  "宁波": [29.8683, 121.5440],
  "沈阳": [41.8057, 123.4315],
  "哈尔滨": [45.8038, 126.5350],
  "福州": [26.0745, 119.2965],
  "合肥": [31.8206, 117.2272],
  "南昌": [28.6829, 115.8579],
  "石家庄": [38.0428, 114.5149],
  "太原": [37.8706, 112.5489],
  "长春": [43.8171, 125.3235],
  "贵阳": [26.6470, 106.6302],
  "南宁": [22.8170, 108.3665],
  "兰州": [36.0611, 103.8343],
  "乌鲁木齐": [43.8256, 87.6168],
  "呼和浩特": [40.8414, 111.7519],
  "银川": [38.4872, 106.2309],
  "西宁": [36.6171, 101.7782],
  "拉萨": [29.6500, 91.1409],
  "无锡": [31.4912, 120.3119],
  "佛山": [23.0218, 113.1219],
  "东莞": [23.0205, 113.7518],
  "珠海": [22.2719, 113.5767],
  "中山": [22.5170, 113.3927],
  "惠州": [23.1115, 114.4152],
  "江门": [22.5789, 113.0815],
  "肇庆": [23.0469, 112.4656],
  "汕头": [23.3540, 116.6824],
  "湛江": [21.2707, 110.3594],
  "潮州": [23.6567, 116.6226],
  "揭阳": [23.5474, 116.3726],
  "茂名": [21.9231, 110.9255],
  "阳江": [21.8583, 111.9836],
  "清远": [23.6817, 113.0562],
  "韶关": [24.8109, 113.5977],
  "梅州": [24.2885, 116.1225],
  "汕尾": [22.7879, 115.3742],
  "河源": [23.7433, 114.7012],
  "云浮": [22.9150, 112.0445],
  "保定": [38.8738, 115.4648],
  "唐山": [39.6243, 118.1944],
  "邯郸": [36.6256, 114.5392],
  "邢台": [37.0682, 114.5087],
  "张家口": [40.8116, 114.8840],
  "承德": [40.9529, 117.9632],
  "秦皇岛": [39.9347, 119.6000],
  "廊坊": [39.5196, 116.7010],
  "沧州": [38.3036, 116.8385],
  "衡水": [37.7350, 115.6860],
  "大同": [40.0761, 113.2937],
  "阳泉": [37.8579, 113.5799],
  "长治": [36.2119, 113.1136],
  "晋城": [35.4918, 112.8513],
  "朔州": [39.3311, 112.4328],
  "晋中": [37.6870, 112.7397],
  "运城": [35.0232, 111.0026],
  "忻州": [38.4164, 112.7331],
  "临汾": [36.0848, 111.5189],
  "吕梁": [37.5196, 111.1340],
  "鞍山": [41.1087, 122.9945],
  "抚顺": [41.8654, 123.9210],
  "本溪": [41.2896, 123.7372],
  "丹东": [40.1291, 124.3717],
  "锦州": [41.1128, 121.1274],
  "营口": [40.6660, 122.2351],
  "阜新": [42.0212, 121.6687],
  "辽阳": [41.2687, 123.1723],
  "盘锦": [41.1245, 122.0707],
  "铁岭": [42.2854, 123.8410],
  "朝阳": [41.5766, 120.4511],
  "葫芦岛": [40.7553, 120.8372],
  "吉林": [43.8367, 126.5493],
  "四平": [43.1668, 124.3705],
  "辽源": [42.8898, 125.1451],
  "通化": [41.7211, 125.9362],
  "白山": [41.9432, 126.4240],
  "松原": [45.2432, 124.8238],
  "白城": [45.6189, 122.8395],
  "延边": [42.9052, 129.5085],
  "齐齐哈尔": [47.3420, 123.9670],
  "牡丹江": [44.5830, 129.6000],
  "佳木斯": [46.7990, 130.3180],
  "大庆": [46.5897, 125.1060],
  "鸡西": [45.3010, 130.9760],
  "鹤岗": [47.3490, 130.2990],
  "双鸭山": [46.6430, 131.1570],
  "伊春": [47.7270, 129.0330],
  "七台河": [45.7950, 130.8690],
  "黑河": [50.2490, 127.5010],
  "绥化": [46.6370, 126.9990],
  "大兴安岭": [52.3290, 124.7140],
  "徐州": [34.2047, 117.2854],
  "连云港": [34.5967, 119.2210],
  "淮安": [33.5975, 119.0210],
  "盐城": [33.3776, 120.1614],
  "扬州": [32.3917, 119.4210],
  "镇江": [32.1908, 119.4461],
  "泰州": [32.4567, 119.9220],
  "南通": [31.9662, 120.8820],
  "常州": [31.7726, 119.9462],
  "宿迁": [33.9633, 118.2760],
  "温州": [27.9933, 120.6987],
  "嘉兴": [30.7453, 120.7535],
  "湖州": [30.8711, 120.0868],
  "绍兴": [29.9969, 120.5810],
  "金华": [29.0870, 119.6462],
  "衢州": [28.9424, 118.8635],
  "舟山": [29.9860, 122.2060],
  "台州": [28.6572, 121.4230],
  "丽水": [28.4516, 119.9219],
  "芜湖": [31.3340, 118.3628],
  "蚌埠": [32.9400, 117.3520],
  "马鞍山": [31.6890, 118.5080],
  "安庆": [30.5088, 117.0580],
  "宿州": [33.6360, 116.9620],
  "阜阳": [32.8890, 115.8170],
  "淮北": [33.9710, 116.7940],
  "亳州": [33.8690, 115.7780],
  "黄山": [29.7070, 118.3380],
  "滁州": [32.3170, 118.3290],
  "六安": [31.7340, 116.5070],
  "宣城": [30.9520, 118.7570],
  "池州": [30.6550, 117.4890],
  "铜陵": [30.9450, 117.8110],
  "莆田": [25.4320, 119.0080],
  "泉州": [24.8860, 118.6070],
  "漳州": [24.5130, 117.6550],
  "龙岩": [25.0750, 117.0120],
  "三明": [26.2620, 117.6340],
  "南平": [26.6410, 118.1470],
  "宁德": [26.6580, 119.5250],
  "九江": [29.7050, 115.9880],
  "景德镇": [29.2930, 117.2160],
  "萍乡": [27.6230, 113.8680],
  "新余": [27.8110, 114.9270],
  "鹰潭": [28.2330, 117.0380],
  "赣州": [25.8300, 114.9330],
  "吉安": [27.1070, 114.9830],
  "宜春": [27.8030, 114.3890],
  "抚州": [27.9480, 116.3570],
  "上饶": [28.4320, 117.9430],
  "潍坊": [36.7090, 119.1610],
  "烟台": [37.4640, 121.4470],
  "威海": [37.5140, 122.1200],
  "淄博": [36.8120, 118.0540],
  "枣庄": [34.8100, 117.5570],
  "东营": [37.4540, 118.6750],
  "济宁": [35.4040, 116.5710],
  "泰安": [36.1900, 117.0880],
  "临沂": [35.1040, 118.3560],
  "德州": [37.4540, 116.3580],
  "聊城": [36.4560, 115.9960],
  "滨州": [37.3780, 117.9760],
  "菏泽": [35.2410, 115.4690],
  "洛阳": [34.6190, 112.4540],
  "开封": [34.8030, 114.3080],
  "安阳": [36.1030, 114.3520],
  "南阳": [33.0100, 112.5280],
  "新乡": [35.3030, 113.9270],
  "平顶山": [33.7450, 113.3010],
  "焦作": [35.2430, 113.2420],
  "濮阳": [35.7610, 115.0740],
  "许昌": [34.0350, 113.8280],
  "漯河": [33.5810, 114.0250],
  "三门峡": [34.7880, 111.1940],
  "商丘": [34.4150, 115.6560],
  "周口": [33.6250, 114.6510],
  "驻马店": [33.0040, 114.0240],
  "信阳": [32.1480, 114.0680],
  "鹤壁": [35.7470, 114.2980],
  "济源": [35.0780, 112.5900],
  "株洲": [27.8350, 113.1340],
  "湘潭": [27.8290, 112.9440],
  "衡阳": [26.9010, 112.6270],
  "邵阳": [27.2380, 111.4720],
  "岳阳": [29.3710, 113.1320],
  "常德": [29.0390, 111.6910],
  "张家界": [29.1250, 110.4790],
  "益阳": [28.5700, 112.3550],
  "郴州": [25.7730, 113.0270],
  "永州": [26.4350, 111.6130],
  "怀化": [27.5700, 110.0030],
  "娄底": [27.7320, 111.9930],
  "湘西": [28.3130, 109.7400],
  "孝感": [30.9260, 113.9180],
  "黄石": [30.2170, 115.0760],
  "十堰": [32.6470, 110.7880],
  "宜昌": [30.7050, 111.2840],
  "襄阳": [32.0420, 112.1220],
  "鄂州": [30.3920, 114.8950],
  "荆州": [30.3250, 112.2390],
  "荆门": [31.0350, 112.2040],
  "黄冈": [30.4530, 114.8710],
  "咸宁": [29.8530, 114.3230],
  "随州": [31.6910, 113.3740],
  "恩施": [30.2780, 109.4870],
  "仙桃": [30.3670, 113.4500],
  "潜江": [30.4250, 112.8950],
  "天门": [30.6580, 113.1620],
  "神农架": [31.7460, 110.6770],
  "桂林": [25.2660, 110.2810],
  "柳州": [24.3260, 109.4280],
  "梧州": [23.4850, 111.3060],
  "北海": [21.4730, 109.1200],
  "防城港": [21.6870, 108.3450],
  "钦州": [21.9670, 108.6250],
  "贵港": [23.0920, 109.5850],
  "玉林": [22.6300, 110.1540],
  "百色": [23.9000, 106.6170],
  "贺州": [24.4150, 111.5620],
  "河池": [24.6940, 108.0850],
  "来宾": [23.7520, 109.2250],
  "崇左": [22.3980, 107.3650],
  "绵阳": [31.4730, 104.7420],
  "德阳": [31.1260, 104.3980],
  "乐山": [29.5800, 103.7650],
  "南充": [30.8350, 106.1100],
  "达州": [31.2170, 107.4970],
  "宜宾": [28.7600, 104.6300],
  "泸州": [28.8890, 105.4430],
  "自贡": [29.3530, 104.7790],
  "攀枝花": [26.5800, 101.7180],
  "广元": [32.4360, 105.8410],
  "遂宁": [30.5100, 105.5830],
  "内江": [29.5840, 105.0650],
  "广安": [30.4640, 106.6310],
  "眉山": [30.0450, 103.8510],
  "资阳": [30.1100, 104.6400],
  "雅安": [29.9800, 103.0070],
  "巴中": [31.8620, 106.7530],
  "阿坝": [31.8990, 102.2210],
  "甘孜": [30.0450, 101.9630],
  "凉山": [27.8870, 102.2590],
  "遵义": [27.7150, 106.9270],
  "六盘水": [26.5930, 104.8300],
  "安顺": [26.2280, 105.9300],
  "毕节": [27.3010, 105.2910],
  "铜仁": [27.7180, 109.1920],
  "曲靖": [25.4900, 103.7970],
  "玉溪": [24.3530, 102.5450],
  "大理": [25.6060, 100.2670],
  "丽江": [26.8690, 100.2320],
  "红河": [23.3640, 103.3760],
  "楚雄": [25.0350, 101.5300],
  "普洱": [22.7800, 100.9700],
  "临沧": [23.8720, 100.0880],
  "昭通": [27.3380, 103.7170],
  "保山": [25.1190, 99.1710],
  "西双版纳": [22.0080, 100.7970],
  "德宏": [24.4360, 98.5860],
  "怒江": [25.8520, 98.8580],
  "迪庆": [27.8260, 99.7040],
  "文山": [23.3660, 104.2440],
  "咸阳": [34.3320, 108.7030],
  "宝鸡": [34.3610, 107.2370],
  "汉中": [33.0730, 107.0270],
  "渭南": [34.5040, 109.5010],
  "延安": [36.5960, 109.4930],
  "榆林": [38.2790, 109.7690],
  "安康": [32.6900, 109.0290],
  "商洛": [33.8750, 109.9420],
  "铜川": [35.0760, 109.0930],
  "杨凌": [34.2920, 108.0710],
  "天水": [34.5780, 105.8900],
  "酒泉": [39.7340, 98.5070],
  "张掖": [38.9320, 100.4550],
  "武威": [37.9280, 102.6340],
  "白银": [36.5440, 104.1720],
  "庆阳": [35.7340, 107.6380],
  "平凉": [35.5420, 106.6840],
  "定西": [35.5790, 104.6210],
  "陇南": [33.3980, 104.9200],
  "嘉峪关": [39.7720, 98.2770],
  "金昌": [38.5150, 102.1800],
  "临夏": [35.6000, 103.2100],
  "甘南": [34.9810, 102.9220],
  "海东": [36.5010, 102.1030],
  "海北": [37.1580, 100.8560],
  "黄南": [35.5150, 102.0200],
  "海南": [36.2850, 100.6200],
  "果洛": [34.4740, 100.2420],
  "玉树": [33.0070, 97.0100],
  "海西": [37.3750, 97.3700],
  "中卫": [37.5150, 105.1870],
  "吴忠": [37.9930, 106.3300],
  "石嘴山": [39.0120, 106.3920],
  "固原": [36.0010, 106.2820],
  "伊犁": [43.9230, 81.3250],
  "哈密": [42.8320, 93.5130],
  "吐鲁番": [42.9450, 89.1870],
  "喀什": [39.4670, 75.9930],
  "阿克苏": [41.1700, 80.2650],
  "巴音郭楞": [41.7660, 86.1470],
  "昌吉": [44.0150, 87.3010],
  "博尔塔拉": [44.9030, 82.0740],
  "克孜勒苏": [39.7490, 76.1700],
  "克拉玛依": [45.5850, 84.8850],
  "石河子": [44.3040, 86.0710],
  "阿拉尔": [40.5510, 81.2740],
  "图木舒克": [39.8600, 79.0770],
  "五家渠": [44.1660, 87.6980],
  "塔城": [46.7400, 83.0180],
  "阿勒泰": [47.8500, 88.1290],
  "和田": [37.1100, 79.9330],
  "海北": [37.1580, 100.8560],
  
  // ========== 中国县级市/县（部分主要县/区/县级市） ==========
  // 京津冀地区
  "平谷区": [40.1440, 117.1230],
  "密云区": [40.3770, 116.8420],
  "怀柔区": [40.3220, 116.6330],
  "延庆区": [40.4530, 115.9740],
  "门头沟区": [39.9400, 116.0560],
  "房山区": [39.7490, 115.9890],
  "昌平区": [40.2170, 116.2300],
  "大兴区": [39.7300, 116.3400],
  "通州区": [39.9100, 116.6600],
  "顺义区": [40.1280, 116.6540],
  "武清区": [39.3950, 117.0320],
  "宝坻区": [39.7510, 117.3100],
  "宁河区": [39.3300, 117.8300],
  "静海区": [38.9320, 116.9360],
  "蓟州区": [40.0470, 117.4080],
  "涿州市": [39.4900, 115.9900],
  "三河市": [39.9800, 117.0800],
  "霸州市": [39.0900, 116.7200],
  "香河县": [39.7500, 116.9600],
  "大厂回族自治县": [39.8800, 117.0100],
  "固安县": [39.4300, 116.2800],
  "永清县": [39.3200, 116.5000],
  "安次区": [39.5300, 116.6900],
  "正定县": [38.1400, 114.5700],
  "鹿泉区": [38.0700, 114.3300],
  "栾城区": [37.8800, 114.6500],
  "井陉县": [38.0300, 114.1400],
  "辛集市": [37.9200, 115.2200],
  "晋州市": [37.9600, 115.0300],
  "新乐市": [38.3400, 114.6900],
  "遵化市": [40.1900, 117.9600],
  "迁安市": [39.9900, 118.7000],
  "滦州市": [39.7300, 118.6100],
  "玉田县": [39.8800, 117.7600],
  "乐亭县": [39.2500, 118.9100],
  "迁西县": [40.1400, 118.1700],
  "霸州": [39.0900, 116.7200],
  "文安县": [38.8400, 116.4600],
  "大城县": [38.7000, 116.6300],
  "任丘市": [38.7200, 116.1100],
  "河间市": [38.4300, 116.0900],
  "黄骅市": [38.3700, 117.3600],
  "泊头市": [38.0800, 116.5800],
  "献县": [38.1900, 116.1300],
  "吴桥县": [37.6300, 116.3900],
  "盐山县": [38.0400, 117.2200],
  "海兴县": [38.1400, 117.6300],
  "孟村回族自治县": [38.0600, 117.1000],
  "青县": [38.5800, 116.8200],
  "东光县": [37.9100, 116.5500],
  "南皮县": [38.0400, 116.6900],
  "肃宁县": [38.4200, 115.8400],
  "定州市": [38.5100, 114.9800],
  "安国市": [38.4200, 115.3100],
  "高碑店市": [39.3200, 115.8700],
  "涞水县": [39.3900, 115.7000],
  "涞源县": [39.3500, 114.6800],
  "阜平县": [38.8600, 114.1600],
  "徐水区": [38.9800, 115.6500],
  "清苑区": [38.7600, 115.4800],
  "满城区": [38.9400, 115.4700],
  "易县": [39.0900, 115.3400],
  "曲阳县": [38.7400, 114.7000],
  "唐县": [38.7500, 114.9700],
  "顺平县": [38.8300, 115.1400],
  "博野县": [38.4600, 115.8600],
  "蠡县": [38.4900, 115.5800],
  "望都县": [38.7200, 115.1300],
  "高阳县": [38.7000, 115.7600],
  "安新县": [38.9300, 115.9200],
  "雄县": [38.9800, 116.1000],
  "容城县": [39.0900, 115.9300],
  "平山县": [38.2500, 114.2300],
  "行唐县": [38.4100, 114.5500],
  "灵寿县": [38.3000, 114.3800],
  "无极县": [38.1700, 114.7600],
  "藁城区": [38.0100, 114.8300],
  "深泽县": [38.1900, 115.2100],
  "赵县": [37.7600, 114.7600],
  "柏乡县": [37.4800, 114.7000],
  "宁晋县": [37.6300, 114.9200],
  "新河县": [37.5100, 115.2400],
  "巨鹿县": [37.2300, 115.0200],
  "平乡县": [37.0600, 115.0800],
  "南宫市": [37.3500, 115.3800],
  "沙河市": [36.8500, 114.5100],
  "临城县": [37.4400, 114.5000],
  "内丘县": [37.2800, 114.4800],
  "隆尧县": [37.3400, 114.7800],
  "任泽区": [37.1200, 114.6900],
  "南和区": [37.0000, 114.7100],
  "广宗县": [37.0600, 115.1400],
  "威县": [36.9700, 115.2800],
  "清河县": [37.0800, 115.7600],
  "临西县": [36.8600, 115.4600],
  "鸡泽县": [36.9000, 114.8600],
  "曲周县": [36.7700, 114.9800],
  "邱县": [36.8200, 115.2200],
  "武安市": [36.7000, 114.1000],
  "涉县": [36.5700, 113.7000],
  "磁县": [36.3800, 114.3900],
  "成安县": [36.4500, 114.7200],
  "魏县": [36.3500, 114.9300],
  "大名县": [36.2800, 115.1500],
  "肥乡区": [36.5400, 114.8200],
  "广平区": [36.4800, 115.0200],
  "馆陶县": [36.5500, 115.3000],
  "临漳县": [36.2500, 114.6200],
  "永年区": [36.7900, 114.5100],
  "怀来县": [40.4100, 115.5200],
  "蔚县": [39.8300, 114.8900],
  "涿鹿县": [40.3800, 115.2200],
  "赤城县": [40.9200, 115.8300],
  "阳原县": [40.1500, 114.2000],
  "怀安县": [40.6700, 114.4400],
  "万全区": [40.7700, 114.9300],
  "张北县": [40.9800, 114.7100],
  "尚义县": [41.0700, 114.0100],
  "沽源县": [41.6600, 115.7100],
  "康保县": [41.8400, 114.5800],
  "崇礼区": [40.9600, 115.3100],
  "丰宁满族自治县": [41.2100, 116.6400],
  "宽城满族自治县": [40.6000, 118.4800],
  "兴隆县": [40.4100, 117.4900],
  "承德县": [40.7400, 117.7500],
  "滦平县": [40.9400, 117.3200],
  "平泉市": [40.9900, 118.6900],
  "隆化县": [41.3300, 117.9700],
  "围场满族蒙古族自治县": [42.3400, 117.7800],
  "青龙满族自治县": [40.4100, 119.0200],
  "卢龙县": [39.8100, 119.3200],
  "昌黎县": [39.7100, 119.1600],
  "抚宁区": [39.8600, 119.2500],
  "曹妃甸区": [39.2500, 118.5200],
  "滦南县": [39.3400, 118.6500],
  "唐海县": [39.2800, 118.4400],
  "丰润区": [39.8400, 118.1400],
  "丰南区": [39.5700, 118.1000],
  "玉田县": [39.8800, 117.7600],
  
  // 华东地区（部分）
  "昆山市": [31.3850, 120.9520],
  "常熟市": [31.6540, 120.7420],
  "太仓市": [31.4520, 121.1090],
  "张家港市": [31.8600, 120.5400],
  "江阴市": [31.9090, 120.2800],
  "宜兴市": [31.3570, 119.8170],
  "溧阳市": [31.4340, 119.5120],
  "邳州市": [34.3190, 117.9530],
  "新沂市": [34.3740, 118.3380],
  "东台市": [32.8850, 120.3200],
  "如皋市": [32.3780, 120.5580],
  "海安市": [32.5390, 120.4740],
  "启东市": [31.8200, 121.6100],
  "海门区": [31.8900, 121.1800],
  "如东县": [32.3100, 121.1800],
  "仪征市": [32.2700, 119.1700],
  "高邮市": [32.7800, 119.4400],
  "宝应县": [33.2500, 119.3400],
  "兴化市": [32.9000, 119.8500],
  "靖江市": [32.0100, 120.2700],
  "泰兴市": [32.1600, 120.0200],
  "扬中市": [32.2400, 119.7800],
  "句容市": [31.9500, 119.1700],
  "丹阳市": [31.9900, 119.5800],
  "溧水区": [31.6500, 119.0100],
  "高淳区": [31.3200, 118.9100],
  "江宁区": [31.9600, 118.8200],
  "六合区": [32.3300, 118.8300],
  "浦口区": [32.0500, 118.6300],
  "建邺区": [32.0000, 118.7300],
  "鼓楼区": [32.0800, 118.7700],
  "玄武区": [32.0400, 118.8000],
  "秦淮区": [32.0300, 118.7900],
  "栖霞区": [32.0900, 118.9100],
  "雨花台区": [31.9900, 118.7800],
  "吴江区": [31.1600, 120.6400],
  "相城区": [31.3800, 120.6200],
  "吴中区": [31.2700, 120.5900],
  "虎丘区": [31.3100, 120.4900],
  "姑苏区": [31.3100, 120.6200],
  "萧山区": [30.1600, 120.2700],
  "余杭区": [30.3000, 120.0000],
  "临平区": [30.4300, 120.3000],
  "钱塘区": [30.2900, 120.4900],
  "富阳区": [30.0500, 119.9500],
  "临安区": [30.2300, 119.7100],
  "桐庐县": [29.7900, 119.6900],
  "淳安县": [29.6000, 119.0600],
  "建德市": [29.4700, 119.2700],
  "慈溪市": [30.1700, 121.2400],
  "余姚市": [30.0500, 121.1500],
  "宁海县": [29.2800, 121.4200],
  "象山县": [29.4800, 121.8700],
  "海宁市": [30.5200, 120.6800],
  "桐乡市": [30.6300, 120.5800],
  "平湖市": [30.7000, 121.0000],
  "嘉善县": [30.8300, 120.9200],
  "海盐县": [30.5200, 120.9600],
  "安吉县": [30.6300, 119.6900],
  "长兴县": [31.0100, 119.9100],
  "德清县": [30.5200, 120.0900],
  "诸暨市": [29.7100, 120.2400],
  "嵊州市": [29.5800, 120.8300],
  "新昌县": [29.4800, 120.9900],
  "上虞区": [30.0200, 120.8800],
  "柯桥区": [30.0800, 120.5000],
  "越城区": [30.0000, 120.5900],
  "东阳市": [29.2600, 120.2400],
  "义乌市": [29.3100, 120.0600],
  "永康市": [28.9100, 120.0200],
  "兰溪市": [29.1800, 119.4800],
  "武义县": [28.8800, 119.8300],
  "浦江县": [29.4400, 119.9000],
  "磐安县": [28.9500, 120.4600],
  "龙游县": [29.0300, 119.1700],
  "常山县": [29.0000, 118.5200],
  "开化县": [29.1400, 118.4200],
  "江山市": [28.7400, 118.6200],
  "普陀区": [29.9500, 122.2800],
  "岱山县": [30.2500, 122.2000],
  "嵊泗县": [30.7300, 122.4700],
  "椒江区": [28.6800, 121.4300],
  "黄岩区": [28.6400, 121.2700],
  "路桥区": [28.5800, 121.3700],
  "临海市": [28.8500, 121.1600],
  "温岭市": [28.3700, 121.3700],
  "玉环市": [28.1400, 121.2300],
  "仙居县": [28.8500, 120.7400],
  "天台县": [29.1400, 121.0500],
  "三门县": [29.1200, 121.3800],
  "莲都区": [28.4600, 119.9200],
  "龙泉市": [28.0600, 119.1200],
  "缙云县": [28.6600, 120.0800],
  "青田县": [28.1400, 120.2900],
  "景宁畲族自治县": [27.9600, 119.6300],
  "庆元县": [27.6000, 119.0700],
  "遂昌县": [28.5900, 119.2500],
  "松阳县": [28.4500, 119.4900],
  "云和县": [28.1200, 119.5700],
  "定海区": [30.0100, 122.1000],
  "临平区": [30.4300, 120.3000],
  
  // 华南地区（部分）
  "花都区": [23.4000, 113.2100],
  "番禺区": [22.9400, 113.3800],
  "从化区": [23.5400, 113.5800],
  "增城区": [23.2600, 113.8100],
  "白云区": [23.1600, 113.2700],
  "黄埔区": [23.1000, 113.4400],
  "南沙区": [22.7900, 113.5300],
  "天河区": [23.1300, 113.3800],
  "越秀区": [23.1200, 113.2900],
  "荔湾区": [23.1200, 113.2400],
  "海珠区": [23.1000, 113.3400],
  "乐昌市": [25.1300, 113.3400],
  "南雄市": [25.1100, 114.3000],
  "仁化县": [25.0700, 113.7500],
  "始兴县": [24.9400, 114.0900],
  "翁源县": [24.3700, 114.1200],
  "乳源瑶族自治县": [24.7700, 113.2800],
  "新丰县": [24.0700, 114.1100],
  "四会市": [23.3400, 112.7300],
  "高要区": [23.0200, 112.4500],
  "广宁县": [23.6300, 112.1300],
  "怀集县": [23.9200, 112.1800],
  "封开县": [23.4200, 111.5000],
  "德庆县": [23.1500, 111.8000],
  "鹤山市": [22.7700, 112.9700],
  "台山市": [22.2500, 112.8000],
  "开平市": [22.3700, 112.6800],
  "恩平市": [22.1800, 112.3100],
  "新会区": [22.5300, 113.0300],
  "阳春市": [22.1700, 111.7900],
  "阳西县": [21.7600, 111.5200],
  "雷州市": [20.9100, 110.1000],
  "廉江市": [21.6200, 110.2800],
  "吴川市": [21.4400, 110.7800],
  "遂溪县": [21.3700, 110.2500],
  "徐闻县": [20.3300, 110.1800],
  "高州市": [21.9200, 110.8600],
  "化州市": [21.6700, 110.6300],
  "信宜市": [22.3400, 110.9500],
  "英德市": [24.1800, 113.3900],
  "连州市": [24.7800, 112.3800],
  "佛冈县": [23.8700, 113.5200],
  "阳山县": [24.4700, 112.6200],
  "连山壮族瑶族自治县": [24.5700, 112.0800],
  "连南瑶族自治县": [24.7100, 112.2800],
  "普宁市": [23.2900, 116.1600],
  "惠来县": [23.0200, 116.2900],
  "陆丰市": [22.9400, 115.6300],
  "海丰县": [22.9700, 115.3400],
  "陆河县": [23.2800, 115.6300],
  "兴宁市": [24.1400, 115.7500],
  "大埔县": [24.3500, 116.6900],
  "五华县": [23.9300, 115.7800],
  "丰顺县": [23.7400, 116.1900],
  "蕉岭县": [24.3700, 116.1600],
  "平远县": [24.5600, 115.8800],
  "龙川县": [24.1000, 115.2600],
  "东源县": [23.8000, 114.7500],
  "紫金县": [23.5800, 115.0000],
  "和平县": [24.4400, 114.9400],
  "连平县": [24.3700, 114.5000],
  "博罗县": [23.1800, 114.2800],
  "惠东县": [22.9600, 114.7200],
  "龙门县": [23.7400, 114.2600],
  "恩平市": [22.1800, 112.3100],
  "高栏港": [21.9300, 113.1700],
  "斗门区": [22.2100, 113.2900],
  "香洲区": [22.2700, 113.5700],
  "万山区": [22.1700, 113.5900],
  
  // ========== 国外主要城市 ==========
  // 日本
  "东京": [35.6762, 139.6503],
  "大阪": [34.6937, 135.5023],
  "京都": [35.0116, 135.7681],
  "横滨": [35.4437, 139.6380],
  "名古屋": [35.1815, 136.9066],
  "神户": [34.6901, 135.1956],
  "福冈": [33.5902, 130.4017],
  "札幌": [43.0621, 141.3544],
  "仙台": [38.2682, 140.8694],
  "广岛": [34.3963, 132.4590],
  "奈良": [34.6851, 135.8050],
  "金泽": [36.5613, 136.6562],
  "箱根": [35.2314, 139.1062],
  "富士": [35.1614, 138.6176],
  
  // 韩国
  "首尔": [37.5665, 126.9780],
  "釜山": [35.1796, 129.0756],
  "济州": [33.4996, 126.5312],
  "仁川": [37.4563, 126.7052],
  "大邱": [35.8714, 128.6014],
  "光州": [35.1595, 126.8526],
  "庆州": [35.8562, 129.2247],
  "全州": [35.8242, 127.1480],
  
  // 东南亚
  "曼谷": [13.7563, 100.5018],
  "河内": [21.0278, 105.8342],
  "胡志明": [10.8231, 106.6297],
  "胡志明市": [10.8231, 106.6297],
  "新加坡": [1.3521, 103.8198],
  "吉隆坡": [3.1390, 101.6869],
  "雅加达": [6.2088, 106.8456],
  "马尼拉": [14.5995, 120.9842],
  "清迈": [18.7883, 98.9853],
  "芭堤雅": [12.9334, 100.8831],
  "巴厘岛": [-8.4095, 115.1889],
  "万象": [17.9676, 102.6137],
  "暹粒": [13.3671, 103.8446],
  "金边": [11.5564, 104.9242],
  
  // 中东
  "迪拜": [25.2048, 55.2708],
  "阿布扎比": [24.4539, 54.3773],
  "多哈": [25.2854, 51.5310],
  "利雅得": [24.7136, 46.6753],
  "特拉维夫": [32.0853, 34.7818],
  "伊斯坦布尔": [41.0082, 28.9784],
  "安卡拉": [39.9334, 32.8597],
  
  // 北美
  "纽约": [40.7128, 74.0060],
  "洛杉矶": [34.0522, 118.2437],
  "旧金山": [37.7749, 122.4194],
  "芝加哥": [41.8781, 87.6298],
  "波士顿": [42.3601, 71.0589],
  "西雅图": [47.6062, 122.3321],
  "华盛顿": [38.9072, 77.0369],
  "拉斯维加斯": [36.1699, 115.1398],
  "迈阿密": [25.7617, 80.1918],
  "休斯顿": [29.7604, 95.3698],
  "达拉斯": [32.7767, 96.7970],
  "费城": [39.9526, 75.1652],
  "亚特兰大": [33.7490, 84.3880],
  "底特律": [42.3314, 83.0458],
  "丹佛": [39.7392, 104.9903],
  "凤凰城": [33.4484, 112.0740],
  "圣地亚哥": [32.7157, 117.1611],
  "波特兰": [45.5155, 122.6789],
  "檀香山": [21.3099, 157.8581],
  "多伦多": [43.6532, 79.3832],
  "温哥华": [49.2827, 123.1207],
  "蒙特利尔": [45.5017, 73.5673],
  "渥太华": [45.4215, 75.6972],
  
  // 南美
  "圣保罗": [23.5505, 46.6333],
  "里约热内卢": [22.9068, 43.1729],
  "布宜诺斯艾利斯": [34.6037, 58.3816],
  "圣地亚哥": [33.4489, 70.6693],
  "利马": [12.0464, 77.0428],
  "波哥大": [4.7110, 74.0721],
  
  // 欧洲主要城市
  "伦敦": [51.5074, 0.1278],
  "巴黎": [48.8566, 2.3522],
  "柏林": [52.5200, 13.4050],
  "罗马": [41.9028, 12.4964],
  "马德里": [40.4168, 3.7038],
  "巴塞罗那": [41.3851, 2.1734],
  "阿姆斯特丹": [52.3676, 4.9041],
  "布鲁塞尔": [50.8503, 4.3517],
  "维也纳": [48.2082, 16.3738],
  "布拉格": [50.0755, 14.4378],
  "布达佩斯": [47.4979, 19.0402],
  "华沙": [52.2297, 21.0122],
  "苏黎世": [47.3769, 8.5417],
  "日内瓦": [46.2044, 6.1432],
  "慕尼黑": [48.1351, 11.5820],
  "法兰克福": [50.1109, 8.6821],
  "汉堡": [53.5511, 9.9937],
  "米兰": [45.4642, 9.1900],
  "威尼斯": [45.4408, 12.3155],
  "佛罗伦萨": [43.7696, 11.2558],
  "里斯本": [38.7223, 9.1393],
  "雅典": [37.9838, 23.7275],
  "哥本哈根": [55.6761, 12.5683],
  "斯德哥尔摩": [59.3293, 18.0686],
  "奥斯陆": [59.9139, 10.7522],
  "赫尔辛基": [60.1699, 24.9384],
  "都柏林": [53.3498, 6.2603],
  "爱丁堡": [55.9533, 3.1883],
  "利物浦": [53.4084, 2.9916],
  "曼彻斯特": [53.4808, 2.2426],
  "莫斯科": [55.7558, 37.6176],
  "圣彼得堡": [59.9343, 30.3351],
  "伊尔库茨克": [52.2977, 104.3113],
  "符拉迪沃斯托克": [43.1198, 131.8878],
  
  // 非洲主要城市
  "开罗": [30.0444, 31.2357],
  "约翰内斯堡": [26.2041, 28.0473],
  "开普敦": [33.9249, 18.4241],
  "内罗毕": [1.2921, 36.8219],
  "拉各斯": [6.5244, 3.3792],
  "亚的斯亚贝巴": [9.0192, 38.7525],
  "卡萨布兰卡": [33.5731, 7.5898],
  
  // 大洋洲主要城市
  "悉尼": [33.8688, 151.2093],
  "墨尔本": [37.8136, 144.9631],
  "布里斯班": [27.4698, 153.0251],
  "珀斯": [31.9505, 115.8605],
  "阿德莱德": [34.9285, 138.6007],
  "奥克兰": [36.8485, 174.7633],
  "惠灵顿": [41.2865, 174.7762],
};

function extractPlacesFromText(content: string, filepath: string): TextExtractResult {
  const filename = path.basename(filepath);
  const metadata = getFileMetadata(filepath);
  
  // 使用词典匹配地名
  const places: PlaceInfo[] = [];
  const seenPlaces = new Set<string>();
  let hasTime = false;
  let baseTime = metadata.created;
  
  // 查找每个地名在文本中的所有出现位置
  // 每个出现都生成一个独立点位，按文本位置排序
  const foundPlaces: Array<{index: number; name: string; coords: [number, number]}> = [];
  
  for (const [cityName, coords] of Object.entries(CITY_DICTIONARY)) {
    let startIndex = 0;
    while (true) {
      const idx = content.indexOf(cityName, startIndex);
      if (idx === -1) break;
      foundPlaces.push({ index: idx, name: cityName, coords });
      startIndex = idx + cityName.length;
    }
  }
  
  // 按在文本中出现的位置排序
  foundPlaces.sort((a, b) => a.index - b.index);
  
  for (const place of foundPlaces) {
    places.push({
      name: place.name,
      latitude: place.coords[0],
      longitude: place.coords[1],
    });
  }
  
  return {
    places,
    hasTime,
    baseTime,
    description: `从文本中提取了 ${places.length} 个地名`,
  };
}

function processTextFile(filepath: string, textContent: string): Point[] {
  const filename = path.basename(filepath);
  const metadata = getFileMetadata(filepath);
  const fileUrl = `file:///${filepath.replace(/\\/g, "/")}`;
  
  const llmPrompt = `请从以下文本中提取所有地名/地点信息。

要求：
1. 按文本出现顺序列出所有地名
2. 如果文本中有时间信息，请保留
3. 如果文本中没有时间信息，使用基础时间：${metadata.created}，并按出现顺序每处递增10分钟
4. 为每个地名提供经纬度坐标

返回格式：
{
  "route": [
    {
      "name": "地点名称",
      "description": "描述",
      "latitude": 纬度,
      "longitude": 经度,
      "time": "时间"
    }
  ]
}

文本内容：
---
${textContent.slice(0, 3000)}
---`;

  return [{
    filename,
    latitude: null,
    longitude: null,
    time: metadata.created,
    sourceUrl: fileUrl,
    description: llmPrompt,
  }];
}

async function processFile(filepath: string): Promise<Point[]> {
  const filename = path.basename(filepath);
  const metadata = getFileMetadata(filepath);
  const fileUrl = `file:///${filepath.replace(/\\/g, "/")}`;
  
  if (isImageFile(filepath)) {
    let latitude: number | null = null;
    let longitude: number | null = null;
    let time = metadata.created;
    try {
      const tags = await exifr.gps(filepath);
      if (tags && tags.latitude && tags.longitude) {
        latitude = tags.latitude;
        longitude = tags.longitude;
      }
    } catch {
      // EXIF read failed, fall through without GPS
    }
    // Get earliest time from EXIF + fs metadata
    time = await getEarliestFileTime(filepath);
    return [{
      filename,
      latitude,
      longitude,
      time,
      imageUrl: fileUrl,
      sourceUrl: fileUrl,
      description: `图片文件 - ${metadata.sizeReadable}`,
    }];
  }
  
  if (isVideoFile(filepath)) {
    let latitude: number | null = null;
    let longitude: number | null = null;
    let time = metadata.created;
    try {
      const tags = await exifr.gps(filepath);
      if (tags && tags.latitude && tags.longitude) {
        latitude = tags.latitude;
        longitude = tags.longitude;
      }
    } catch {
      // EXIF read failed, fall through without GPS
    }
    // Get earliest time from EXIF + fs metadata
    time = await getEarliestFileTime(filepath);
    return [{
      filename,
      latitude,
      longitude,
      time,
      videoUrl: fileUrl,
      sourceUrl: fileUrl,
      description: `视频文件 - ${metadata.sizeReadable}`,
    }];
  }
  
  if (isTextFile(filepath)) {
    const content = fs.readFileSync(filepath, "utf-8");
    return processTextFile(filepath, content);
  }
  
  return [];
}

async function processInput(inputPath: string): Promise<Point[]> {
  const points: Point[] = [];
  
  if (fs.existsSync(inputPath)) {
    if (fs.statSync(inputPath).isDirectory()) {
      const files = fs.readdirSync(inputPath);
      for (const file of files) {
        const filepath = path.join(inputPath, file);
        if (fs.statSync(filepath).isFile()) {
          const filePoints = await processFile(filepath);
          points.push(...filePoints);
        }
      }
    } else {
      const filePoints = await processFile(inputPath);
      points.push(...filePoints);
    }
  }
  
  return points;
}

function printUsage(exitCode = 0): never {
  console.log(`Map Trail Generator

Usage:
  npx -y bun main.ts <input> [options]

Options:
  --output <path>           Output HTML file path. Default: trail.html
  --title <text>            Map title. Default: 地图轨迹
  --osm                     Use OpenStreetMap tiles (default: Amap tiles)
  --cluster-threshold <N>   Cluster threshold percentage. Default: 5
  --nogroup                 Disable point clustering, show all markers
  --help                    Show this help

Examples:
  npx -y bun main.ts travel_diary.md                  (Leaflet + 高德)
  npx -y bun main.ts ./photos/ --osm                  (Leaflet + OSM)
  npx -y bun main.ts ./images/ --output my_trail.html --title "旅行轨迹"

Output:
  HTML file with interactive map using Leaflet (高德 or OpenStreetMap tiles).
`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage(0);
  }
  
  let inputPath = "";
  let outputPath = "trail.html";
  let title = "地图轨迹";
  let clusterThreshold = 5;
  let useOsm = false;
  let noGroup = false;
  let prompt = "";
  let eventsFile = "";
  
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
    } else if (arg === "--cluster-threshold") {
      clusterThreshold = parseInt(args[++i]);
    } else if (arg.startsWith("--cluster-threshold=")) {
      clusterThreshold = parseInt(arg.slice(20));
    } else if (arg === "--osm") {
      useOsm = true;
    } else if (arg === "--nogroup") {
      noGroup = true;
    } else if (arg === "--events-file") {
      eventsFile = args[++i];
    } else if (arg.startsWith("--events-file=")) {
      eventsFile = arg.slice(14);
    } else if (arg === "--prompt") {
      prompt = args[++i];
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice(9);
    } else {
      inputPath = arg;
    }
  }
  
  // Load externally provided events
  const externalPoints: Point[] = [];

  if (prompt) {
    const llmPrompt = `请根据用户描述"${prompt}"，提取出一系列有序地点及其时间信息。
请返回一个 JSON 对象，格式如下：
{
  "route": [
    {
      "name": "地点名称",
      "description": "该地点的简短描述（50字内）",
      "latitude": 纬度(数字),
      "longitude": 经度(数字),
      "time": "时间描述，如 YYYY-MM-DD HH:MM"
    }
  ]
}
请确保经纬度是准确的真实坐标。
请直接返回 JSON，不要任何多余的解释。`;

    const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
    
    if (apiKey) {
      console.error(`正在调用 LLM 解析提示词: ${prompt}`);
      const llmResponse = await callLlm(llmPrompt);
      
      try {
        const result = JSON.parse(llmResponse);
        const route = result.route || result;
        
        for (const ev of route) {
          externalPoints.push({
            filename: ev.name,
            description: ev.description || "",
            latitude: ev.latitude,
            longitude: ev.longitude,
            time: ev.time || "",
            imageUrl: null,
            videoUrl: null,
            sourceUrl: null,
          });
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
  if (eventsFile) {
    try {
      const events = JSON.parse(fs.readFileSync(eventsFile, "utf-8")) as Array<{
        name: string; description?: string; latitude: number; longitude: number; time?: string;
      }>;
      for (const ev of events) {
        externalPoints.push({
          filename: ev.name,
          description: ev.description || "",
          latitude: ev.latitude,
          longitude: ev.longitude,
          time: ev.time || "",
          imageUrl: null,
          videoUrl: null,
          sourceUrl: null,
        });
      }
    } catch (e) {
      console.error(`Error: Failed to parse --events-file JSON: ${e}`);
      process.exit(1);
    }
  }
  
  if (!inputPath && externalPoints.length === 0) {
    console.error("Error: No input specified");
    printUsage(1);
  }
  
  const points = externalPoints;
  if (inputPath) {
    points.push(...await processInput(inputPath));
  }
  if (points.length === 0) {
    console.error("Error: No files found or processed");
    process.exit(1);
  }
  
  const needsLlmPoints = points.filter(p => p.latitude === null && p.longitude === null && p.description);
  
  if (needsLlmPoints.length > 0) {
    const instructions = {
      needsLlmExtraction: true,
      prompt: needsLlmPoints.map(p => p.description).join("\n\n---\n\n"),
    };
    console.error(JSON.stringify(instructions, null, 2));
    process.exit(1);
  }
  
  const validPoints = points.filter(p => p.latitude !== null && p.longitude !== null);
  const finalPoints = noGroup ? validPoints : clusterPoints(points, clusterThreshold);
  
  generateMapHtml(finalPoints, outputPath, title, useOsm);
  
  console.log(JSON.stringify({
    success: true,
    message: "地图轨迹已生成",
    outputPath: path.resolve(outputPath),
    pointsCount: validPoints.length,
    markersCount: finalPoints.length,
    grouped: !noGroup,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
