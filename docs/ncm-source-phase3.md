# Fantastic 网易云音源：阶段 3

本阶段接通 NCM 搜索、建议、歌曲／专辑／歌手／歌单页面、播放器、歌词和设置页，并补齐服务端 Cookie 管理与音频下载端点。工作分支为 `feat/ncm-source`，没有创建 commit；`src/qq.rs`、QQ 专属页面／adapter 和 AMLL vendor 没有改动。

## 文件清单

| 文件 | 改动 |
| --- | --- |
| `src/ncm.rs` | Cookie 文件写入与热替换、状态／清除 API、下载 302、音频 CDN HTTPS、仅有 yromalrc 时的原文标志 |
| `src/assets.rs` | 注册 NCM adapter、四类页面及设置模块的内嵌静态资源 |
| `src/links.rs`、`src/handlers.rs` | NCM 页面直达时返回 SPA 外壳 |
| `web/sources/ncm.mjs` | NCM API、DTO／身份、页面路径、六档音质、JSON 取流、YRC／LRC 与附属歌词、下载、本源音质记忆 |
| `web/sources/track.mjs` | `sourceOf`／`trackKey`／`withIdentity` 支持 `ncm` |
| `web/views/ncm-{song,album,artist,playlist}.{mjs,html}` | 新增四类详情页，复用现有页面样式与操作控件，不提供 MV |
| `web/app.mjs` | 注册页面路由，播放 NCM 时跳过 Apple 元数据查询 |
| `web/views/home.{mjs,html}`、`web/views/search-results.mjs` | 源选择、host 开关、分源搜索／建议及结果分页 |
| `web/player/player.js` | NCM 队列解析、JSON 播放链接、原生播放、音质切换与分源上下文 |
| `web/lyrics/panel.mjs` | NCM 歌词入口、来源提示、原文扩展名，复用现有 LyricLine 转换和显示偏好 |
| `web/library.mjs`、`web/views/{actions,library,library-ui}.mjs` | NCM 收藏／快照／菜单／入队与分源身份 |
| `web/views/settings-ncm.mjs`、`web/views/settings.mjs`、`web/views/settings.css` | NCM 密码输入、保存／清除、配置状态及对应样式 |
| `web/i18n.js` | 简中、繁中、英文的 NCM 文案 |
| `tests/ncm_adapter/mod.rs` | Cookie、下载、页面／资源直达等 Rust 测试 |
| `tests/unit/ncm_source.mjs`、`tests/unit/ncm_ui.mjs` | 身份、音质记忆、歌词、播放器、页面、搜索和设置单测 |
| `docs/ncm-source-phase3.md` | 本报告 |

## 前端与播放器接入

NCM 的数字 ID 使用正 i64 范围内的字符串；前端拒绝前导零和不安全的 JavaScript number。歌曲身份为 `ncm:<id>`，资料库键为 `ncm:song:<id>`，音质变体 ID 为 `ncm:<id>:<quality>`，因此与 Apple／QQ 的相同数字 ID 不会相撞。

站内规范路径为 `/https://music.163.com/<kind>?id=<id>`（歌曲、专辑、歌手、歌单），与官方链接形式一致；旧 `/ncm-<kind>/<id>` 仅作为兼容别名保留，对外分享使用 `https://music.163.com/<kind>?id=<id>`。`app.mjs` 和服务端 fallback 均支持直达。首页按照 `FANTASTIC_HOST.ncmEnabled` 显隐源入口，保留 URL／浏览器中的搜索源选择；搜索与建议按当前 adapter 分发，NCM 只有歌曲、专辑、歌手、歌单四类。切换搜索源不会切断正在播放的歌曲。

`player.js` 的 `resolveEntry` 对 NCM 调用 capabilities／qualities，根据可用音质和浏览器解码能力产生原生播放变体；`attempt` 的 native 分支在设置 `audio.src` 前调用 `/ncm/song/:id/play`，解析 JSON 中的 URL 与实际音质信息。直链要求 HTTPS 且属于允许的 NCM CDN，服务端同时将 CDN HTTP 地址升级为 HTTPS。队列和变体只保留本地 API 地址，不保存会过期的 CDN URL。NCM 不经过 Apple master、解密或 AutoMix 音频分析。

歌曲页与播放器音质菜单共用 `ncm.mjs` 的六档能力表：`standard`、`higher`、`exhigh`、`lossless`、`hires`、`jymaster`。未显式选择时沿用已有 `prefs.mjs` 的播放偏好和 `playback-quality.mjs` 降级顺序；手动选择使用同样的 localStorage 存储方式，独立保存在 `am-hook:ncm:quality`，刷新后生效，不读写 QQ 音质或共享播放设置。已记住的档位不可用时按对应等级降级；显式指定的队列档位仍优先。队列、当前歌曲和播放位置按 `sourceContexts` 的源键保存，切音质保留当前位置。

## 歌词管线

`ncm.mjs` 将 YRC 解析为现有 TTML parser 使用的 song／line／token 结构，交给 `panel.mjs` 的 `toAmllLines` 转成与 QRC 相同的 AMLL `LyricLine`。没有修改 vendor，也没有建立另一套歌词显示设置。

- YRC 行首为 `[start,duration]`，词为 `(start,duration,flag)文本`，也兼容省略 flag 的形式。网易云词时间采用绝对毫秒，直接保留为 token 的 begin／end，不再加一次行起点。
- 跳过 `{"t":...,"c":[...]}` 元数据行和空行；优先使用可解析的 YRC，没有有效 YRC 时使用 LRC。LRC 支持重复时间标签和 offset。
- 根据 `rawTrans`／`rawRoma` 从原文接口取得 tlyric、romalrc、yromalrc，按最近行起点对齐，容差 500ms；未匹配的行不挂接。yromalrc 与原文词数一致时保留逐词音译，否则用行音译，缺少 yromalrc 时使用 romalrc。
- 翻译挂 `translation`，音译挂 `pronunciation`／`pronunciationTokens`，进入既有 `translatedLyric`、`romanLyric`、`romanWord` 转换；显示／隐藏继续使用现有歌词偏好和开关记忆。上游原文接口只有一份翻译，没有可供界面语言排序的多语言候选；既有 TTML 的语言优选保持原状。界面切换语言时重绘 NCM song 模型，避免把 YRC 当作 TTML 重新解析。
- 原文可下载 YRC／LRC、翻译、音译；仅有 yromalrc 时选择实际存在的 `yroma` 原文。附属歌词缺失或请求失败不会丢弃已解析的主歌词。

## Cookie 端点与设置页

Cookie 文件路径来自既有 `--ncm-cookie-file` 配置。设置页只在 `ncmEnabled` 时显示，使用 password 输入框，说明从已登录的 music.163.com 网页开发工具获取 Cookie、只存服务端。保存成功或离开页面会清空输入，不把值写入浏览器存储，也不尝试读回原值。

| 端点 | 成功响应 | 语义 |
| --- | --- | --- |
| `PUT /ncm/cookie`，JSON `{ "cookie": "..." }` | 204，空体 | 写入配置的文件；Unix 权限为 0600，已有文件也收紧权限；成功后热替换内存 cookie jar |
| `GET /ncm/cookie/status` | 200，`{ "configured": true/false }` | 仅检测内存 jar 中是否有未过期、非空的 MUSIC_U，不请求上游验证账户 |
| `DELETE /ncm/cookie` | 204，空体 | 将配置文件截断为空，替换内存登录态为匿名协议 cookies |

错误固定为 JSON `{ "error": "固定文案" }`，不拼接输入、Cookie、上游正文或文件内容：未配置文件路径时 PUT／DELETE 返回 **503** `NCM cookie file is not configured`；文件写入失败返回 **500** `Cannot update NCM cookie file`；畸形 JSON／不合法 cookie pair 返回 **400** `Invalid NCM request`。空字符串、不含 MUSIC_U 的合法 cookie 串以及 `MUSIC_U=` 均接受，status 返回 false。没有文件路径不妨碍 GET status 查询。

成功响应使用 `Cache-Control: no-store`。Cookie 不回显、不写日志，也不进入 host 配置、DTO 或其他响应。更新串行执行，文件写入成功后才替换内存；重新生成匿名设备 cookies，并清除旧的歌曲权限详情缓存。jar 使用 generation 拒绝更新前已发出请求迟到的 Set-Cookie，防止清除登录后被旧请求恢复。文件继续由已有启动加载逻辑读取，因此重启后保留用户保存的值。

`configured: true` 只表示 MUSIC_U 已配置，不保证账号会话仍有效或具有会员音质权限。

## 下载端点

`GET /ncm/song/:id/download?quality=...` 默认 `standard`，读取歌曲信息与实际音频。由于 NCM 返回直链，响应为 **302**，包含 `Location`、实际音频 `Content-Type`、`Cache-Control: no-store` 和 QQ 风格的安全附件文件名（ASCII fallback 加 UTF-8 `filename*`），扩展名依据实际 codec。服务端不预取媒体正文。ID／音质无效返回 400，缺少可用音频返回 502 与 NCM 固定错误对象，试听片段不会作为完整下载地址。

## 验证结果

| 命令／检查 | 结果 |
| --- | --- |
| `cargo test --lib ncm::tests --no-fail-fast` | **30 passed，0 failed** |
| `cargo test --workspace --no-fail-fast` | **217 passed，35 failed，1 ignored**；退出 101，35 项均为既有测试的回环监听被沙箱拒绝 |
| `cargo clippy --workspace --all-targets -- -D warnings` | **通过，零警告** |
| NCM Node 单测 | `ncm_source.mjs` 9 项、`ncm_ui.mjs` 5 项，共 **14 项通过** |
| `node tests/run.mjs unit` | **24 个测试文件中 23 通过、1 失败**；唯一失败文件为 `serverless.mjs`，详情见下文 |
| `node scripts/build-static.mjs /tmp/ncm-phase3-static-review` | **通过，307 个文件**；包含 NCM source、四类页面与设置模块的 hash 资源 |
| `git diff --check` | 通过 |

Rust 全量失败为 `Operation not permitted (os error 1)`，均发生在既有 mock 服务 bind：`fantastic --lib` 14 项（QQ 10、wrapper 4）、`client_limit` 5 项、`local_wrapper` 2 项、`mv_api` 5 项、`qq_upstream` 9 项。没有修改这些无关测试，也没有通过设置跳过标志掩盖失败。

Node 唯一失败是 `serverless.mjs` 的 `build-static lays out web the way src/assets.rs serves it`：沙箱拒绝 `spawnSync /usr/bin/node`，错误为 EPERM；直接运行该文件确认其余 15 项通过。直接执行相同静态构建脚本成功。QQ source／UI 和其他 Node 测试文件均通过。

NCM Rust 新增覆盖 Cookie 写入／重启读取／热替换／status／清除、0600、不回显、固定错误、迟到 Set-Cookie，以及下载响应／错误和页面资源直达。Node 覆盖 YRC 多词／元数据／空行／逐词绝对时间、候选顺序与 fallback、翻译音译挂接及真实 LyricLine 转换、身份与资料库隔离、JSON 取流／切音质保留位置／分源队列、音质刷新记忆、四页／搜索和设置交互。

stable toolchain 缺少 cargo-fmt；Rust 改动已使用本机可用的 nightly rustfmt（edition 2021）格式化。没有为绕过沙箱更改运行时网络或无关测试。

## 与 QQ 的差异与未决问题

- NCM 使用数字字符串 ID 和本地 `/ncm-*` 页面；QQ 保留原有 mid、URL 和页面行为。
- NCM `/play` 返回 JSON，播放器即时解析直链；QQ 保留现有播放地址处理。NCM 下载按任务要求返回 302，QQ 保留代理下载正文的实现。
- NCM 提供六档音质与本源记忆，全部走浏览器原生 MP3／FLAC 能力检测；无 MV 页面或入口。
- NCM 歌词优先 YRC、回退 LRC，翻译／音译来自附属原文；QQ 的 TTML／QRC／AMLL 候选、语言优选与开关行为保持原状。
- 本阶段没有扩展 serverless 平台的 NCM 后端；入口依赖 Rust host 已提供的 `ncmEnabled`。未提供该标志的平台不会显示入口。
- 没有真实账号 Cookie，尚未进行真实上游播放、会员权限、浏览器视觉和 CDN CORS／拖动试听验收，需在正常网络环境补验。`configured` 也不承担远端登录有效性检查。
- 302 上的附件头已按 QQ 语义设置；浏览器最终采用的下载文件名仍受 CDN 最终响应和跨域下载处理影响。
- 两个全量门禁受上述沙箱限制未全绿，需在允许回环监听和子进程的环境重跑；报告不将这些结果计为通过。
