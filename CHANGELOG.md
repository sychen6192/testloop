# Changelog

使用者可見的變更記錄。更新方式：`git pull && npm install && npm run setup`。

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
