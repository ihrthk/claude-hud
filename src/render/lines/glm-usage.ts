import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { RESET } from '../colors.js';
import { getContextColor } from '../colors.js';

interface GLMApiResponse {
  code: number;
  data?: {
    limits?: Array<{
      type: string;
      unit?: number;
      number?: number;
      usage?: number;
      currentValue?: number;
      percentage?: number;
      nextResetTime?: number;
      usageDetails?: Array<{ modelCode: string; usage: number }>;
    }>;
  };
}

const CACHE_DIR = `${process.env.HOME}/.claude/plugins/claude-hud`;
const CACHE_FILE = path.join(CACHE_DIR, '.glm-usage-cache.json');
const CACHE_TTL = 300_000; // 5 分钟
const BACKGROUND_UPDATE_FILE = path.join(CACHE_DIR, '.glm-usage-updating.flag');

interface CacheEntry {
  data: string;
  timestamp: number;
}

function writeCache(data: string): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const cache: CacheEntry = { data, timestamp: Date.now() };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch {
    // Ignore cache write failures
  }
}

function fetchGLMUsage(): Promise<string | null> {
  return new Promise((resolve) => {
    const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://open.bigmodel.cn/api/anthropic';

    if (!apiKey) {
      resolve(null);
      return;
    }

    // 从 BASE_URL 提取域名
    const domainMatch = baseUrl.match(/https:\/\/([^/]+)/);
    const domain = domainMatch ? domainMatch[1] : 'open.bigmodel.cn';

    const options = {
      hostname: domain,
      path: '/api/monitor/usage/quota/limit',
      method: 'GET',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        resolve(formatGLMUsage(data));
      });
    });

    req.on('error', () => { resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function formatGLMUsage(jsonData: string): string | null {
  try {
    const response: GLMApiResponse = JSON.parse(jsonData);
    if (response.code !== 200 || !response.data?.limits) {
      return null;
    }

    // 获取所有 TOKENS_LIMIT 条目
    const tokenLimits = response.data.limits.filter(l => l.type === 'TOKENS_LIMIT');
    const timeLimit = response.data.limits.find(l => l.type === 'TIME_LIMIT');

    if (tokenLimits.length === 0) return null;

    // 按unit分组：unit=3 (5×10^3=5K) 是5小时配额，unit=6 (1×10^6=1M) 是7天配额
    const fiveHourLimit = tokenLimits.find(l => l.unit === 3);
    const sevenDayLimit = tokenLimits.find(l => l.unit === 6);

    // 至少需要一个配额
    if (!fiveHourLimit && !sevenDayLimit) return null;

    let output = 'glm usage:';

    // 先添加 5 小时配额
    if (fiveHourLimit) {
      const percent = fiveHourLimit.percentage ?? 0;
      let resetStr = '';
      if (fiveHourLimit.nextResetTime) {
        const resetDate = new Date(fiveHourLimit.nextResetTime);
        const hours = resetDate.getHours().toString().padStart(2, '0');
        const minutes = resetDate.getMinutes().toString().padStart(2, '0');
        resetStr = `(${hours}:${minutes})`;
      }
      output += ` 5h: ${percent}% ${resetStr}`;
    }

    // 再添加 7 天配额
    if (sevenDayLimit) {
      const percent = sevenDayLimit.percentage ?? 0;
      let resetStr = '';
      if (sevenDayLimit.nextResetTime) {
        const resetDate = new Date(sevenDayLimit.nextResetTime);
        const month = (resetDate.getMonth() + 1).toString().padStart(2, '0');
        const day = resetDate.getDate().toString().padStart(2, '0');
        const hours = resetDate.getHours().toString().padStart(2, '0');
        const minutes = resetDate.getMinutes().toString().padStart(2, '0');
        resetStr = `(${month}-${day} ${hours}:${minutes})`;
      }
      output += ` | 7d: ${percent}% ${resetStr}`;
    }

    // 添加 MCP 使用情况
    if (timeLimit && timeLimit.currentValue !== undefined) {
      const mcpPercent = timeLimit.percentage ?? 0;
      const mcpCurrent = timeLimit.currentValue;
      const mcpTotal = timeLimit.usage ?? 100;

      let mcpDetails = '';
      if (timeLimit.usageDetails && timeLimit.usageDetails.length > 0) {
        mcpDetails = timeLimit.usageDetails
          .map(d => `${d.modelCode}: ${d.usage}`)
          .join(', ');
      }

      output += ` | glm mcp: ${mcpPercent}% (${mcpCurrent}/${mcpTotal})`;
      if (mcpDetails) {
        output += ` [${mcpDetails}]`;
      }
    }

    return output;
  } catch {
    return null;
  }
}

function getGLMUsage(): string | null {
  const now = Date.now();

  // 先读缓存（即使过期也返回，保证状态栏快速显示）
  let cached: CacheEntry | null = null;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const content = fs.readFileSync(CACHE_FILE, 'utf8');
      cached = JSON.parse(content);
    }
  } catch {
    // Ignore cache read errors
  }

  // 检查是否需要后台更新
  const needsUpdate = !cached || (now - cached.timestamp > CACHE_TTL);

  // 触发后台更新（不阻塞）
  if (needsUpdate && !isBackgroundUpdateRunning()) {
    triggerBackgroundUpdate();
  }

  // 返回缓存数据（可能是过期的，或者 null）
  return cached?.data ?? null;
}

// 后台更新超时时间（30秒）
const UPDATE_TIMEOUT_MS = 30_000;

// 检查是否有后台更新正在运行
function isBackgroundUpdateRunning(): boolean {
  try {
    if (!fs.existsSync(BACKGROUND_UPDATE_FILE)) {
      return false;
    }

    // 读取文件时间戳，检查是否超时
    const timestamp = parseInt(fs.readFileSync(BACKGROUND_UPDATE_FILE, 'utf8'), 10);
    const isStale = Date.now() - timestamp > UPDATE_TIMEOUT_MS;

    if (isStale) {
      // 删除过期的标志文件
      fs.unlinkSync(BACKGROUND_UPDATE_FILE);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// 触发后台更新（fire and forget）
function triggerBackgroundUpdate(): void {
  try {
    // 创建更新标志文件
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(BACKGROUND_UPDATE_FILE, Date.now().toString(), 'utf8');

    // 后台异步更新，不等待结果
    fetchGLMUsage().then((data) => {
      if (data) {
        writeCache(data);
      }
      // 删除更新标志文件
      try {
        fs.unlinkSync(BACKGROUND_UPDATE_FILE);
      } catch {
        // Ignore
      }
    }).catch(() => {
      // 更新失败，删除标志文件
      try {
        fs.unlinkSync(BACKGROUND_UPDATE_FILE);
      } catch {
        // Ignore
      }
    });
  } catch {
    // Ignore trigger errors
  }
}

export function renderGLMUsageLine(): string | null {
  const usage = getGLMUsage();
  if (!usage) {
    return null;
  }

  let result = usage;

  // 匹配 7d: XX% 和 5h: XX%
  const sevenDayMatch = usage.match(/7d:\s*(\d+)%/);
  const fiveHourMatch = usage.match(/5h:\s*(\d+)%/);
  const mcpMatch = usage.match(/glm mcp:\s*(\d+)%/);

  if (sevenDayMatch) {
    const percent = parseInt(sevenDayMatch[1], 10);
    const color = getContextColor(percent);
    result = result.replace(/7d:\s*(\d+)%/, `7d: ${color}$1%${RESET}`);
  }

  if (fiveHourMatch) {
    const percent = parseInt(fiveHourMatch[1], 10);
    const color = getContextColor(percent);
    result = result.replace(/5h:\s*(\d+)%/, `5h: ${color}$1%${RESET}`);
  }

  if (mcpMatch) {
    const mcpPercent = parseInt(mcpMatch[1], 10);
    const color = getContextColor(mcpPercent);
    result = result.replace(/glm mcp:\s*(\d+)%/, `glm mcp: ${color}$1%${RESET}`);
  }

  return result;
}
