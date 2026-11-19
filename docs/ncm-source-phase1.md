# NCM 音源：阶段 1 后端交付

基线 `b398080`，分支 `feat/ncm-source`。未创建 Git commit。

## 文件

- 新增 `src/ncm.rs`：原生 weapi/eapi、私有 Cookie 罐、固定域名 HTTP 客户端、DTO、五个接口。
- 新增 `tests/ncm_adapter/mod.rs`：加密向量、映射、权益、请求构造、Cookie、CLI、路由测试。
- 修改 `Cargo.toml`、`Cargo.lock`：AES、MD5、大整数、随机数、hex、Cookie 过期时间解析依赖；没有引入 ncm-api-rs SDK。
- 修改 `src/cli.rs`：`--ncm-cookie-file` / `FANTASTIC_NCM_COOKIE_FILE`。
- 修改 `src/state.rs`：恒构造 `ncm`；新增 `with_sources`，保留原有构造入口。
- 修改 `src/main.rs`、`src/lib.rs`：启动时读取 Cookie 文件并合并 NCM 路由。
- 修改 `src/handlers.rs`：host 配置增加 `ncmEnabled: true`。
- 修改 `tests/local_wrapper.rs`：更新 host 配置的完整形状断言。
- 新增本报告。未修改 `src/qq.rs`、`web/`、AMLL vendor。

## 接口与协议

| 本地 GET 接口 | 上游 POST 端点 | 加密 / 参数 |
| --- | --- | --- |
| `/ncm/capabilities` | 无 | 本地声明六个档位 |
| `/ncm/search?q=&kind=&limit=&offset=` | `https://music.163.com/weapi/cloudsearch/pc` | weapi；`s,type,limit,offset,total,csrf_token`；type 为 1/10/100/1000 |
| `/ncm/song/:id` | `https://music.163.com/weapi/v3/song/detail` | weapi；`c` 为 `[{"id":数字}]` 的 JSON 字符串 |
| `/ncm/song/:id/qualities` | 上述 detail，随后按候选档位调用下述 URL 接口 | detail 为 weapi，验证 URL 为 eapi |
| `/ncm/song/:id/play?quality=` | `https://interface.music.163.com/eapi/song/enhance/player/url/v1` | eapi；签名路径 `/api/song/enhance/player/url/v1`，`ids,level,encodeType:"flac",header,e_r:false` |

weapi 使用两次 AES-128-CBC/PKCS#7、固定 IV/第一段密钥、随机 16 字符第二段密钥，以及反转密钥的无填充 RSA-1024。eapi 使用参考协议的 MD5 签名、分隔符和 AES-128-ECB/PKCS#7。AES 由 RustCrypto 实现，CBC/ECB 分块和填充在模块内实现。

仅请求表中两个 API 域名，禁用重定向；不会请求返回的音频或封面 URL。Cookie 罐处理响应的 Set-Cookie、域、路径和过期时间，Cookie 请求头标记为敏感。Cookie 文件缺失/未配置时匿名运行；其他文件读取或格式错误只返回固定错误信息。Cookie 不进入共享 Config、页面配置或接口 DTO。

qualities 先使用 `l/m/h/sq/hr/jm` 与 `pl/playMaxBr/plLevel/playMaxBrLevel/st` 生成候选，再验证上游实际 URL。无 URL、试听片段和降档结果不作为对应档位的可播凭据；网络失败不会被伪装成没有权益。

## DTO 契约说明

现有 QQ 实际字段是 `artists:[{mid,name}]`、`album`（名称字符串）、`albumMid`、`durationMs` 和顶层 `cover`。NCM 沿用这些字段，将数字 ID 转成字符串。歌曲详情沿用 QQ 的平铺形状，没有对应元数据时省略 `meta`；`vip` 标记 fee 1/4，fee 0/8 不标记 VIP。

现有 QQ `/play` 实际返回 302，没有包含音质信息的 JSON DTO。NCM 按本任务明确列出的字段返回 `url,quality,bitrate,format,codec,contentType,sizeBytes,expiresIn`（最后一项可省略），`quality` 来自上游实际返回值；响应为 `no-store`。无可用 URL 时返回 HTTP 502 与 `{"error":"NCM source temporarily unavailable"}`，沿用 QQ 的错误对象形状和不可用状态码。播放 URL 保留上游实际协议和查询参数。

## 验证

| 检查 | 结果 |
| --- | --- |
| `cargo test --workspace --no-fail-fast`（`CARGO_NET_OFFLINE=true`） | **208 通过、35 失败、1 忽略**；未达到全绿要求 |
| 上述全量运行中的新增 NCM 测试 | **21 通过、0 失败**（包含在 208 中） |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过，0 警告 |
| 新增 Rust 文件的 rustfmt 检查、`git diff --check` | 通过 |

35 个失败全部是现有测试的回环 TCP 监听被沙箱以 `Operation not permitted` 拒绝：fantastic lib 14 个、client_limit 5 个、local_wrapper 2 个、mv_api 5 个、qq_upstream 9 个。没有修改/跳过这些测试来制造全绿。1 个忽略是原有需要真实 wrapper-lite 的歌词 E2E 测试。

本次运行日志：`/tmp/fantastic-ncm-tests-final.log`、`/tmp/fantastic-ncm-clippy.log`。NCM 的测试使用进程内 Router 和离线样例，无需 TCP 监听。

加密测试使用 Node.js 内置 crypto 独立生成的固定向量，公钥来自参考实现 SPKI；覆盖两层 CBC 解密、RSA 固定输出、eapi 完整固定输出与 MD5 签名、随机性、Unicode 和填充边界。测试不访问公网。

## 未决问题与参考差异

1. 当前沙箱禁止回环端口监听，全量测试门禁尚未通过；须在允许 TCP 监听的环境重跑同一全量命令。
2. `api-enhanced` 是根目录稀疏/部分克隆，module、util、文档对应 blob 未在本机；`git show` 尝试补取时网络代理连接失败，直接访问也无法解析域名。因此未完成以 JS module 为最终依据的逐字段复核，也未做真实网易云匿名/登录态联网验证。
3. 可读的 `ncm-api-rs/src/api/cloudsearch.rs` 默认使用 eapi。本任务明确要求 cloudsearch/weapi，因此当前实现采用 weapi。尚不能断言这与缺失的 api-enhanced module 一致。
4. 内嵌 JSON 是按可读 Rust 参考接口及文档字段整理的精简代表样例，并非此次实时抓包；api-enhanced module/真实样例的交叉核对待网络恢复后进行。
5. 上述 QQ 契约与任务描述存在差异，本实现采用现有 QQ 的歌曲字段，同时按任务要求提供 NCM 播放 JSON；后续前端阶段需据此接入。
