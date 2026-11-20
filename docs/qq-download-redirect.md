# QQ 下载改为 302 跳转

- QQ `/qq/song/:mid/download` 现在复用播放接口的 302 响应，Location 直接指向经过 allowlist 校验的 CDN URL，并设置 `Cache-Control: no-store`。服务器不再读取或转发音频，`media` 客户端及下载响应的旧 Content-Disposition/MIME 代码已移除。
- QQ 单曲、专辑和歌单下载接入现有下载中心：浏览器 fetch 302 后的 CDN 响应，按 `歌手 - 歌名.扩展名` 保存并报告字节进度。扩展名沿用 QQ codec/音质映射；fetch 失败时触发原下载链接作为兜底。
- 网易云与 Apple 下载路径保持不变。

验证：

- `node tests/run.mjs unit qq_download qq_source qq_ui`：3 个目标文件全部通过。
- `node tests/run.mjs unit`：24/25 个文件通过；唯一失败是 `serverless.mjs` 内部启动
  `scripts/build-static.mjs` 被沙箱以 `Operation not permitted` 拒绝（`spawnSync /usr/bin/node`）。
- `cargo clippy --workspace --all-targets -- -D warnings`（stable 1.100）：通过，零警告。
- `cargo test --workspace --no-fail-fast`：Rust 代码编译成功；`fantastic` 库测试通过
  150/162，剩余 12 个，以及 `client_limit`（5）、`local_wrapper`（2）、`mv_api`（5）、
  `qq_upstream`（9）中的回环 mock 因沙箱禁止监听（`Operation not permitted`）失败。
  `FANTASTIC_TEST_SKIP_LOOPBACK=1 cargo test -p fantastic --lib qq::tests --no-fail-fast`
  下可运行的 QQ 测试为 80/80；允许回环监听时新增用例会断言 302、Location、
  `Cache-Control: no-store`、空 body 和零上游读取。
