# NCM eapi UA 修复

`src/ncm.rs` 的 eapi 请求改用与 `anonymous_cookies()` 桌面客户端身份一致的 UA：`NeteaseMusicDesktop/3.1.17.204416`。匿名 Cookie 的 `appver` 使用共享的 `DESKTOP_APPVER` 常量，并新增单元测试断言 UA 版本与匿名 Cookie 一致；weapi 的 `WEB_UA` 和其他请求逻辑未改动。另将一个等价布尔判断改写为 clippy 可接受形式，行为不变。

验证结果：

- `cargo test --lib ncm::tests --no-fail-fast`：31 passed，0 failed。
- `cargo test --workspace --no-fail-fast`：148 passed，14 failed，1 ignored；失败均为沙箱回环监听限制导致的既有 QQ／wrapper／client_limit／local_wrapper／mv_api／qq_upstream 测试。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过，零警告。
