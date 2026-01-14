import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_FILE = path.join(os.homedir(), '.gitgpt', 'config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  }
  return {};
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getApiKey() {
  const config = loadConfig();
  return config.apiKey || process.env.OPENAI_API_KEY;
}

export function setApiKey(key) {
  const config = loadConfig();
  config.apiKey = key;
  saveConfig(config);
}

export async function chat(messages, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('請先設定 API Key: gitgpt config --key <your-key>');
  }

  const model = options.model || 'gpt-4o';

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API 錯誤: ${response.status} ${error}`);
  }

  return response.body;
}

export async function* streamChat(messages, options = {}) {
  const body = await chat(messages, options);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const json = JSON.parse(trimmed.slice(6));
        const content = json.choices?.[0]?.delta?.content;
        if (content) {
          yield content;
        }
      } catch (e) {
        // 忽略解析錯誤
      }
    }
  }
}
