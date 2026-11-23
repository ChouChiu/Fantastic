# NCM 页面规范路径

## 改动清单

- NCM 的四个页面构造器现在生成官方链接形式：`/https://music.163.com/song?id=<id>`、`album`、`artist`、`playlist`。
- `web/app.mjs` 同时路由官方形式和旧的 `/ncm-song/<id>`、`/ncm-album/<id>`、`/ncm-artist/<id>`、`/ncm-playlist/<id>` 别名，并继续受 `FANTASTIC_HOST.ncmEnabled` 控制。官方形式的 ID 从 `pathname + search` 的 query `id` 读取，支持 `https:/` 与 `https://`。
- `web/sources/ncm.mjs` 导出共享的 `parsePageId(url, kind)`，四个 NCM 视图、资料库校验与 NCM 操作菜单都使用双形式解析。`webUrl()` 接受新旧两种本站路径并返回不带前导 `/` 的官方 URL。
- `src/links.rs` 和 Rust fallback 将 query 一起交给 `is_ncm_link`，校验官方链接的数字 ID；旧别名继续识别。Cloudflare serverless 页面路径判断也同步支持两种形式。
- 播放器队列使用 NCM 条目已有的 `ncm.songPath()` 结果；缺少 href 的旧队列条目异步通过同一构造器补齐。AutoMix 从官方 NCM 专辑 href 的 `?id=` 读取专辑 ID。
- `/ncm/song/...`、`/ncm/album/...`、`/ncm/artist/...`、`/ncm/playlist/...` 服务端 API 路径未改动。

## href 消费方审计

| 消费方 | 处理结果 |
| --- | --- |
| `web/sources/ncm.mjs` 的 `songPath`、`albumPath`、`artistPath`、`playlistPath`、`webUrl` | 生成官方路径；`webUrl` 兼容新旧本站路径 |
| 四个 `web/views/ncm-*.mjs` | 统一调用 `parsePageId`，官方 query 与旧 pathname 都能加载 |
| `web/app.mjs` | 官方 query 路由与旧别名都命中 NCM 视图，保留启用门控 |
| `web/views/actions.mjs` | NCM 专辑 / 歌单取曲目时用 `parsePageId`，不再假设 ID 在 pathname 尾部 |
| `web/library.mjs` | 资料库导入、清理和保存校验接受官方与旧 NCM href |
| `web/player/player.js` | 队列歌曲链接沿用条目中的 `songPath` 结果；缺失 href 时调用 NCM 构造器 |
| `web/player/automix.js` | 同时读取旧路径末尾 ID 与官方 `?id=` |
| `web/views/home.mjs` | NCM 搜索源粘贴四种官方链接后直达；也支持 `#/song?id=` 等 hash 分享形式 |
| `src/handlers.rs`、`src/links.rs`、`serverless/core.mjs`、`vercel.json` | 直达页面 fallback / rewrite 接受官方与兼容路径，并校验数字 ID |

Apple 的前端粘贴流程仍由 `web/views/links.mjs::parseAppleLink` 处理，服务端由 Apple 的 `parse_*_link` 处理。QQ 的前端路由和服务端 `is_qq_link` 继续识别官方 `/https://y.qq.com/n/ryqq/...` 页面；首页输入框原有行为只对 Apple 做直接粘贴解析，QQ 仍使用已有搜索源联想流程，本次没有改动 QQ 代码。NCM 新增了与其页面路由对应的源内粘贴解析；服务端 HTTP 请求没有 fragment，因此 `#/...` 形式只在前端粘贴时处理。

## 兼容策略

旧收藏、历史和队列中的 `/ncm-*` href 不迁移、不改存储格式。路由、视图 ID 提取、`webUrl`、资料库校验、操作菜单和队列链接都保留旧格式支持；新生成的条目使用官方路径。

## 验证

- 已更新 NCM source/UI、AutoMix、serverless 和 Rust 页面链接测试，覆盖新旧路径、query ID、斜杠容错、非法 ID、四视图解析和 hash 粘贴链接。
- `node tests/run.mjs unit`：24 个测试文件通过；`tests/unit/serverless.mjs` 的 build-static 子测试在沙箱内因 `spawnSync /usr/bin/node EPERM` 无法执行，路径检查本身通过，需在沙箱外重跑该文件。
- `cargo test --workspace`：150 个测试通过；剩余 12 个失败全部是回环 mock / wrapper 测试的 `Operation not permitted`（沙箱禁止 loopback），没有出现 NCM 路径断言或编译失败。需在沙箱外重跑完整套件。
