import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import type { RenderContext } from '../../types.js';
import { dim, RESET } from '../colors.js';
import { getContextColor } from '../colors.js';

interface GLMUsageData {
  tokenPercent: number;
  tokenCurrent: string;
  tokenTotal: string;
  tokenUnit: string;
  resetTime?: string;
  mcpPercent?: number;
  mcpCurrent?: string;
  mcpTotal?: string;
  mcpDetails?: string;
}

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

function readCache(): string | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;

    const content = fs.readFileSync(CACHE_FILE, 'utf8');
    const cache: CacheEntry = JSON.parse(content);

    if (Date.now() - cache.timestamp > CACHE_TTL) {
      return null;
    }

    return cache.data;
  } catch {
    return null;
  }
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
    const apiUrl = `https://${domain}/api/monitor/usage/quota/limit`;

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

    const tokenLimit = response.data.limits.find(l => l.type === 'TOKENS_LIMIT');
    const timeLimit = response.data.limits.find(l => l.type === 'TIME_LIMIT');

    if (!tokenLimit) return null;

    const tokenPercent = tokenLimit.percentage ?? 0;
    const unit = tokenLimit.unit ?? 0;
    const number = tokenLimit.number ?? 0;
    const tokenTotal = number * Math.pow(10, unit);
    const tokenCurrent = Math.round(tokenTotal * tokenPercent / 100);

    // 智能选择单位
    let tokenCurrentFmt: string;
    let tokenTotalFmt: string;
    let tokenUnit: string;

    if (tokenTotal < 1_000_000) {
      tokenCurrentFmt = (tokenCurrent / 1000).toFixed(1);
      tokenTotalFmt = (tokenTotal / 1000).toFixed(1);
      tokenUnit = 'K';
    } else {
      tokenCurrentFmt = (tokenCurrent / 1_000_000).toFixed(1);
      tokenTotalFmt = (tokenTotal / 1_000_000).toFixed(1);
      tokenUnit = 'M';
    }

    // 格式化重置时间
    let resetTimeStr = '';
    if (tokenLimit.nextResetTime) {
      const resetDate = new Date(tokenLimit.nextResetTime);
      const hours = resetDate.getHours().toString().padStart(2, '0');
      const minutes = resetDate.getMinutes().toString().padStart(2, '0');
      resetTimeStr = `reset: ${hours}:${minutes}`;
    }

    let output = `usage: ${tokenPercent}% (${tokenCurrentFmt}${tokenUnit}/${tokenTotalFmt}${tokenUnit})`;
    if (resetTimeStr) {
      output += ` ${resetTimeStr}`;
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

      output += ` | mcp: ${mcpPercent}% (${mcpCurrent}/${mcpTotal})`;
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

  // 解析并添加颜色
  const percentMatch = usage.match(/usage:\s*(\d+)%/);
  const mcpMatch = usage.match(/mcp:\s*(\d+)%/);

  let result = usage;

  if (percentMatch) {
    const tokenPercent = parseInt(percentMatch[1], 10);
    const color = getContextColor(tokenPercent);
    result = result.replace(/usage:\s*(\d+)%/, `usage: ${color}$1%${RESET}`);
  }

  if (mcpMatch) {
    const mcpPercent = parseInt(mcpMatch[1], 10);
    const color = getContextColor(mcpPercent);
    result = result.replace(/mcp:\s*(\d+)%/, `mcp: ${color}$1%${RESET}`);
  }

  return `${dim('📊')} ${result}`;
}
