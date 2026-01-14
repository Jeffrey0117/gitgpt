# gitgpt

GPT 對話 CLI 工具，對話歷史自動 git 版控。

## 特色

- **互動式聊天** - 像 Claude Code 一樣的對話體驗
- **串流輸出** - 即時顯示 GPT 回應
- **Git 版控** - 每次對話自動 commit，方便追蹤與輸出
- **漸進式壓縮** - 長對話自動摘要，節省 token 費用
- **輕量** - 純 Node.js，無外部依賴

## 安裝

```bash
git clone https://github.com/Jeffrey0117/gitgpt.git
cd gitgpt
npm link
```

## 設定

```bash
gitgpt config --key <your-openai-api-key>
```

## 使用

```bash
# 開始新對話
gitgpt

# 繼續之前的對話
gitgpt -c <session-id>

# 列出所有對話
gitgpt list

# 輸出對話 JSON（給 UI 或其他用途）
gitgpt export <session-id>
```

## 對話中指令

| 指令 | 說明 |
|------|------|
| `?` | 顯示說明 |
| `/list` | 列出所有對話 |
| `/clear` | 清除畫面 |
| `/save` | 手動儲存 |
| `/exit` | 離開 |

## 資料儲存

所有資料存在 `~/.gitgpt/`：
- `config.json` - API Key 設定
- `conversations/` - 對話紀錄（git repo）

## 漸進式壓縮

當對話超過 3000 tokens：
- 自動摘要舊訊息
- 保留最近 6 則完整
- 壓縮率 20%~70%（越舊越壓）
- 使用 gpt-4o-mini 省錢

## License

MIT
