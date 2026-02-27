import { readFileSync } from 'fs';
import type { RenderContext } from '../../types.js';
import { dim } from '../colors.js';

const MAX_PROMPT_LENGTH = 80;

interface TranscriptMessage {
  type: string;
  message?: {
    content: string | Array<{ type: string; text: string }>;
  };
}

function getLastPrompt(transcriptPath: string): string | null {
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');

    let lastPrompt = '';

    // 从后往前找最后一个用户消息
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg: TranscriptMessage = JSON.parse(lines[i]);
        if (msg.type === 'user' && msg.message?.content) {
          const content = msg.message.content;
          if (typeof content === 'string') {
            lastPrompt = content;
          } else if (Array.isArray(content)) {
            // 提取所有文本块
            lastPrompt = content
              .filter((item): item is { type: string; text: string } => item.type === 'text')
              .map(item => item.text)
              .join(' ');
          }
          break;
        }
      } catch {
        continue;
      }
    }

    if (!lastPrompt.trim()) {
      return null;
    }

    // 限制长度
    if (lastPrompt.length > MAX_PROMPT_LENGTH) {
      lastPrompt = lastPrompt.slice(0, MAX_PROMPT_LENGTH) + '...';
    }

    return lastPrompt;
  } catch {
    return null;
  }
}

export function renderLastPromptLine(ctx: RenderContext): string | null {
  const transcriptPath = ctx.stdin.transcript_path;
  if (!transcriptPath) {
    return null;
  }

  const prompt = getLastPrompt(transcriptPath);
  if (!prompt) {
    return null;
  }

  return `${dim('last prompt:')} ${prompt}`;
}
