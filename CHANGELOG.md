# Changelog

使用者可見的變更記錄。更新方式：`git pull && npm install && npm run setup`。

## [1.1.1] - 2026-07-30

### Fixed
- **Windows 逾時會永久卡死。** 逾時只 signal 我們 spawn 的那個程序，但 npm 裝的
  `opencode.cmd` 必須經 cmd.exe，所以被殺的是外殼、opencode 仍在跑，還握著繼承來的
  stdout/stderr 管線——而 Node 的 `'close'` 要等管線關閉才觸發，於是整個 run 永遠不會結束
  （10 秒後的 SIGKILL 是送給一具屍體，什麼也沒做）。現在改殺整棵程序樹：Windows 用
  `taskkill /T /F`，POSIX 用 `detached` + process group signal；並補上 `'exit'` 保險，
  程序結束後最多再等 2 秒讓管線排空就收工。中斷（Ctrl-C）時也會一併帶走整棵樹。
- 逾時訊息不再自稱 `[OK] 完成`，改為 `[WARN] 逾時中止`，並提示調高 `UT_AGENT_TIMEOUT_MS`。
  被砍掉的 run 仍會把已收到的輸出交給 gate 判斷（fail-closed 不變）。

### Added
- README 前置需求與 Troubleshooting 補上 ripgrep：opencode 的 glob 與 grep 都由它實作，
  離線環境不會自動下載，缺了會讓兩個工具一律回 `[error]`。附各平台放置路徑與驗證指令。
- selftest 新增 `planKill` / `killTree` 案例，含「外層死掉但孫程序還在」的實際迴歸驗證。

## [1.1.0] - 2026-07-11

### Added
- Build gate fail-closed 加固：編譯成功但實際執行 0 個測試 → FAIL，失敗報告引導 writer
  建立測試（逃生口 `UT_ALLOW_ZERO_TESTS=1`）。堵住「writer 沒寫檔 → 0 測試 → 兩個 hard gate
  空過」的假通過鏈。
- Review gate fail-closed 加固：reviewer 未呼叫任何工具即輸出判決 → REJECT
  （逃生口 `UT_REVIEWER_MUST_READ=0`）。堵住「schema 合法但內容捏造」的 verdict。
  `AgentRunner.runReview` 介面隨之改為回傳 `{ text, toolCallCount }`。
- README troubleshooting 新增兩個實測根因：global `permission.edit: ask` 擋非互動寫檔
  （project `opencode.json` 解法）、plugin/MCP 開銷吃滿 context（`num_ctx` 調高解法）。

### Changed
- selftest 擴充：新增 `countTestsRun` 與 reviewer must-read guard 案例。

## [1.0.0] - 2026-07-10

### Added
- Central-clone 模式：工具 clone 一份即可對任意 Java repo 執行。
- `npm run setup`：agents + 評分 skill 安裝至 `~/.config/opencode/`（目標 repo 同名定義優先）。
- `npm run doctor`：preflight 自診；`--smoke` 經唯讀 reviewer 實測 provider。
- `bin/testgen` wrapper；工具版本戳記（banner 與 `runs/<repo>/<ts>/params.json`）。
- CI：GitHub Actions 跑 typecheck + selftest。

### Changed
- 目錄整併：`core/`、`review/` 併入根目錄與 `gates/`；三個 prompt 檔合為 `prompts.ts`。
- `runs/` 依目標 repo 名稱分隔命名空間。
- 程式碼註解全面改為極簡英文（文件與 runtime 訊息維持繁中）。
