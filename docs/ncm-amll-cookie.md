# NCM：AMLL 歌词与环境变量 Cookie

分支 `feat/ncm-source`，基于 `b3d09d6`；未执行 git commit。

- NCM 从 `AppState::with_sources` 接收与 QQ 相同的 `amll_api`，并行请求 `GET /v1/lyrics/get?ncmMusicId={id}` 与原生 lyric_new。候选顺序为 AMLL → YRC → LRC；复用 QQ 的 TTML 内容检查与 300 秒重试 TTL。全部失败返回 502、不缓存；任一失败缓存 300 秒，全空 1 小时，命中 7 天。原始歌词下载仍提供原有格式。
- 前端把 QQ 既有候选选择循环提为共用模块。NCM 的详情页、播放器使用原有 TTML 解析器消费 AMLL，解析异常或无歌词行时继续尝试 YRC/LRC；保留 TTML 自带翻译、音译。
- 配置改为 `--ncm-cookie` / `FANTASTIC_NCM_COOKIE`：包含 `MUSIC_U=` 时解析完整串，否则包装为 MUSIC_U；空串或纯空白使用匿名访问。启动时初始化 jar，继续合并上游 Set-Cookie。文件读取、0600、热替换/generation、PUT/DELETE/status 接口、整个设置区块及其样式和翻译文案均已删除。

部署时设置 `FANTASTIC_NCM_COOKIE='MUSIC_U=your-value; __csrf=your-csrf'`，也可直接填 `FANTASTIC_NCM_COOKIE='your-value'`；修改后重启服务。

验证工具链：`rustc 1.100.0`、`clippy 0.1.100`（stable）。

| 检查 | 结果 |
| --- | --- |
| `cargo +stable test --workspace --no-fail-fast` | 223 通过、36 失败、1 忽略；36 项失败均为沙箱禁止回环监听（`Operation not permitted`），涉及 fantastic lib、client_limit、local_wrapper、mv_api、qq_upstream 五个 target。未启用跳过环境变量；新增 AMLL HTTP mock 也受此限制。 |
| NCM 离线测试：`cargo +stable test -p fantastic --lib ncm::tests:: -- --skip amll_fetch_uses_ncm_music_id_and_handles_missing_and_failed_responses` | 36 通过；只过滤上述需监听端口的 mock。覆盖候选顺序、TTL 三态、原文下载、完整串/裸值/空 Cookie、CLI/env 优先级、Set-Cookie 合并及删除的管理接口。 |
| `node tests/run.mjs unit` | 23/24 个文件通过；serverless 的静态构建用例在 `execFileSync(/usr/bin/node, …)` 报沙箱 `EPERM`，该文件单独执行为 15 通过、1 失败。 |
| `node tests/run.mjs unit ncm qq` | 5/5 个文件通过，包含 AMLL 优先、解析失败回退、翻译音译保留和设置页移除检查。 |
| `node scripts/build-static.mjs /tmp/ncm-static-check` | 单独执行成功，生成 307 个文件，包含共用歌词候选模块。 |
| `cargo +stable clippy --workspace --all-targets -- -D warnings` | 通过，零警告。 |
| `git diff --check` | 通过。 |
