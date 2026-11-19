# Fantastic 网易云音源：阶段 2

本阶段在 `src/ncm.rs` 的阶段 1 协议适配器上增加歌词、专辑、歌手、歌单和搜索建议接口。没有改动 QQ 适配器、前端或 AMLL vendor。

## 文件清单

- `src/ncm.rs`：新增 NCM lyric、album、artist、playlist、suggest DTO、上游请求、缓存和 `/ncm/*` 路由。
- `tests/ncm_adapter/mod.rs`：新增逐字歌词（含翻译、音译）、专辑、歌手、歌单和建议映射样例测试，并更新路由覆盖测试。
- `docs/ncm-source-phase2.md`：本交付说明。

## 接口与上游来源

所有请求均经过阶段 1 的 `check_response`，只接受 `code == 200`；DTO 中的数字 ID 统一序列化成字符串，歌曲时长使用毫秒，图片沿用 `picUrl` 并将 NCM CDN 的 HTTP 地址升级为 HTTPS。请求参数和加密模式来自 `api-enhanced/module/`，并以 `ncm-api-rs/src/api/` 的同名文件复核。

| 公共接口 | 上游端点 | 加密 | 参数来源 |
| --- | --- | --- | --- |
| `GET /ncm/song/:id/lyrics` | `POST https://music.163.com/weapi/song/lyric/v1` | weapi | `lyric_new.js`：`id`、`cp/tv/lv/rv/kv/yv/ytv/yrv` |
| `GET /ncm/song/:id/lyrics/raw?kind=...` | 同上 | weapi | `lyric_new.js`；`kind` 只选择已缓存原文 |
| `GET /ncm/album/:id` | `POST https://music.163.com/weapi/v1/album/:id` | weapi | `album.js`：空对象 |
| `GET /ncm/artist/:id` | `POST https://interface.music.163.com/eapi/artist/head/info/get`、`.../v1/artist/songs`、`https://music.163.com/weapi/artist/albums/:id` | eapi/eapi/weapi | `artist_detail.js`、`artist_songs.js`、`artist_album.js` |
| `GET /ncm/artist/:id/songs` | `POST https://interface.music.163.com/eapi/v1/artist/songs` | eapi | `artist_songs.js`：`private_cloud=true`、`work_type=1`、`order=hot`、`offset`、`limit` |
| `GET /ncm/artist/:id/albums` | `POST https://music.163.com/weapi/artist/albums/:id` | weapi | `artist_album.js`：`limit`、`offset`、`total=true` |
| `GET /ncm/playlist/:id` | `POST https://interface.music.163.com/eapi/v6/playlist/detail`，再请求 `/api/v3/song/detail` | eapi/eapi | `playlist_detail.js`、`playlist_track_all.js`：`id`、`n=100000`、`s=8`，歌曲 ID 分页后放入 `c` |
| `GET /ncm/suggest?q=` | `POST https://music.163.com/weapi/search/suggest/web` | weapi | `search_suggest.js`：`s` |

歌单和歌手歌曲列表沿用 QQ 公共 DTO 的分页上限：`limit` 最大 100、`offset` 最大 10000；歌单默认每页 100 首。歌单详情拿到 `trackIds` 后按 `playlist_track_all.js` 的两步方式请求歌曲详情。

歌词 DTO 的 `candidates` 按 `yrc`、`lrc` 顺序输出；缓存内部保留 `yrc`、`lrc`、`tlyric`、`romalrc`、`yromalrc` 原文。公开标志为 `rawYrc`、`rawTrans`、`rawRoma`。原文下载支持 `yrc`、`lrc`、`trans`、`roma`、`yroma`；未知 kind 返回 400，原文缺失返回 404，响应使用纯文本、附件文件名和 `no-store`，与 QQ raw lyrics 保持一致。

歌词成功结果缓存 7 天，空歌词缓存 1 小时；命中直接返回。上游失败不会写入成功缓存。

## 测试结果

- `cargo test --lib ncm::tests --no-fail-fast`：25 passed。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过，零警告。
- `cargo fmt`：当前沙箱 toolchain 未安装 `rustfmt` 组件（`cargo-fmt is not installed`），因此无法运行格式检查。
- `cargo test --workspace --no-fail-fast`：已在交付前运行；沙箱禁止回环监听时，仓库既有约 35 个网络/UI 测试会因环境而失败。该环境性失败与本阶段 NCM 映射测试无关，需在允许回环监听的正常环境复跑。

## 与 QQ 契约的差异

- NCM 使用数字 ID，所以映射到 QQ 的 `mid`/`id` 字段时全部转为字符串。
- NCM 歌词逐字源名为 `yrc`，公开候选为 `yrc`、`lrc`；QQ 对应字段名是 `qrc`。NCM 额外保留 `yroma` 原文下载，但公开布尔标志仍按约定只暴露 `rawYrc/rawTrans/rawRoma`。
- NCM artist 页不请求 MV；为保持 artist page 的 JSON 形状，`mvs` 为空、`moreMvs` 为 false。
- NCM 专辑/歌手/建议图片直接采用 NCM `picUrl`（只做 CDN HTTPS 升级）；QQ 的部分图片会生成尺寸模板。
- 歌单详情在 NCM 端按 `trackIds` 再请求歌曲详情，若详情同时带有 inline `tracks` 则防御性使用该集合；歌曲页仍遵循 QQ 的 `playlist/more` 字段。

## 未决问题

- 网易云不同登录态可能返回缺少 `artist.user`、`trackIds` 或部分歌词语言字段；当前实现按 QQ 风格降级为空字段/空列表，并保留成功响应。
- 网易云 lyric v1 的逐字字段在不同版本中可能出现字符串或 `{lyric: ...}` 两种形状，当前两种均支持；未对上游逐字语法做重新解析。
- 歌单超过一页时由 `limit`/`offset` 分页取数，服务端不会一次把超出 QQ 公共上限的全部歌曲送给前端。
