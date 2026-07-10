# CHANGES — 相對原版（qwen/scripts/write-java-ut.mts）的行為差異

重寫策略：以既定架構整份重寫，行為對齊原版 + 下列修正。逐條可驗。

## 修正（原版的 bug 或缺口）

1. **多模組 Maven 支援**（原版會壞）
   - 原版：`mvn test` 固定在 repo 根跑、報告固定找 `REPO_ROOT/target/`
     → 多模組下跑整個 reactor、JaCoCo/surefire 永遠找不到。
   - 現在：由目標路徑自動偵測模組（`findModuleInfo`），
     `mvn -pl <module> -am -DskipITs test`，報告到 `<module>/target/` 找。
2. **JaCoCo 解析 bug**（原版覆蓋率被嚴重低估）
   - 原版：取 class block「第一個」counter = 第一個 method 的 counter。
   - 現在：優先取 `<sourcefile>` 檔案級彙總（含 inner class）；退回 class block
     時取「最後一個」counter（class 級彙總）。selftest 含此 regression case。
   - 另以來源路徑推 package 先縮小到對的 `<package>` 區塊，避免同名檔誤中。
3. **Review gate 換血**（原版 binary 零容忍會 thrash）
   - 原版：APPROVE 條件 = issues 為空 → LLM 幾乎每輪都找得到新毛病。
   - 現在：六維分數（門檻 4/4/4/3/4/3 可調）+ blockers / advisories 分級；
     通過 = blockers 空 且 六維達門檻；**advisories 不進下一輪 feedback**。
4. **Verdict fail-closed 強化**：缺欄位、分數超出 1-5、非 JSON 一律 REJECT
   附原因，絕不拋錯中斷 loop。
5. **無 JaCoCo 時的放行漏洞**：新增 `UT_STRICT_COV=1` 可改為 FAIL。
6. **標準檔預設路徑**：`qwen/standards/...` → `tools/testgen/standards/...`
   （跟著 pipeline 走，`UT_STANDARDS_PATH` 可覆蓋）。

## 新增（這輪設計定案的機制）

7. **OpencodeRunner**：spawn + `--format json` JSONL 逐行事件即時轉印
   （解掉「卡 heartbeat 看不到進度」）；wall-clock timeout（SIGTERM→SIGKILL）
   取代 maxSessionTurns；未指定模型時由 agent .md 的 model 決定。
8. **Startup guard**：啟動時 assert 兩個 agent .md 的權限 frontmatter
   （writer 無 bash / reviewer 全唯讀），違反第一秒 die。`UT_SKIP_GUARD=1` 可跳過。
9. **Rubric 注入**：loop 讀 skill 檔案（.opencode/skills → .claude/skills）
   注入 reviewer prompt；injection over discovery，不靠 skill 機制觸發。
10. **Artifacts 落盤**：`runs/<ts>/iter-N/` 全套（prompt / writer-summary /
    build.log 完整輸出 / coverage / verdict / feedback）+ params + summary。
11. **Runner factory + qwen 備援**：`UT_RUNNER=qwen` 走動態 import，
    未裝 SDK 完全不影響預設路徑（核心維持零 SDK import）。
12. **Writer prompt 補六維一句話定義**（只給優化方向，不給評分細則）。
13. **單一 .java 檔也可當目標**（原版 TODO）。
14. **.env 自動載入**（tools/testgen/.env，不覆蓋既有環境變數）。

## 沿用不變

迭代順序與步驟語義、surefire/gradle 失敗摘要、log/heartbeat 風格、
fix/generate prompt 的硬性限制（不改 production code、禁 @Disabled、
不得刪有效測試）、exit code 慣例（成功 0 / 迭代用盡 2 / 致命錯 1）。

## v2 — skill test-quality-evaluator 整併對齊

15. **skill 原封打包**進 `.opencode/skills/test-quality-evaluator/`
    （SKILL.md + references/ 完整保留，互動模式照常可用）。
16. **量表對齊**：verdict 由 1-5 改為 skill rubric 的 **0-10 整數**制，
    門檻預設 7/7/7/6/7/6；非整數/超界 fail-closed。
17. **weighted_score + grade 確定性計算**：pipeline 依 skill 權重
    （25/20/15/15/15/10）與 bands（85/70/55）計算，LLM 不算分
    （落實 skill 原則 P1/P3）。grade 僅供報告，gate 條件不變。
18. **rubric loader 重寫**（libs/rubric.ts）：注入 `references/rubric.md`
    （fallback rubric.md → rubric/*.md），**絕不注入 SKILL.md 全文**
    ——批次稽核 workflow 對單輪 gate reviewer 是錯誤指令。
19. **severity 語彙對齊**：review prompt 明定 blockers ≈ severity=high、
    advisories ≈ medium/low；並補 quantitative signals 誠實條款
    （coverage 等硬訊號由 hard gate 負責，reviewer 勿推估）。
20. **review-prompt.md 落盤**：每輪 reviewer 收到的完整 prompt 進 artifacts，
    rubric 注入可事後稽核。

## v4 — runner 事件解析修正（實測對齊）

21. **traceEvent 事件型別對齊實測輸出**：opencode `--format json` 的真正型別在
    `part.type` 且用連字號（step-start / step-finish / text / tool），
    原本比對 `ev.type` 的 step_start/tool_use 全部 miss，導致 text 事件未累積、
    reviewer 輸出被當成空字串 → fail-closed 誤判 REJECT。
    現以 part.type 為準、連字號與底線都相容、part.type 缺漏時退回 ev.type。
22. **finalText 取值加保險**：累積全文為空時退回「最後一個 text part」
    （模型常把最終 JSON 放在最後一個完整 text part）。
23. 以使用者實際貼回的事件結構做回歸驗證，確認 text 累積 + verdict 解析成功。

## v6 — 回退 v5 SOLID 重構（overdesign），基準 = v4

24. 架構回到 v4 扁平版（單一 config.ts、gates/build.ts + coverage.ts、
    review/gate.ts）。v5 的 Gate 介面 / BuildToolStrategy / 全面 DI 判定為
    對此規模 overdesign，否決理由與重新提案門檻已記入 DESIGN.md。
25. 保留 v5 唯一有普遍價值的部分：traceEvent 的 6 條 regression 測試
    （守 v4 修的事件解析 bug），代價僅為 runners/opencode.ts 的
    traceEvent 加 export。selftest 28 → 34。
26. 行為與 v4 完全一致（e2e oracle 重跑驗證）。
