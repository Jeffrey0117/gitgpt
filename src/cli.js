#!/usr/bin/env node

import readline from 'readline';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { streamChat, getApiKey, setApiKey } from './gpt.js';

const STORE_DIR = path.join(os.homedir(), '.gitgpt');
const CONVERSATIONS_DIR = path.join(STORE_DIR, 'conversations');

// ANSI 顏色
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
};

// 確保目錄存在並初始化 git
function ensureGitRepo() {
  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }
  const gitDir = path.join(CONVERSATIONS_DIR, '.git');
  if (!fs.existsSync(gitDir)) {
    execSync('git init', { cwd: CONVERSATIONS_DIR, stdio: 'ignore' });
  }
}

// 儲存對話並 git commit
function saveConversation(sessionId, messages) {
  if (!messages || messages.length === 0) return;

  ensureGitRepo();
  const filePath = path.join(CONVERSATIONS_DIR, `${sessionId}.json`);
  const data = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    messages
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  try {
    execSync(`git add "${sessionId}.json"`, { cwd: CONVERSATIONS_DIR, stdio: 'ignore' });
    execSync(`git commit -m "Update ${sessionId}"`, { cwd: CONVERSATIONS_DIR, stdio: 'ignore' });
  } catch (e) {}
}

// 產生 session ID
function generateSessionId() {
  const now = new Date();
  return now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

// 列出所有對話
function listConversations() {
  ensureGitRepo();
  const files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('  (沒有對話記錄)');
    return;
  }
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, file), 'utf-8'));
    const preview = data.messages.find(m => m.role === 'user')?.content?.slice(0, 40) || '';
    console.log(`  ${c.dim}${data.id}${c.reset}  ${preview}${preview.length >= 40 ? '...' : ''}`);
  }
}

// 清除當前行
function clearLine() {
  process.stdout.write('\r\x1b[K');
}

// 估算 token
function estimateTokens(text) {
  if (Array.isArray(text)) {
    return text.reduce((sum, msg) => sum + estimateTokens(msg.content || ''), 0);
  }
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = text.length - chinese;
  return chinese * 2 + Math.ceil(other / 4);
}

// 漸進式壓縮對話
// 策略：保留最近的完整，越舊壓縮越多
const COMPRESS_THRESHOLD = 3000;  // 超過這個 token 數開始壓縮
const KEEP_RECENT = 6;            // 保留最近 N 則完整訊息

async function compressMessages(messages) {
  const total = estimateTokens(messages);
  if (total < COMPRESS_THRESHOLD || messages.length <= KEEP_RECENT + 2) {
    return messages;
  }

  // 分割：摘要部分 | 要壓縮的舊訊息 | 保留的新訊息
  const hasExistingSummary = messages[0]?.role === 'system' && messages[0]?.content?.startsWith('[對話摘要]');
  const startIdx = hasExistingSummary ? 1 : 0;
  const oldMessages = messages.slice(startIdx, -KEEP_RECENT);
  const recentMessages = messages.slice(-KEEP_RECENT);

  if (oldMessages.length < 2) {
    return messages;
  }

  // 計算壓縮比例 - 越多越壓
  const oldTokens = estimateTokens(oldMessages);
  const ratio = Math.min(0.7, oldTokens / 5000 * 0.5 + 0.2); // 20%~70% 壓縮率
  const targetLength = Math.floor(oldTokens * (1 - ratio));

  // 請 GPT 摘要舊對話
  const summaryPrompt = [
    {
      role: 'system',
      content: `你是摘要助手。請將以下對話歷史壓縮成約 ${targetLength} tokens 的摘要。
保留關鍵資訊、決定、程式碼片段。用條列式。不要加額外解釋。`
    },
    {
      role: 'user',
      content: oldMessages.map(m => `${m.role}: ${m.content}`).join('\n\n')
    }
  ];

  try {
    let summary = '';
    for await (const chunk of streamChat(summaryPrompt, { model: 'gpt-4o-mini' })) {
      summary += chunk;
    }

    const existingSummary = hasExistingSummary ? messages[0].content.replace('[對話摘要]\n', '') + '\n\n' : '';
    const newSummary = {
      role: 'system',
      content: `[對話摘要]\n${existingSummary}${summary}`
    };

    console.log(`${c.dim}(已壓縮 ${oldMessages.length} 則舊訊息，節省約 ${Math.floor(oldTokens * ratio)} tokens)${c.reset}\n`);

    return [newSummary, ...recentMessages];
  } catch (e) {
    // 壓縮失敗就維持原樣
    return messages;
  }
}

// Spinner
class Spinner {
  constructor() {
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.i = 0;
    this.interval = null;
    this.text = '';
  }

  start(tokens) {
    this.text = ` Thinking... ${c.dim}(ctrl+c · ↑${tokens} tokens)${c.reset}`;
    process.stdout.write(`${c.yellow}${this.frames[0]}${c.reset}${this.text}`);
    this.interval = setInterval(() => {
      this.i++;
      process.stdout.write(`\r${c.yellow}${this.frames[this.i % this.frames.length]}${c.reset}`);
    }, 80);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    clearLine();
  }
}

// 歡迎畫面
function showWelcome(sessionId) {
  console.clear();
  console.log(`${c.dim}──${c.reset} ${c.bold}${c.cyan}gitgpt${c.reset} ${c.dim}${'─'.repeat(50)}${c.reset}`);
  console.log('');
  console.log(`    ${c.green}  ▄▄▄▄▄  ${c.reset}`);
  console.log(`    ${c.green} █ ◕◕ █ ${c.reset}`);
  console.log(`    ${c.green} █  ▽  █${c.reset}`);
  console.log(`    ${c.green}  ▀▀▀▀▀ ${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}GPT-4o · ${c.cyan}${sessionId}${c.reset}`);
  console.log('');

  console.log(`  ${c.yellow}快速開始${c.reset}  ${c.dim}直接打字開始對話${c.reset}`);
  console.log(`  ${c.yellow}?${c.reset}          ${c.dim}查看指令${c.reset}`);
  console.log('');

  // 最近對話
  ensureGitRepo();
  const files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json')).slice(-3);
  if (files.length > 0) {
    console.log(`  ${c.yellow}最近對話${c.reset}`);
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, file), 'utf-8'));
      const preview = data.messages.find(m => m.role === 'user')?.content?.slice(0, 25) || '';
      console.log(`  ${c.dim}${data.id}${c.reset} ${preview}...`);
    }
    console.log('');
  }
}

// 顯示輸入提示
function showPrompt() {
  console.log(`${c.dim}${'─'.repeat(60)}${c.reset}`);
}

// 主要聊天迴圈
async function startChat(sessionId = null, existingMessages = []) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  sessionId = sessionId || generateSessionId();
  const messages = [...existingMessages];

  ensureGitRepo();
  showWelcome(sessionId);

  const askQuestion = () => {
    showPrompt();
    rl.question(`${c.cyan}❯${c.reset} `, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        askQuestion();
        return;
      }

      // 指令
      if (trimmed === '?' || trimmed.startsWith('/')) {
        const cmd = trimmed === '?' ? 'help' : trimmed.slice(1).toLowerCase();
        console.log('');
        switch (cmd) {
          case 'exit':
          case 'quit':
          case 'q':
            saveConversation(sessionId, messages);
            console.log(`${c.dim}對話已儲存，再見！${c.reset}`);
            process.exit(0);
          case 'save':
            saveConversation(sessionId, messages);
            console.log(`${c.dim}已儲存${c.reset}`);
            break;
          case 'list':
            listConversations();
            break;
          case 'clear':
            showWelcome(sessionId);
            break;
          case 'help':
            console.log(`${c.yellow}?${c.reset}       說明`);
            console.log(`${c.yellow}/list${c.reset}   所有對話`);
            console.log(`${c.yellow}/clear${c.reset}  清除畫面`);
            console.log(`${c.yellow}/save${c.reset}   儲存`);
            console.log(`${c.yellow}/exit${c.reset}   離開`);
            break;
          default:
            console.log(`${c.dim}未知指令: ${cmd}${c.reset}`);
        }
        console.log('');
        askQuestion();
        return;
      }

      // GPT
      messages.push({ role: 'user', content: trimmed });
      console.log('');

      // 檢查是否需要壓縮
      const compressed = await compressMessages(messages);
      if (compressed !== messages) {
        messages.length = 0;
        messages.push(...compressed);
      }

      const spinner = new Spinner();
      let firstChunk = true;

      try {
        spinner.start(estimateTokens(messages));
        let fullResponse = '';

        for await (const chunk of streamChat(messages)) {
          if (firstChunk) {
            spinner.stop();
            process.stdout.write(`${c.dim}│${c.reset} `);
            firstChunk = false;
          }
          const formatted = chunk.replace(/\n/g, `\n${c.dim}│${c.reset} `);
          process.stdout.write(formatted);
          fullResponse += chunk;
        }

        console.log('\n');
        messages.push({ role: 'assistant', content: fullResponse });
        saveConversation(sessionId, messages);

      } catch (error) {
        spinner.stop();
        console.log(`${c.yellow}錯誤: ${error.message}${c.reset}\n`);
      }

      askQuestion();
    });
  };

  rl.on('close', () => {
    saveConversation(sessionId, messages);
    console.log(`\n${c.dim}對話已儲存${c.reset}`);
    process.exit(0);
  });

  // 底部提示
  console.log(`${c.dim}  ? for help${c.reset}`);
  console.log('');
  askQuestion();
}

// 載入對話
function loadConversation(id) {
  const filePath = path.join(CONVERSATIONS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    console.error(`找不到對話: ${id}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// 輸出對話
function exportConversation(id) {
  const data = loadConversation(id);
  console.log(JSON.stringify(data, null, 2));
}

// 主程式
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'help':
    case '-h':
    case '--help':
      console.log(`
gitgpt - GPT 對話工具

  gitgpt                 開始對話
  gitgpt -c <id>         繼續對話
  gitgpt list            列出對話
  gitgpt export <id>     輸出 JSON
  gitgpt config --key X  設定 API Key
`);
      break;
    case 'list':
    case 'ls':
      ensureGitRepo();
      listConversations();
      break;
    case 'export':
      if (!args[1]) { console.error('用法: gitgpt export <id>'); process.exit(1); }
      exportConversation(args[1]);
      break;
    case 'config':
      if (args[1] === '--key' && args[2]) {
        setApiKey(args[2]);
        console.log('API Key 已儲存');
      } else {
        console.error('用法: gitgpt config --key <key>');
      }
      break;
    case '-c':
    case '--continue':
      if (!args[1]) { console.error('用法: gitgpt -c <id>'); process.exit(1); }
      const data = loadConversation(args[1]);
      await startChat(data.id, data.messages);
      break;
    default:
      if (!getApiKey()) {
        console.log('請先設定 API Key:\n  gitgpt config --key <your-key>');
        process.exit(1);
      }
      await startChat();
  }
}

main().catch(console.error);
