use super::*;
use aes::cipher::BlockDecrypt;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use clap::{CommandFactory, FromArgMatches};
use tower::ServiceExt;

fn ncm() -> Ncm {
    Ncm::new(None).unwrap()
}
fn value<T: Serialize>(data: T) -> Value {
    serde_json::to_value(data).unwrap()
}
fn decrypt_aes(ciphertext: &[u8], key: &[u8; 16], iv: Option<&[u8; 16]>) -> Vec<u8> {
    let cipher = aes::Aes128::new(key.into());
    let mut result = ciphertext.to_vec();
    let mut previous = iv.copied().unwrap_or_default();
    for block in result.as_chunks_mut::<16>().0 {
        let saved = block.to_vec();
        let mut decrypted = Block::<aes::Aes128>::default();
        decrypted.copy_from_slice(block);
        cipher.decrypt_block(&mut decrypted);
        block.copy_from_slice(&decrypted);
        if iv.is_some() {
            for (byte, prior) in block.iter_mut().zip(previous) {
                *byte ^= prior;
            }
        }
        previous.copy_from_slice(&saved);
    }
    let pad = *result.last().unwrap() as usize;
    assert!((1..=16).contains(&pad));
    assert!(result[result.len() - pad..]
        .iter()
        .all(|b| *b as usize == pad));
    result.truncate(result.len() - pad);
    result
}
fn form(request: &reqwest::Request) -> BTreeMap<String, String> {
    let body = std::str::from_utf8(request.body().unwrap().as_bytes().unwrap()).unwrap();
    reqwest::Url::parse(&format!("http://localhost/?{body}"))
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}
fn decrypt_eapi(params: &str) -> String {
    String::from_utf8(decrypt_aes(&hex::decode(params).unwrap(), EAPI_KEY, None)).unwrap()
}

// Independent vectors generated with Node.js built-in crypto, the reference
// SPKI key and RSA_NO_PADDING. JSON matches ncm-api-rs crypto tests ({id:123}).
#[test]
fn weapi_matches_node_vector_and_both_cbc_layers_decrypt() {
    let data = json!({"id":123});
    let key = b"abcdefghijklmnop";
    let encrypted = weapi_with_key(&data, key);
    assert_eq!(
        encrypted[0].1,
        "ugrUdawIejHiEX1nhsPRxaRVzfD0VOUIeBSqjscBUwI="
    );
    assert_eq!(encrypted[1].1, "d15a1683c992095d0c234c19966605c5c5964911268bbeda8cb8d08d834913e59d53b32358903a121b5fca784c1f5ae44951fd02524df58ecc98e52cc7cf8689b42c2e93ddf05b0592512d87f5960467e2f086c018849d76014d323500e30f13ef4cafbb0cf5a66731a3f1776c75ca35d0062dac70a3e33245afabcf47938487");
    let first = decrypt_aes(&STANDARD.decode(&encrypted[0].1).unwrap(), key, Some(IV));
    let plaintext = decrypt_aes(&STANDARD.decode(&first).unwrap(), PRESET_KEY, Some(IV));
    assert_eq!(serde_json::from_slice::<Value>(&plaintext).unwrap(), data);
}
#[test]
fn weapi_uses_random_keys_and_fixed_width_rsa() {
    let first = weapi(&json!({"id":123}));
    let second = weapi(&json!({"id":123}));
    assert_ne!(first, second);
    for result in [first, second] {
        assert_eq!(result[1].1.len(), 256);
        assert_eq!(hex::decode(&result[1].1).unwrap().len(), 128);
        assert_eq!(STANDARD.decode(&result[0].1).unwrap().len() % 16, 0);
    }
}
#[test]
fn eapi_matches_known_node_vector_and_signature() {
    let expected = "7D398AA5036D61F11B22021C618C242421D51F26B6A0246E121BFC7B69A3481F62C92B909AF39DBF41E3032D9B8D0AD4255A14BDCC5BC706FCD0882A2B24200CED6B7441C4CAA692CC4F3A374162751C8F60B959A222F7C46E6094FC8DF43285";
    let encrypted = eapi("/api/song/detail", &json!({"id":123}));
    assert_eq!(encrypted[0].1, expected);
    assert_eq!(encrypted, eapi("/api/song/detail", &json!({"id":123})));
    let decrypted = decrypt_eapi(expected);
    let parts: Vec<_> = decrypted.split("-36cd479b6b5-").collect();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0], "/api/song/detail");
    assert_eq!(parts[1], "{\"id\":123}");
    assert_eq!(
        parts[2],
        hex::encode(Md5::digest(
            b"nobody/api/song/detailuse{\"id\":123}md5forencrypt"
        ))
    );
}
#[test]
fn crypto_handles_unicode_and_aligned_padding() {
    for length in [0, 1, 15, 16, 17, 31, 32] {
        let text = vec![b'x'; length];
        for iv in [None, Some(IV)] {
            let ciphertext = encrypt_aes(&text, EAPI_KEY, iv);
            assert_eq!(ciphertext.len(), (length / 16 + 1) * 16);
            assert_eq!(decrypt_aes(&ciphertext, EAPI_KEY, iv), text);
        }
    }
    let data = json!({"s":"网易云音乐 🎵"});
    assert!(decrypt_eapi(&eapi(SEARCH_PATH, &data)[0].1).contains("网易云音乐 🎵"));
}

// Field structure from ncm-api-rs APIs and docs/API.md (song_detail,
// cloudsearch, song_url_v1). A reduced representative response, not a live
// capture: the api-enhanced sparse clone has no module/docs blobs offline.
fn song() -> Value {
    json!({"id":347230,"name":"海阔天空","ar":[{"id":11127,"name":"Beyond"}],
        "al":{"id":34209,"name":"乐与怒","picUrl":"http://p1.music.126.net/cover.jpg"},
        "dt":326000,"fee":1,"mv":376199,"h":{"br":320000,"size":13040000},
        "m":{"br":192000,"size":7824000},"l":{"br":128000,"size":5216000},
        "sq":{"br":999000,"size":35000000},"hr":{"br":1999000,"size":70000000},
        "jm":{"br":2999000,"size":100000000},
        "privilege":{"fee":1,"pl":128000,"plLevel":"standard"},
        "account":{"MUSIC_U":"private-session"},"server":"private-upstream"})
}
fn detail() -> Value {
    json!({"code":200,"songs":[song()],"privileges":[{"id":347230,"fee":1,"pl":128000,"plLevel":"standard","maxbr":1999000}]})
}
fn play_data() -> Value {
    json!({"code":200,"data":[{"id":347230,"url":"http://m701.music.126.net/audio.mp3?auth=test",
        "br":320000,"size":13040000,"type":"mp3","code":200,"expi":1200,"level":"exhigh",
        "fee":1,"freeTrialInfo":null,"cookie":"private-session","server":"private-upstream"}]})
}
#[test]
fn search_song_uses_qq_contract_and_whitelists_fields() {
    let data = search_dto(
        &json!({"code":200,"result":{"songs":[song(),{"id":"../x"}],"songCount":60}}),
        SearchKind::Song,
    )
    .unwrap();
    let dto = value(data);
    assert_eq!(dto.as_object().unwrap().len(), 2);
    assert_eq!(dto["total"], 60);
    assert_eq!(dto["songs"].as_array().unwrap().len(), 1);
    assert_eq!(
        dto["songs"][0],
        json!({"id":"347230","name":"海阔天空","artists":[{"mid":"11127","name":"Beyond"}],
        "album":"乐与怒","albumMid":"34209","durationMs":326000,
        "cover":"https://p1.music.126.net/cover.jpg","vip":true,"ttml":false,"mv":"376199"})
    );
    assert!(!dto.to_string().contains("private"));
    assert!(!dto.to_string().contains("privilege"));
}
#[test]
fn older_song_shape_and_fee_flags_are_normalized() {
    let mut raw = json!({"id":1,"name":"test","artists":[{"id":2,"name":"artist"}],
        "album":{"id":3,"name":"album","picUrl":"https://p2.music.126.net/c.jpg"},"duration":12000,"mvid":4});
    let dto = value(song_dto(&raw).unwrap());
    assert_eq!(dto["durationMs"], 12000);
    assert_eq!(dto["albumMid"], "3");
    assert_eq!(dto["mv"], "4");
    for fee in [0, 1, 4, 8] {
        raw["fee"] = json!(fee);
        assert_eq!(song_dto(&raw).unwrap().vip, matches!(fee, 1 | 4));
    }
    raw.as_object_mut().unwrap().remove("fee");
    raw["privilege"] = json!({"fee":1});
    assert!(song_dto(&raw).unwrap().vip);
}
#[test]
fn search_maps_albums_artists_playlists_and_empty_pages() {
    let raw = json!({"result":{
        "albums":[{"id":34209,"name":"乐与怒","picUrl":"http://p1.music.126.net/a.jpg","publishTime":737683200000u64,
            "size":12,"artist":{"id":11127,"name":"Beyond"}}],"albumCount":10,
        "artists":[{"id":11127,"name":"Beyond","picUrl":"https://p1.music.126.net/b.jpg","albumSize":30,"mvSize":10}],"artistCount":1,
        "playlists":[{"id":123,"name":"摇滚","coverImgUrl":"https://p2.music.126.net/p.jpg","trackCount":100,"playCount":2000,
            "creator":{"nickname":"listener","cookie":"private"},"description":"经典"}],"playlistCount":7}});
    let albums = value(search_dto(&raw, SearchKind::Album).unwrap());
    assert_eq!(
        albums["albums"][0],
        json!({"mid":"34209","name":"乐与怒","cover":"https://p1.music.126.net/a.jpg",
        "publishTime":737683200000u64,"size":12,"artists":[{"mid":"11127","name":"Beyond"}]})
    );
    assert_eq!(albums["total"], 10);
    let artists = value(search_dto(&raw, SearchKind::Artist).unwrap());
    assert_eq!(artists["artists"][0]["albumSize"], 30);
    assert_eq!(artists["artists"][0]["mvSize"], 10);
    assert_eq!(artists["artists"][0]["mid"], "11127");
    let playlists = value(search_dto(&raw, SearchKind::Playlist).unwrap());
    assert_eq!(playlists["playlists"][0]["creator"], "listener");
    assert_eq!(playlists["playlists"][0]["trackCount"], 100);
    assert_eq!(playlists["total"], 7);
    assert!(!playlists.to_string().contains("private"));
    assert_eq!(
        value(search_dto(&json!({"result":{"songCount":0}}), SearchKind::Song).unwrap()),
        json!({"songs":[],"total":0})
    );
    assert!(search_dto(&json!({}), SearchKind::Song).is_err());
}
#[test]
fn lyric_new_maps_word_timestamps_translation_and_romanization() {
    let raw = json!({
        "code": 200,
        "yrc": {"version": 1, "lyric": "[0,120](0,60)海(60,60)阔\n"},
        "lrc": {"version": 1, "lyric": "[00:00.00]海阔天空\n"},
        "tlyric": {"version": 1, "lyric": "[00:00.00]Broad sky\n"},
        "romalrc": {"version": 1, "lyric": "[00:00.00]Hoi3 fut3\n"},
        "yromalrc": {"version": 1, "lyric": "[0,120](0,60)Hoi(60,60)\n"}
    });
    let dto = value(lyrics_dto(&raw));
    assert_eq!(
        dto,
        json!({
            "candidates": [
                {"source":"yrc", "text":"[0,120](0,60)海(60,60)阔\n"},
                {"source":"lrc", "text":"[00:00.00]海阔天空\n"}
            ],
            "rawYrc": true,
            "rawTrans": true,
            "rawRoma": true
        })
    );
    let lyrics = lyrics_dto(&raw);
    assert_eq!(lyrics.raw.yroma.as_deref(), Some("[0,120](0,60)Hoi(60,60)\n"));
    assert_eq!(raw_lyrics_kind(Some("yroma")).unwrap(), "yroma");
    assert_eq!(raw_lyrics_kind(Some("qrc")).err().unwrap().0, StatusCode::BAD_REQUEST);
}
#[test]
fn album_artist_and_playlist_samples_map_to_qq_contract() {
    let album = album_dto(
        &json!({
            "code": 200,
            "album": {"id": 42, "name":"专辑", "picUrl":"http://p1.music.126.net/a.jpg",
                "publishTime": 1700000000000u64, "size": 1, "type":"国语", "description":"desc",
                "artists":[{"id":7,"name":"歌手"}]},
            "songs": [song()]
        }),
        "42",
    )
    .unwrap();
    let album = value(album);
    assert_eq!(album["album"]["mid"], "42");
    assert_eq!(album["album"]["artists"][0], json!({"name":"歌手","mid":"7"}));
    assert_eq!(album["songs"][0]["id"], "347230");

    let artist_raw = json!({
        "code": 200,
        "data": {"artist": {"id": 7, "name":"歌手", "picUrl":"http://p1.music.126.net/a.jpg",
            "briefDesc":"brief", "trans":["Singer"], "musicSize":3, "albumSize":2, "mvSize":1},
            "user":{"description":"long", "birthday":946684800000u64}}
    });
    let artist = value(artist_detail_dto(&artist_raw, "7").unwrap());
    assert_eq!(artist["mid"], "7");
    assert_eq!(artist["description"], "long");
    assert_eq!(artist["transNames"], json!(["Singer"]));
    let songs = value(song_page_dto(&json!({"code":200,"data":{"songs":[song()],"total":"1","more":false}})));
    assert_eq!(songs, json!({"songs":[value(song_dto(&song()).unwrap())],"total":1,"more":false}));

    let playlist = value(playlist_info(
        &json!({"code":200,"playlist":{"id":99,"name":"歌单","coverImgUrl":"http://p2.music.126.net/p.jpg",
            "trackCount":1,"description":"desc","creator":{"nickname":"listener"},"updateTime":1700000000000u64}}),
        "99",
    ).unwrap());
    assert_eq!(playlist["id"], "99");
    assert_eq!(playlist["creator"], "listener");
    assert_eq!(playlist["updateTime"], 1700000000000u64);
}
#[test]
fn suggestion_sample_maps_all_three_collections() {
    let dto = value(suggest_dto(&json!({"code":200,"result":{
        "songs":[{"id":1,"name":"歌","artists":[{"id":2,"name":"人"}]}],
        "artists":[{"id":2,"name":"人","picUrl":"http://p1.music.126.net/a.jpg","albumSize":3,"mvSize":4}],
        "albums":[{"id":3,"name":"碟","artist":{"name":"人"},"picUrl":"http://p1.music.126.net/b.jpg"}]
    }})).unwrap());
    assert_eq!(dto["songs"][0], json!({"mid":"1","name":"歌","artist":"人"}));
    assert_eq!(dto["artists"][0]["mid"], "2");
    assert_eq!(dto["albums"][0], json!({"mid":"3","name":"碟","artist":"人","cover":"https://p1.music.126.net/b.jpg"}));
}
#[test]
fn detail_is_flattened_meta_is_absent_and_ids_must_match() {
    let dto = value(detail_dto(&detail(), "347230").unwrap());
    assert_eq!(dto["id"], "347230");
    assert_eq!(dto["name"], "海阔天空");
    assert!(dto.get("meta").is_none());
    assert_eq!(dto.as_object().unwrap().len(), 10);
    assert_eq!(
        detail_dto(&detail(), "1").err().unwrap().0,
        StatusCode::NOT_FOUND
    );
    assert!(detail_dto(&json!({"songs":[]}), "347230").is_err());
}
#[test]
fn play_reports_actual_tier_codec_expiry_and_only_public_fields() {
    let dto = value(audio_dto(&play_data(), "347230").unwrap().unwrap());
    assert_eq!(
        dto,
        json!({"url":"http://m701.music.126.net/audio.mp3?auth=test","quality":"exhigh",
        "bitrate":320000,"format":"MP3","codec":"mp3","contentType":"audio/mpeg","sizeBytes":13040000,"expiresIn":1200})
    );
    let mut raw = play_data();
    raw["data"][0]["level"] = json!("lossless");
    raw["data"][0]["type"] = json!("flac");
    raw["data"][0]["br"] = json!(999000);
    assert_eq!(
        value(audio_dto(&raw, "347230").unwrap().unwrap())["contentType"],
        "audio/flac"
    );
    assert!(audio_dto(&raw, "1").is_err());
}
#[test]
fn no_url_and_trial_snippets_never_become_playable_audio() {
    for patch in [
        json!({"url":null,"code":-110}),
        json!({"freeTrialInfo":{"start":0,"end":30}}),
        json!({"code":404}),
    ] {
        let mut raw = play_data();
        raw["data"][0]
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(audio_dto(&raw, "347230").unwrap().is_none());
    }
    let mut raw = play_data();
    for url in [
        "javascript:alert(1)",
        "https://user:secret@m701.music.126.net/x",
        "https://music.126.net.evil.test/x",
        "https://127.0.0.1/x",
    ] {
        raw["data"][0]["url"] = json!(url);
        assert!(audio_dto(&raw, "347230").is_err());
    }
}
#[test]
fn quality_candidates_respect_entitlement_not_catalog_maximum() {
    let song = song();
    assert_eq!(
        quality_candidates(&song, &json!({"pl":128000,"maxbr":2999000})),
        vec![Quality::Standard]
    );
    assert_eq!(
        quality_candidates(
            &song,
            &json!({"pl":320000,"playMaxBr":999000,"plLevel":"exhigh","maxBrLevel":"jymaster"})
        ),
        QUALITIES[..3]
    );
    assert_eq!(
        quality_candidates(
            &song,
            &json!({"plLevel":"lossless","playMaxBrLevel":"hires"})
        ),
        QUALITIES[..4]
    );
    assert_eq!(
        quality_candidates(&song, &json!({"pl":1999000,"plLevel":"jymaster"})),
        QUALITIES
    );
    assert!(quality_candidates(&song, &json!({"pl":0,"plLevel":"standard"})).is_empty());
    assert!(quality_candidates(&song, &json!({"st":-200,"pl":320000})).is_empty());
    assert_eq!(quality_candidates(&song, &Value::Null), QUALITIES[..3]);
    assert!(quality_candidates(&json!({}), &Value::Null).is_empty());
}
#[test]
fn quality_row_uses_actual_audio_size_and_codec() {
    let row = value(QualityRow::from_audio(
        audio_dto(&play_data(), "347230").unwrap().unwrap(),
    ));
    assert_eq!(
        row,
        json!({"quality":"exhigh","available":true,"sizeBytes":13040000,"format":"MP3","playback":"native","codec":"mp3","contentType":"audio/mpeg"})
    );
}
#[test]
fn qualities_reject_fallbacks_and_unavailable_audio() {
    assert!(
        QualityRow::verified(Quality::Hires, audio_dto(&play_data(), "347230").unwrap()).is_none()
    );
    assert!(QualityRow::verified(Quality::Standard, None).is_none());
    assert!(
        QualityRow::verified(Quality::Exhigh, audio_dto(&play_data(), "347230").unwrap()).is_some()
    );
}
#[tokio::test]
async fn play_http_response_is_uncached_and_unavailable_matches_qq_error_shape() {
    let response = play_response(audio_dto(&play_data(), "347230").unwrap()).unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert_eq!(body(response).await["quality"], "exhigh");
    let mut raw = play_data();
    raw["data"][0]["url"] = Value::Null;
    let response = play_response(audio_dto(&raw, "347230").unwrap())
        .err()
        .unwrap()
        .into_response();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        body(response).await,
        json!({"error":"NCM source temporarily unavailable"})
    );
}
#[test]
fn request_origins_modes_headers_and_params_match_reference() {
    let ncm = ncm();
    ncm.cookies.insert("MUSIC_U", "private-session");
    ncm.cookies.insert("__csrf", "csrf-test");
    for path in [SEARCH_PATH, DETAIL_PATH] {
        let request = ncm
            .request_builder(path, json!({"id":123}), Crypto::Weapi)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            format!("{MUSIC}/weapi/{}", &path[5..])
        );
        assert_eq!(request.headers()[header::USER_AGENT], WEB_UA);
        assert_eq!(request.headers()[header::REFERER], MUSIC);
        assert!(request.headers()[header::COOKIE].is_sensitive());
        assert!(request.headers()[header::COOKIE]
            .to_str()
            .unwrap()
            .contains("MUSIC_U=private-session"));
        assert_eq!(
            request.headers()[header::CONTENT_TYPE],
            "application/x-www-form-urlencoded"
        );
        assert_eq!(form(&request)["encSecKey"].len(), 256);
    }
    let request = ncm
        .request_builder(
            PLAY_PATH,
            play_params("347230", Quality::Hires),
            Crypto::Eapi,
        )
        .unwrap()
        .build()
        .unwrap();
    assert_eq!(
        request.url().as_str(),
        "https://interface.music.163.com/eapi/song/enhance/player/url/v1"
    );
    assert_eq!(request.headers()[header::USER_AGENT], APP_UA);
    let plaintext = decrypt_eapi(&form(&request)["params"]);
    let parts: Vec<_> = plaintext.split("-36cd479b6b5-").collect();
    assert_eq!(parts[0], PLAY_PATH);
    let body: Value = serde_json::from_str(parts[1]).unwrap();
    assert_eq!(body["ids"], "[347230]");
    assert_eq!(body["level"], "hires");
    assert_eq!(body["encodeType"], "flac");
    assert_eq!(body["e_r"], false);
    assert_eq!(body["header"]["os"], "pc");
    assert_eq!(body["header"]["MUSIC_U"], "private-session");
    assert_eq!(body["header"]["__csrf"], "csrf-test");
    assert_eq!(detail_params("347230"), json!({"c":"[{\"id\":347230}]"}));
    for (path, crypto) in [
        ("https://evil.test/api/test", Crypto::Weapi),
        ("/api/test", Crypto::Eapi),
        (SEARCH_PATH, Crypto::Eapi),
    ] {
        assert!(ncm.request_builder(path, json!({}), crypto).is_err());
    }
    assert!(format!("{:?}", ncm.api).contains("Policy(None)"));
}
#[test]
fn cookie_file_is_optional_private_and_invalid_content_is_redacted() {
    assert!(Ncm::new(Some(FilePath::new("/nonexistent-ncm-cookie-file"))).is_ok());
    let path = std::env::temp_dir().join(format!(
        "fantastic-ncm-{}-{}.txt",
        std::process::id(),
        rand::random::<u64>()
    ));
    std::fs::write(&path, "MUSIC_U=private-session; __csrf=test-csrf; os=pc\n").unwrap();
    let ncm = Ncm::new(Some(&path)).unwrap();
    let cookies = ncm.cookies.values(&MUSIC.parse().unwrap());
    assert_eq!(cookies["MUSIC_U"], "private-session");
    assert_eq!(cookies["os"], "pc");
    std::fs::write(&path, "MUSIC_U=private-session\nInjected: private-session").unwrap();
    let message = Ncm::new(Some(&path)).err().unwrap();
    assert_eq!(message, "Invalid NCM cookie file");
    std::fs::remove_file(path).unwrap();
}
#[test]
fn cookie_jar_obeys_origin_path_expiry_and_set_cookie() {
    fn response(raw: &str, origin: &str) -> reqwest::Response {
        use reqwest::ResponseBuilderExt;
        axum::http::Response::builder()
            .url(origin.parse().unwrap())
            .header(header::SET_COOKIE, raw)
            .body("")
            .unwrap()
            .into()
    }
    let jar = CookieJar::default();
    jar.insert("os", "pc");
    jar.store(&response(
        "MUSIC_U=secret; Domain=.music.163.com; Path=/",
        MUSIC,
    ));
    assert_eq!(jar.values(&INTERFACE.parse().unwrap())["MUSIC_U"], "secret");
    assert!(jar.values(&"https://evil.test".parse().unwrap()).is_empty());
    jar.store(&response("MUSIC_U=evil; Domain=evil.test; Path=/", MUSIC));
    assert_eq!(jar.values(&MUSIC.parse().unwrap())["MUSIC_U"], "secret");
    jar.store(&response("scoped=secret; Path=/eapi", INTERFACE));
    assert!(!jar
        .values(&format!("{INTERFACE}/weapi/test").parse().unwrap())
        .contains_key("scoped"));
    assert!(!jar
        .values(&format!("{INTERFACE}/eapi2").parse().unwrap())
        .contains_key("scoped"));
    assert!(jar
        .values(&format!("{INTERFACE}/eapi/test").parse().unwrap())
        .contains_key("scoped"));
    jar.store(&response(
        "MUSIC_U=deleted; Domain=.music.163.com; Max-Age=0",
        MUSIC,
    ));
    assert!(!jar.values(&MUSIC.parse().unwrap()).contains_key("MUSIC_U"));
    jar.store(&response(
        "expired=no; Expires=Sat, 01 Jan 2000 00:00:00 GMT",
        MUSIC,
    ));
    assert!(!jar.values(&MUSIC.parse().unwrap()).contains_key("expired"));
}
#[test]
fn cli_accepts_cookie_file_and_environment_with_cli_precedence() {
    use crate::cli::Cli;
    const CHILD: &str = "FANTASTIC_NCM_CLI_TEST_CHILD";
    if std::env::var_os(CHILD).is_some() {
        let cli =
            Cli::from_arg_matches(&Cli::command().try_get_matches_from(["fantastic"]).unwrap())
                .unwrap();
        assert_eq!(
            cli.ncm_cookie_file.as_deref(),
            Some(FilePath::new("/tmp/ncm-env-cookie.txt"))
        );
        let cli = Cli::from_arg_matches(
            &Cli::command()
                .try_get_matches_from(["fantastic", "--ncm-cookie-file", "/tmp/ncm-cli-cookie.txt"])
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            cli.ncm_cookie_file.as_deref(),
            Some(FilePath::new("/tmp/ncm-cli-cookie.txt"))
        );
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "ncm::tests::cli_accepts_cookie_file_and_environment_with_cli_precedence",
        ])
        .env(CHILD, "1")
        .env("FANTASTIC_NCM_COOKIE_FILE", "/tmp/ncm-env-cookie.txt")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
async fn get(state: Arc<AppState>, path: &str) -> Response {
    crate::router(state)
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
}
async fn body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 100000).await.unwrap()).unwrap()
}
#[tokio::test]
async fn capabilities_are_always_enabled_including_local_wrapper_mode() {
    let mut state = AppState::new("http://localhost:12340".into());
    state.config.wrapper_relay = false;
    let state = Arc::new(state);
    let dto = body(get(state.clone(), "/ncm/capabilities").await).await;
    assert_eq!(dto["enabled"], true);
    let rows = dto["qualities"].as_array().unwrap();
    assert_eq!(rows.len(), 6);
    assert_eq!(
        rows.iter()
            .map(|q| q["quality"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["standard", "higher", "exhigh", "lossless", "hires", "jymaster"]
    );
    assert_eq!(rows[0].as_object().unwrap().len(), 6);
    assert_eq!(rows[0]["defaultCodec"], "mp3");
    assert_eq!(rows[3]["defaultCodec"], "flac");
    let response = get(state, "/assets/host.js").await;
    let text = String::from_utf8(
        to_bytes(response.into_body(), 100000)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(text.contains("\"ncmEnabled\":true"));
    assert!(!text.contains("MUSIC_U"));
}
#[tokio::test]
async fn invalid_requests_and_out_of_scope_routes_make_no_upstream_requests() {
    let state = Arc::new(AppState::new("http://localhost:12340".into()));
    for id in ["0", "01", "-1", "abc", "9223372036854775808", "1%21"] {
        for suffix in ["", "/play", "/qualities"] {
            assert_eq!(
                get(state.clone(), &format!("/ncm/song/{id}{suffix}"))
                    .await
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
    }
    for path in [
        "/ncm/search?q=%20",
        "/ncm/search?q=x&kind=mv",
        "/ncm/song/1/play?quality=sky",
    ] {
        assert_eq!(
            get(state.clone(), path).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
    for path in ["/ncm/cookie"] {
        assert_eq!(
            get(state.clone(), path).await.status(),
            StatusCode::NOT_FOUND
        );
    }
}
#[tokio::test]
async fn cached_ncm_raw_lyrics_matches_qq_download_contract() {
    let state = Arc::new(AppState::new("http://localhost:12340".into()));
    state.ncm.details.put("347230".into(), detail(), 60);
    state.ncm.lyrics.put(
        "347230".into(),
        lyrics_dto(&json!({"code":200,"lrc":{"lyric":"[00:00.00]海阔天空\n"}})),
        60,
    );
    let response = get(state.clone(), "/ncm/song/347230/lyrics/raw?kind=lrc").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(response.headers()[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .contains("filename*=UTF-8''"));
    assert_eq!(
        String::from_utf8(to_bytes(response.into_body(), 100000).await.unwrap().to_vec()).unwrap(),
        "[00:00.00]海阔天空\n"
    );
    assert_eq!(
        get(state, "/ncm/song/347230/lyrics/raw?kind=qrc").await.status(),
        StatusCode::BAD_REQUEST
    );
}
#[tokio::test]
async fn cached_detail_search_and_errors_use_public_contract() {
    let state = Arc::new(AppState::new("http://localhost:12340".into()));
    state.ncm.details.put("347230".into(), detail(), 60);
    let search = search_dto(
        &json!({"result":{"songs":[song()],"songCount":1}}),
        SearchKind::Song,
    )
    .unwrap();
    state
        .ncm
        .searches
        .put("1:100:10000:test".into(), search, 60);
    assert_eq!(
        body(get(state.clone(), "/ncm/song/347230").await).await["id"],
        "347230"
    );
    assert_eq!(
        body(get(state, "/ncm/search?q=test&limit=999&offset=999999").await).await["total"],
        1
    );
    for error in [unavailable(), missing(), bad()] {
        let response = error.into_response();
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        let dto = body(response).await;
        assert_eq!(dto.as_object().unwrap().len(), 1);
        assert!(
            dto["error"].as_str().unwrap().starts_with("NCM ")
                || dto["error"] == "Invalid NCM request"
        );
    }
    assert!(check_response(json!({"code":403,"cookie":"private"})).is_err());
    assert!(check_response(json!({"code":200})).is_ok());
}
