//! Native, server-only NetEase protocol adapter. Crypto/request construction is
//! ported from ncm-api-rs (WTFPL); no SDK or third-party API service is used.
use crate::state::AppState;
use aes::cipher::{Block, BlockEncrypt, KeyInit};
use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use lru::LruCache;
use md5::{Digest, Md5};
use num_bigint::BigUint;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    num::NonZeroUsize,
    path::Path as FilePath,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

type ApiResult<T> = Result<T, NcmError>;
#[derive(Debug)]
pub struct NcmError(StatusCode);
impl IntoResponse for NcmError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"error": match self.0 {
                StatusCode::BAD_REQUEST => "Invalid NCM request",
                StatusCode::NOT_FOUND => "NCM resource not found",
                _ => "NCM source temporarily unavailable",
            }})),
        )
            .into_response()
    }
}
fn bad() -> NcmError {
    NcmError(StatusCode::BAD_REQUEST)
}
fn missing() -> NcmError {
    NcmError(StatusCode::NOT_FOUND)
}
fn unavailable() -> NcmError {
    NcmError(StatusCode::BAD_GATEWAY)
}

const IV: &[u8; 16] = b"0102030405060708";
const PRESET_KEY: &[u8; 16] = b"0CoJUm6Qyw8W8jud";
const EAPI_KEY: &[u8; 16] = b"e82ckenh8dichen8";
// The reference SPKI public key's 1024-bit modulus and public exponent 65537.
const MODULUS: &str = "e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";

// Only the block modes are implemented here; AES itself uses RustCrypto. Both
// protocols require PKCS#7 padding (including a full block on aligned input).
fn encrypt_aes(text: &[u8], key: &[u8; 16], iv: Option<&[u8; 16]>) -> Vec<u8> {
    let pad = 16 - text.len() % 16;
    let mut data = text.to_vec();
    data.resize(text.len() + pad, pad as u8);
    let cipher = aes::Aes128::new(key.into());
    let mut previous = iv.copied().unwrap_or_default();
    for block in data.as_chunks_mut::<16>().0 {
        if iv.is_some() {
            for (byte, prior) in block.iter_mut().zip(previous) {
                *byte ^= prior;
            }
        }
        let mut encrypted = Block::<aes::Aes128>::default();
        encrypted.copy_from_slice(block);
        cipher.encrypt_block(&mut encrypted);
        block.copy_from_slice(&encrypted);
        previous.copy_from_slice(block);
    }
    data
}
fn weapi_with_key(data: &Value, key: &[u8; 16]) -> [(&'static str, String); 2] {
    let first = STANDARD.encode(encrypt_aes(
        data.to_string().as_bytes(),
        PRESET_KEY,
        Some(IV),
    ));
    let params = STANDARD.encode(encrypt_aes(first.as_bytes(), key, Some(IV)));
    static N: LazyLock<BigUint> =
        LazyLock::new(|| BigUint::parse_bytes(MODULUS.as_bytes(), 16).unwrap());
    let reversed: Vec<u8> = key.iter().rev().copied().collect();
    let encrypted = BigUint::from_bytes_be(&reversed).modpow(&BigUint::from(65537u32), &N);
    [
        ("params", params),
        ("encSecKey", format!("{encrypted:0>256x}")),
    ]
}
fn weapi(data: &Value) -> Vec<(&'static str, String)> {
    let key: Vec<u8> = rand::thread_rng()
        .sample_iter(Alphanumeric)
        .take(16)
        .collect();
    weapi_with_key(data, key.as_slice().try_into().unwrap()).into()
}
fn eapi(path: &str, data: &Value) -> Vec<(&'static str, String)> {
    let text = data.to_string();
    let digest = hex::encode(Md5::digest(format!("nobody{path}use{text}md5forencrypt")));
    let plaintext = format!("{path}-36cd479b6b5-{text}-36cd479b6b5-{digest}");
    vec![(
        "params",
        hex::encode_upper(encrypt_aes(plaintext.as_bytes(), EAPI_KEY, None)),
    )]
}

const MUSIC: &str = "https://music.163.com";
const INTERFACE: &str = "https://interface.music.163.com";
const SEARCH_PATH: &str = "/api/cloudsearch/pc";
const DETAIL_PATH: &str = "/api/v3/song/detail";
const PLAY_PATH: &str = "/api/song/enhance/player/url/v1";
const WEB_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
const APP_UA: &str = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";

struct Cookie {
    value: String,
    domain: String,
    path: String,
    host_only: bool,
    expires: Option<SystemTime>,
}
/// A private jar for the two fixed HTTPS API origins. It ingests Set-Cookie,
/// observes domain/path/expiry, and never serializes or implements Debug.
#[derive(Default)]
struct CookieJar(Mutex<BTreeMap<(String, String, String), Cookie>>);
impl CookieJar {
    fn insert(&self, name: &str, value: &str) {
        self.0.lock().unwrap().insert(
            (name.into(), "music.163.com".into(), "/".into()),
            Cookie {
                value: value.into(),
                domain: "music.163.com".into(),
                path: "/".into(),
                host_only: false,
                expires: None,
            },
        );
    }
    fn values(&self, url: &reqwest::Url) -> BTreeMap<String, String> {
        let now = SystemTime::now();
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, cookie)| {
                let host = url.host_str().unwrap_or_default();
                let domain = host == cookie.domain
                    || (!cookie.host_only && host.ends_with(&format!(".{}", cookie.domain)));
                let path = url.path() == cookie.path
                    || (url.path().starts_with(&cookie.path)
                        && (cookie.path.ends_with('/')
                            || url.path().as_bytes().get(cookie.path.len()) == Some(&b'/')));
                domain && path && cookie.expires.is_none_or(|expiry| expiry > now)
            })
            .map(|((name, _, _), cookie)| (name.clone(), cookie.value.clone()))
            .collect()
    }
    fn store(&self, response: &reqwest::Response) {
        let host = response.url().host_str().unwrap_or_default();
        if !matches!(host, "music.163.com" | "interface.music.163.com") {
            return;
        }
        for raw in response.headers().get_all(header::SET_COOKIE) {
            let Ok(raw) = raw.to_str() else { continue };
            let mut parts = raw.split(';').map(str::trim);
            let Some((name, value)) = parts.next().and_then(|p| p.split_once('=')) else {
                continue;
            };
            if !valid_cookie_pair(name, value) {
                continue;
            }
            let mut cookie = Cookie {
                value: value.into(),
                domain: host.into(),
                path: "/".into(),
                host_only: true,
                expires: None,
            };
            let mut valid = true;
            let mut max_age = None;
            for part in parts {
                let Some((key, value)) = part.split_once('=') else {
                    continue;
                };
                match key.to_ascii_lowercase().as_str() {
                    "domain" => {
                        let domain = value.trim_start_matches('.').to_ascii_lowercase();
                        valid &= matches!(
                            domain.as_str(),
                            "music.163.com" | "interface.music.163.com" | "163.com"
                        ) && (host == domain || host.ends_with(&format!(".{domain}")));
                        cookie.domain = domain;
                        cookie.host_only = false;
                    }
                    "path" if value.starts_with('/') => cookie.path = value.into(),
                    "max-age" => max_age = value.parse::<i64>().ok(),
                    "expires" => cookie.expires = httpdate::parse_http_date(value).ok(),
                    _ => {}
                }
            }
            if let Some(seconds) = max_age {
                cookie.expires = if seconds <= 0 {
                    Some(UNIX_EPOCH)
                } else {
                    SystemTime::now().checked_add(Duration::from_secs(seconds as u64))
                };
            }
            if valid {
                self.0.lock().unwrap().insert(
                    (name.into(), cookie.domain.clone(), cookie.path.clone()),
                    cookie,
                );
            }
        }
    }
}
fn valid_cookie_pair(name: &str, value: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
        && value
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && !b";\"\\,".contains(&b))
}
fn cookie_header(values: &BTreeMap<String, String>) -> ApiResult<header::HeaderValue> {
    let value = values
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ");
    let mut value = header::HeaderValue::from_str(&value).map_err(|_| unavailable())?;
    value.set_sensitive(true);
    Ok(value)
}

struct Cache<T>(Mutex<LruCache<String, (Instant, T)>>);
impl<T: Clone> Cache<T> {
    fn new(size: usize) -> Self {
        Self(Mutex::new(LruCache::new(NonZeroUsize::new(size).unwrap())))
    }
    fn get(&self, key: &str) -> Option<T> {
        let mut entries = self.0.lock().unwrap();
        if entries
            .get(key)
            .is_some_and(|(expires, _)| *expires > Instant::now())
        {
            entries.get(key).map(|(_, v)| v.clone())
        } else {
            entries.pop(key);
            None
        }
    }
    fn put(&self, key: String, value: T, ttl: u64) {
        self.0
            .lock()
            .unwrap()
            .put(key, (Instant::now() + Duration::from_secs(ttl), value));
    }
}
pub struct Ncm {
    api: reqwest::Client,
    cookies: CookieJar,
    permits: tokio::sync::Semaphore,
    rate: crate::wrapper::RateLimit,
    searches: Cache<SearchResult>,
    details: Cache<Value>,
}
#[derive(Clone, Copy)]
enum Crypto {
    Weapi,
    Eapi,
}
impl Ncm {
    pub fn new(cookie_file: Option<&FilePath>) -> Result<Self, String> {
        let cookies = CookieJar::default();
        for (name, value) in [
            ("os", "pc"),
            ("appver", "3.1.17.204416"),
            (
                "osver",
                "Microsoft-Windows-10-Professional-build-19045-64bit",
            ),
            ("channel", "netease"),
            ("__remember_me", "true"),
            ("ntes_kaola_ad", "1"),
            ("WEVNSM", "1.0.0"),
        ] {
            cookies.insert(name, value);
        }
        let random = hex::encode(rand::thread_rng().gen::<[u8; 16]>());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        cookies.insert("_ntes_nuid", &random);
        cookies.insert("_ntes_nnid", &format!("{random},{now}"));
        cookies.insert(
            "deviceId",
            &hex::encode_upper(rand::thread_rng().gen::<[u8; 26]>()),
        );
        cookies.insert("NMTID", &random[..16]);
        let prefix: String = (0..6)
            .map(|_| char::from(b'a' + rand::thread_rng().gen_range(0..26)))
            .collect();
        cookies.insert("WNMCID", &format!("{prefix}.{now}.01.0"));
        if let Some(path) = cookie_file {
            match std::fs::read_to_string(path) {
                Ok(raw) => {
                    for pair in raw
                        .trim()
                        .split(';')
                        .map(str::trim)
                        .filter(|p| !p.is_empty())
                    {
                        let (name, value) = pair
                            .split_once('=')
                            .filter(|(n, v)| valid_cookie_pair(n, v))
                            .ok_or("Invalid NCM cookie file")?;
                        cookies.insert(name, value);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("Cannot read NCM cookie file".into()),
            }
        }
        let api = reqwest::Client::builder()
            .http1_only()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            // Fixed API origins only; never follow an upstream redirect with credentials.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Cannot construct NCM HTTP client")?;
        Ok(Self {
            api,
            cookies,
            permits: tokio::sync::Semaphore::new(8),
            rate: crate::wrapper::RateLimit::new(10),
            searches: Cache::new(128),
            details: Cache::new(512),
        })
    }
    fn request_builder(
        &self,
        path: &str,
        mut data: Value,
        crypto: Crypto,
    ) -> ApiResult<reqwest::RequestBuilder> {
        let allowed = matches!(
            (path, crypto),
            (SEARCH_PATH | DETAIL_PATH, Crypto::Weapi) | (PLAY_PATH, Crypto::Eapi)
        );
        if !allowed {
            return Err(bad());
        }
        let (origin, prefix) = match crypto {
            Crypto::Weapi => (MUSIC, "weapi"),
            Crypto::Eapi => (INTERFACE, "eapi"),
        };
        let url = reqwest::Url::parse(&format!("{origin}/{prefix}/{}", &path[5..]))
            .map_err(|_| unavailable())?;
        let mut cookies = self.cookies.values(&url);
        let csrf = cookies.get("__csrf").cloned().unwrap_or_default();
        let (form, ua) = match crypto {
            Crypto::Weapi => {
                data["csrf_token"] = json!(csrf);
                (weapi(&data), WEB_UA)
            }
            Crypto::Eapi => {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default();
                let mut h = BTreeMap::new();
                for name in ["osver", "deviceId", "os", "appver", "mobilename", "channel"] {
                    h.insert(
                        name.to_owned(),
                        cookies.get(name).cloned().unwrap_or_default(),
                    );
                }
                for (name, default) in [
                    ("versioncode", "140".into()),
                    ("buildver", now.as_secs().to_string()),
                    ("resolution", "1920x1080".into()),
                ] {
                    h.insert(
                        name.to_owned(),
                        cookies.get(name).cloned().unwrap_or(default),
                    );
                }
                h.insert("__csrf".into(), csrf);
                h.insert(
                    "requestId".into(),
                    format!(
                        "{}_{:04}",
                        now.as_millis(),
                        rand::thread_rng().gen_range(0..1000)
                    ),
                );
                for name in ["MUSIC_U", "MUSIC_A"] {
                    if let Some(value) = cookies.get(name) {
                        h.insert(name.into(), value.clone());
                    }
                }
                data["header"] = json!(h);
                data["e_r"] = json!(false);
                cookies = h;
                (eapi(path, &data), APP_UA)
            }
        };
        Ok(self
            .api
            .post(url)
            .header(header::USER_AGENT, ua)
            .header(header::REFERER, MUSIC)
            .header(header::COOKIE, cookie_header(&cookies)?)
            .form(&form))
    }
    async fn request(&self, path: &str, data: Value, crypto: Crypto) -> ApiResult<Value> {
        for attempt in 0..=2 {
            let retry = {
                let _permit = self.permits.acquire().await.map_err(|_| unavailable())?;
                self.rate.acquire().await;
                match self
                    .request_builder(path, data.clone(), crypto)?
                    .send()
                    .await
                {
                    Ok(response) => {
                        self.cookies.store(&response);
                        let status = response.status();
                        if status.is_success() {
                            match response.json::<Value>().await {
                                Ok(raw) => return check_response(raw),
                                Err(_) => true,
                            }
                        } else if status == StatusCode::TOO_MANY_REQUESTS
                            || status.is_server_error()
                        {
                            true
                        } else {
                            return Err(unavailable());
                        }
                    }
                    Err(error) => {
                        tracing::warn!(error = %error.without_url(), "ncm network request failed");
                        true
                    }
                }
            };
            if !retry || attempt == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(300 * (1 << attempt))).await;
        }
        Err(unavailable())
    }
    async fn detail(&self, id: &str) -> ApiResult<Value> {
        if let Some(raw) = self.details.get(id) {
            return Ok(raw);
        }
        let raw = self
            .request(DETAIL_PATH, detail_params(id), Crypto::Weapi)
            .await?;
        detail_song(&raw, id)?;
        self.details.put(id.into(), raw.clone(), 60);
        Ok(raw)
    }
    async fn audio(&self, id: &str, quality: Quality) -> ApiResult<Option<Audio>> {
        let raw = self
            .request(PLAY_PATH, play_params(id, quality), Crypto::Eapi)
            .await?;
        audio_dto(&raw, id)
    }
    async fn qualities(&self, id: &str) -> ApiResult<Qualities> {
        let raw = self.detail(id).await?;
        let song = detail_song(&raw, id)?;
        let privilege = raw["privileges"]
            .as_array()
            .and_then(|rows| rows.iter().find(|p| id_of(&p["id"]).as_deref() == Some(id)))
            .or_else(|| song.get("privilege"))
            .unwrap_or(&Value::Null);
        let candidates = quality_candidates(song, privilege);
        let qualities =
            futures::future::join_all(candidates.into_iter().map(|quality| async move {
                // v1 can silently fall back to a lower tier. Never advertise that as
                // access to the requested tier, or advertise paid preview snippets.
                Ok::<_, NcmError>(QualityRow::verified(
                    quality,
                    self.audio(id, quality).await?,
                ))
            }))
            .await;
        let mut rows = Vec::new();
        for result in qualities {
            match result {
                Ok(Some(row)) => rows.push(row),
                Ok(None) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(Qualities { qualities: rows })
    }
}
fn check_response(raw: Value) -> ApiResult<Value> {
    match raw
        .get("code")
        .and_then(|code| code.as_i64().or_else(|| code.as_str()?.parse().ok()))
    {
        Some(200) => Ok(raw),
        Some(404) => Err(missing()),
        _ => Err(unavailable()),
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 19
        && !id.starts_with('0')
        && id.bytes().all(|c| c.is_ascii_digit())
        && id.parse::<i64>().is_ok()
}
fn check_id(id: &str) -> ApiResult<()> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(bad())
    }
}
fn id_of(value: &Value) -> Option<String> {
    let id = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|v| v.to_string()))?;
    valid_id(&id).then_some(id)
}
fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().into()
}
fn count(value: &Value) -> u64 {
    value.as_u64().unwrap_or_default()
}
fn cdn_url(raw: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.host_str().is_some_and(|h| {
            h == "music.126.net"
                || h.ends_with(".music.126.net")
                || h == "music.163.com"
                || h.ends_with(".music.163.com")
        })
    {
        return None;
    }
    Some(url)
}
fn cover(value: &Value) -> String {
    value
        .as_str()
        .and_then(cdn_url)
        .map(|mut u| {
            let _ = u.set_scheme("https");
            u.to_string()
        })
        .unwrap_or_default()
}

// Match the current QQ DTO field names; NCM numeric IDs occupy the same mid
// fields. No account, cookie, privilege object or raw upstream fields escape.
#[derive(Clone, Serialize)]
struct Artist {
    name: String,
    mid: String,
}
fn artists(raw: &Value) -> Vec<Artist> {
    raw.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|a| {
                    Some(Artist {
                        name: a["name"].as_str()?.into(),
                        mid: id_of(&a["id"]).unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Song {
    id: String,
    name: String,
    artists: Vec<Artist>,
    album: String,
    album_mid: String,
    duration_ms: u64,
    cover: String,
    vip: bool,
    ttml: bool,
    mv: String,
}
fn song_dto(raw: &Value) -> Option<Song> {
    let album = raw
        .get("al")
        .or_else(|| raw.get("album"))
        .unwrap_or(&Value::Null);
    let fee = raw
        .get("fee")
        .and_then(Value::as_u64)
        .or_else(|| raw.pointer("/privilege/fee").and_then(Value::as_u64))
        .unwrap_or_default();
    Some(Song {
        id: id_of(&raw["id"])?,
        name: text(&raw["name"]),
        artists: artists(
            raw.get("ar")
                .or_else(|| raw.get("artists"))
                .unwrap_or(&Value::Null),
        ),
        album: text(&album["name"]),
        album_mid: id_of(&album["id"]).unwrap_or_default(),
        duration_ms: raw
            .get("dt")
            .or_else(|| raw.get("duration"))
            .map(count)
            .unwrap_or_default(),
        cover: cover(&album["picUrl"]),
        vip: matches!(fee, 1 | 4),
        ttml: false,
        mv: raw
            .get("mv")
            .or_else(|| raw.get("mvid"))
            .and_then(id_of)
            .unwrap_or_default(),
    })
}
#[derive(Serialize)]
struct SongInfo {
    #[serde(flatten)]
    song: Song,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<Value>,
}
fn detail_song<'a>(raw: &'a Value, id: &str) -> ApiResult<&'a Value> {
    raw["songs"]
        .as_array()
        .and_then(|songs| {
            songs
                .iter()
                .find(|song| id_of(&song["id"]).as_deref() == Some(id))
        })
        .ok_or_else(missing)
}
fn detail_dto(raw: &Value, id: &str) -> ApiResult<SongInfo> {
    Ok(SongInfo {
        song: song_dto(detail_song(raw, id)?).ok_or_else(missing)?,
        meta: None,
    })
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlbumSummary {
    mid: String,
    name: String,
    cover: String,
    publish_time: u64,
    size: u64,
    artists: Vec<Artist>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtistSummary {
    mid: String,
    name: String,
    avatar: String,
    album_size: u64,
    mv_size: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistSummary {
    id: String,
    name: String,
    cover: String,
    track_count: u64,
    play_count: u64,
    creator: String,
    description: String,
}
#[derive(Clone, Default, Serialize)]
struct SearchResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    songs: Option<Vec<Song>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    albums: Option<Vec<AlbumSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artists: Option<Vec<ArtistSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    playlists: Option<Vec<PlaylistSummary>>,
    total: u64,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SearchKind {
    Song,
    Album,
    Artist,
    Playlist,
}
impl SearchKind {
    fn code(self) -> u16 {
        match self {
            Self::Song => 1,
            Self::Album => 10,
            Self::Artist => 100,
            Self::Playlist => 1000,
        }
    }
}
fn items<T>(raw: &Value, key: &str, map: impl Fn(&Value) -> Option<T>) -> Vec<T> {
    raw[key]
        .as_array()
        .map(|rows| rows.iter().filter_map(map).collect())
        .unwrap_or_default()
}
fn search_dto(raw: &Value, kind: SearchKind) -> ApiResult<SearchResult> {
    let result = raw
        .get("result")
        .filter(|r| r.is_object())
        .ok_or_else(unavailable)?;
    let mut data = SearchResult::default();
    match kind {
        SearchKind::Song => {
            data.songs = Some(items(result, "songs", song_dto));
            data.total = count(&result["songCount"]);
        }
        SearchKind::Album => {
            data.albums = Some(items(result, "albums", |a| {
                Some(AlbumSummary {
                    mid: id_of(&a["id"])?,
                    name: text(&a["name"]),
                    cover: cover(&a["picUrl"]),
                    publish_time: count(&a["publishTime"]),
                    size: count(&a["size"]),
                    artists: if a["artists"].is_array() {
                        artists(&a["artists"])
                    } else {
                        artists(&json!([a["artist"]]))
                    },
                })
            }));
            data.total = count(&result["albumCount"]);
        }
        SearchKind::Artist => {
            data.artists = Some(items(result, "artists", |a| {
                Some(ArtistSummary {
                    mid: id_of(&a["id"])?,
                    name: text(&a["name"]),
                    avatar: cover(&a["picUrl"]),
                    album_size: count(&a["albumSize"]),
                    mv_size: count(&a["mvSize"]),
                })
            }));
            data.total = count(&result["artistCount"]);
        }
        SearchKind::Playlist => {
            data.playlists = Some(items(result, "playlists", |p| {
                Some(PlaylistSummary {
                    id: id_of(&p["id"])?,
                    name: text(&p["name"]),
                    cover: cover(&p["coverImgUrl"]),
                    track_count: count(&p["trackCount"]),
                    play_count: count(&p["playCount"]),
                    creator: text(&p["creator"]["nickname"]),
                    description: text(&p["description"]),
                })
            }));
            data.total = count(&result["playlistCount"]);
        }
    }
    Ok(data)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Quality {
    Standard,
    Higher,
    Exhigh,
    Lossless,
    Hires,
    Jymaster,
}
const QUALITIES: [Quality; 6] = [
    Quality::Standard,
    Quality::Higher,
    Quality::Exhigh,
    Quality::Lossless,
    Quality::Hires,
    Quality::Jymaster,
];
impl Quality {
    fn field(self) -> &'static str {
        match self {
            Self::Standard => "l",
            Self::Higher => "m",
            Self::Exhigh => "h",
            Self::Lossless => "sq",
            Self::Hires => "hr",
            Self::Jymaster => "jm",
        }
    }
    fn bitrate(self) -> u64 {
        match self {
            Self::Standard => 128000,
            Self::Higher => 192000,
            Self::Exhigh => 320000,
            Self::Lossless => 999000,
            Self::Hires => 1999000,
            Self::Jymaster => 0,
        }
    }
    fn codec(self) -> &'static str {
        if self <= Self::Exhigh {
            "mp3"
        } else {
            "flac"
        }
    }
    fn content_type(self) -> &'static str {
        if self <= Self::Exhigh {
            "audio/mpeg"
        } else {
            "audio/flac"
        }
    }
    fn display(self) -> &'static str {
        match self {
            Self::Standard => "标准 · MP3 128 kbps",
            Self::Higher => "较高 · MP3 192 kbps",
            Self::Exhigh => "极高 · MP3 320 kbps",
            Self::Lossless => "无损 · FLAC",
            Self::Hires => "Hi-Res · FLAC",
            Self::Jymaster => "超清母带 · FLAC",
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QualityCapability {
    quality: Quality,
    default_codec: &'static str,
    content_type: &'static str,
    playback_class: &'static str,
    size_field: Option<&'static str>,
    display_name: &'static str,
}
impl QualityCapability {
    fn new(quality: Quality) -> Self {
        Self {
            quality,
            default_codec: quality.codec(),
            content_type: quality.content_type(),
            playback_class: "native",
            size_field: Some(quality.field()),
            display_name: quality.display(),
        }
    }
}
fn quality_candidates(song: &Value, privilege: &Value) -> Vec<Quality> {
    if privilege["st"].as_i64().is_some_and(|v| v < 0) {
        return Vec::new();
    }
    let caps: Vec<Quality> = ["plLevel", "playMaxBrLevel"]
        .iter()
        .filter_map(|key| serde_json::from_value(privilege[*key].clone()).ok())
        .collect();
    let cap = caps.into_iter().min();
    let br = ["pl", "playMaxBr"]
        .iter()
        .filter_map(|key| privilege[*key].as_u64())
        .min();
    if br == Some(0) {
        return Vec::new();
    }
    QUALITIES
        .into_iter()
        .filter(|q| {
            let file = &song[q.field()];
            if count(&file["size"]) == 0 && count(&file["br"]) == 0 {
                return false;
            }
            if cap.is_some_and(|cap| *q > cap) {
                return false;
            }
            // A bitrate alone cannot distinguish master from Hi-Res entitlement.
            if let Some(br) = br {
                if *q == Quality::Jymaster {
                    if cap != Some(Quality::Jymaster) {
                        return false;
                    }
                } else if q.bitrate() > br {
                    return false;
                }
            }
            if cap.is_none() && br.is_none() && *q > Quality::Exhigh {
                return false;
            }
            true
        })
        .collect()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QualityRow {
    quality: Quality,
    available: bool,
    size_bytes: Option<u64>,
    format: String,
    playback: &'static str,
    codec: String,
    content_type: String,
}
impl QualityRow {
    fn verified(requested: Quality, audio: Option<Audio>) -> Option<Self> {
        audio
            .filter(|audio| audio.quality == requested)
            .map(Self::from_audio)
    }
    fn from_audio(audio: Audio) -> Self {
        Self {
            quality: audio.quality,
            available: true,
            size_bytes: audio.size_bytes,
            format: audio.format,
            playback: "native",
            codec: audio.codec,
            content_type: audio.content_type,
        }
    }
}
#[derive(Serialize)]
struct Qualities {
    qualities: Vec<QualityRow>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Audio {
    url: String,
    quality: Quality,
    bitrate: u64,
    format: String,
    codec: String,
    content_type: String,
    size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_in: Option<u64>,
}
fn audio_dto(raw: &Value, id: &str) -> ApiResult<Option<Audio>> {
    let row = raw["data"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| id_of(&row["id"]).as_deref() == Some(id))
        })
        .ok_or_else(unavailable)?;
    if row["url"].is_null()
        || row.get("freeTrialInfo").is_some_and(|v| !v.is_null())
        || row["code"].as_i64().is_some_and(|v| v != 200)
    {
        return Ok(None);
    }
    let url = row["url"]
        .as_str()
        .and_then(cdn_url)
        .ok_or_else(unavailable)?;
    let quality: Quality =
        serde_json::from_value(row["level"].clone()).map_err(|_| unavailable())?;
    let codec = text(&row["type"]).to_ascii_lowercase();
    let content_type = match codec.as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "aac" | "m4a" => "audio/mp4",
        _ => return Err(unavailable()),
    };
    Ok(Some(Audio {
        url: url.into(),
        quality,
        bitrate: count(&row["br"]),
        format: codec.to_ascii_uppercase(),
        codec,
        content_type: content_type.into(),
        size_bytes: row["size"].as_u64().filter(|size| *size > 0),
        expires_in: row["expi"].as_u64(),
    }))
}
fn detail_params(id: &str) -> Value {
    json!({"c": json!([{"id": id.parse::<i64>().unwrap_or_default()}]).to_string()})
}
fn play_params(id: &str, quality: Quality) -> Value {
    json!({"ids": format!("[{id}]"), "level": quality, "encodeType": "flac"})
}
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    kind: Option<SearchKind>,
    limit: Option<usize>,
    offset: Option<usize>,
}
#[derive(Default, Deserialize)]
struct QualityQuery {
    quality: Option<Quality>,
}
fn adapter(state: &AppState) -> &Ncm {
    &state.ncm
}
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/ncm/capabilities", get(capabilities))
        .route("/ncm/search", get(search))
        .route("/ncm/song/:id", get(info))
        .route("/ncm/song/:id/qualities", get(qualities))
        .route("/ncm/song/:id/play", get(play))
}
async fn capabilities() -> Json<Value> {
    Json(json!({"enabled": true, "qualities": QUALITIES.map(QualityCapability::new)}))
}
async fn search(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> ApiResult<Json<SearchResult>> {
    let term = query.q.trim();
    if term.is_empty() || term.len() > 512 {
        return Err(bad());
    }
    let kind = query.kind.unwrap_or(SearchKind::Song);
    let limit = query.limit.unwrap_or(30).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).min(10000);
    let key = format!("{}:{limit}:{offset}:{term}", kind.code());
    let ncm = adapter(&state);
    if let Some(data) = ncm.searches.get(&key) {
        return Ok(Json(data));
    }
    let raw = ncm.request(SEARCH_PATH, json!({"s": term, "type": kind.code(), "limit": limit, "offset": offset, "total": true}), Crypto::Weapi).await?;
    let data = search_dto(&raw, kind)?;
    ncm.searches.put(key, data.clone(), 600);
    Ok(Json(data))
}
async fn info(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<SongInfo>> {
    check_id(&id)?;
    Ok(Json(detail_dto(&adapter(&state).detail(&id).await?, &id)?))
}
async fn qualities(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Qualities>> {
    check_id(&id)?;
    Ok(Json(adapter(&state).qualities(&id).await?))
}
async fn play(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<QualityQuery>,
) -> ApiResult<Response> {
    check_id(&id)?;
    let audio = adapter(&state)
        .audio(&id, query.quality.unwrap_or(Quality::Standard))
        .await?;
    play_response(audio)
}
fn play_response(audio: Option<Audio>) -> ApiResult<Response> {
    let audio = audio.ok_or_else(unavailable)?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(audio)).into_response())
}

#[cfg(test)]
#[path = "../tests/ncm_adapter/mod.rs"]
mod tests;
