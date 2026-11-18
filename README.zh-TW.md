# secret-vault

[English](README.md) | 繁體中文

**在 Claude Code 裡輸入 API key 或密碼，值永遠不會送給模型。**

Claude 需要憑證時，通常會請你把值貼進對話，或印出一段 `export API_KEY=...` 讓你自己去別處執行。`secret-vault` 給 Claude 第三條路：在你的 session 裡開一個遮罩輸入框，你在裡面輸入，Claude 只會收到「有沒有存好、存在哪裡」。

## 安裝

在 Claude Code 終端機的提示列輸入：

```
/plugin install secret-vault --marketplace allen-hsu/claude-code-secret-vault
```

出現詢問時按 `y` 加入 marketplace，再選擇範圍（選 user 範圍，之後每個 session 都會載入）。

從 shell 安裝：

```
claude plugin install secret-vault --marketplace allen-hsu/claude-code-secret-vault
```

## 使用

- **Claude 主動要**：任務需要憑證時，Claude 會呼叫 `mcp__secret-vault__request`，帶上變數名稱和一句說明，輸入框就會打開。內附的 skill 會告訴 Claude 這樣做，而不是請你貼上。
- **你自己開**：輸入 `/secret STRIPE_SECRET_KEY`。

輸入框只會顯示圓點和字數。選好要存到哪裡，按 Enter 儲存、Esc 取消：

| 存到 | 值放在哪裡 | Claude 怎麼用 |
| --- | --- | --- |
| `.env` 檔 | session 工作目錄裡的 `.env`，加引號、一個名稱一行 | 讓程式自己讀檔（`dotenv`、`docker compose --env-file` 等） |
| 本次 session | Claude Code 這個行程的環境變數，關掉就消失，不寫磁碟 | 在 shell 指令裡用 `$NAME`，由 shell 展開 |
| 私有保管庫 | 這個 plugin 自己在你電腦上的儲存區 | Claude 的任何工具都讀不到 |

「本次 session」只支援 [`hooks/register.tsx`](hooks/register.tsx) 開頭 `ENV_ALLOWLIST` 裡的名稱（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GITHUB_TOKEN`、`STRIPE_SECRET_KEY`）。plugin API 在這裡只接受寫死的名稱，所以要新增時，請同時加進這份清單和下面的 `switch`。其他名稱不會出現這個選項，輸入框裡會寫原因。

如果是 Claude 要的值，存好之後 plugin 會把結果告訴 Claude，讓它接著做。

## 其他功能

- **擋住讀取 `.env`**：用 Read、Edit、Write、Grep、Glob 碰 `.env` 會被擋下；shell 指令只要提到 `.env` 也會被擋，不管是哪個程式（`cat`、`python`、`base64`、`source` 等）。比對不分大小寫，因為在 macOS 上 `.ENV` 就是同一個檔案。把檔案交給程式自己讀（`--env-file .env`）不擋，範本檔（`.env.example`、`.env.sample`、`.env.template`）也不擋。
- **只接受一般的變數名稱**：名稱只能用英文字母、數字和底線，而且不能以數字開頭；其他名稱在開輸入框前就會被拒絕，所以名稱沒辦法替 `.env` 多寫出別的行。
- **遮蔽工具輸出裡的已知值**：這個 session 存過的值，只要 8 個字元以上，出現在任何工具的輸出時都會被換成 `[secret-vault: 已遮蔽]`，Claude 看不到原值。
- **貼錯地方的保險**：機密輸入框開著時，你在一般輸入框送出的內容會被攔下、不送給 Claude，並提示你改用機密輸入框。斜線指令照常放行。

## 設定

`/config` 裡有一列「輸入框位置」：

| 值 | 輸入框開在哪 | 打字 |
| --- | --- | --- |
| `pane`（預設） | 一個視窗；全螢幕介面下停靠在右側 | 打開就能直接輸入 |
| `band` | 輸入框正上方、整個寬度的橫條 | 要先點一下或按 `ctrl+x tab` |

視窗會要求 80 欄寬，但實際寬度由 Claude Code 決定：最多是終端機寬度的 45%，而且你拖過的寬度優先。版面會跟著實際寬度調整，窄的時候全部直排。

## 它擋不住什麼

這個工具的目的是避免機密不小心進到對話裡。它不是加密保險箱，也攔不住刻意去讀的程式：

- **`.env` 是明文檔案**：你電腦上任何程式都能讀。
- **擋 `.env` 是比對寫出來的路徑**：指令裡寫出這個檔名就會被擋；沒寫出檔名也能讀到它的方式（符號連結、執行時才組出來的路徑、由另一個腳本檔去開）擋不住。
- **遮蔽範圍有限**：只換掉一模一樣的字串，只處理 8 個字元以上的值，而且只限 Claude Code 這次啟動後存過的值；遮蔽清單只存在記憶體。
- **「本次 session」的值就是環境變數**：執行 `printenv` 這類指令就看得到。Claude Code 重開前會被遮蔽，重開後不會。
- **私有保管庫沒有加密**：Claude 的工具讀不到，但資料還是在你的電腦上。

## 運作方式

只有一個 hooks 模組：[`hooks/register.tsx`](hooks/register.tsx)。

- session 開始時註冊 `request` 工具和 `/secret` 指令。
- 工具和指令打開輸入框後立刻返回。hook 有 10 秒的時間限制，所以 plugin 從不在 hook 裡等你輸入。
- 一個 `ui.render` hook 畫出輸入框。你打的字只存在 plugin 的記憶體裡，輸入欄位裡永遠只有圓點。
- 一個 `tool.call` hook 擋下 `.env` 讀取，並遮蔽每個工具結果裡的已知值。
- 一個 `prompt.submit` hook 在輸入框開著時攔下一般輸入框的內容。

[`SKILL.md`](SKILL.md) 是告訴 Claude 什麼時候該用這個工具的 skill。

## 開發

```
claude --plugin-dir .        # 從這個資料夾載入 plugin 開一個 session
claude plugin validate .     # 檢查 manifest 和 hooks 模組
```

## 授權

MIT
