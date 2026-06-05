# glasspane로 배우는 Tauri & Rust

이 문서는 **glasspane 코드베이스를 교재 삼아** Tauri 2와 Rust의 핵심 개념을 익히기 위한 자료입니다.
별도 예제가 아니라 **실제로 동작하는 이 앱의 코드**를 짚어가며 설명하므로, 읽고 → 코드를 열어보고 →
직접 고쳐보는 순서로 학습하길 권합니다.

> 참고할 핵심 파일
> - `src-tauri/src/lib.rs` — 앱 진입점(빌더 조립)
> - `src-tauri/src/imaging.rs` — 데이터 명령 + `imgsrv` 커스텀 프로토콜 + 썸네일 캐시
> - `src-tauri/src/convert.rs` — 배치 변환(채널로 진행률 스트리밍)
> - `src/lib/viewerApi.ts` — 프론트엔드 ↔ 백엔드 브리지
> - `src-tauri/tauri.conf.json` — 앱/보안(CSP)/번들 설정

---

## 0. 큰 그림 — Tauri 앱은 어떻게 생겼나

Tauri 앱은 두 개의 세계로 나뉩니다.

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Frontend (WebView)         │        │  Core (Rust)                 │
│  React + TS, src/           │  IPC   │  src-tauri/, 네이티브 바이너리 │
│  - UI, 상태, 이벤트          │ <────> │  - 파일시스템/zip/이미지 디코드 │
│  - invoke(...) 호출          │        │  - #[tauri::command] 함수      │
│  - <img src="imgsrv://..."> │        │  - 커스텀 URI 프로토콜          │
└─────────────────────────────┘        └──────────────────────────────┘
```

glasspane은 프론트↔백엔드를 **두 개의 평면(plane)** 으로 설계했습니다 (CLAUDE.md §6).

| 평면 | 용도 | 메커니즘 | 코드 |
|------|------|----------|------|
| **데이터 평면** | 디렉터리/아카이브 목록, 메타데이터 | `invoke` 명령 (JSON 직렬화) | `list_dir`, `list_archive`, `image_meta` |
| **이미지 바이트 평면** | 썸네일/원본 이미지 바이트 | 커스텀 프로토콜 `imgsrv://` → `<img>`로 직행 | `register_imgsrv` |

**왜 이미지를 invoke로 안 보내나?** invoke 응답은 JSON(IPC 브리지)을 통과하므로 이미지 바이트를
base64로 실어 보내면 메모리·전송 비용이 폭발합니다. 그래서 이미지는 별도의 HTTP-스타일 프로토콜로
스트리밍해 브라우저 `<img>`가 직접 받게 합니다. **이 설계 결정 자체가 Tauri 학습의 핵심 포인트**입니다.

---

## 1. 진입점 — 빌더 조립 (`lib.rs`)

```rust
mod convert;     // 같은 디렉터리의 convert.rs를 모듈로 포함
mod imaging;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = imaging::register_imgsrv(tauri::Builder::default());
    builder
        .plugin(tauri_plugin_dialog::init())          // 네이티브 폴더 선택 플러그인
        .invoke_handler(tauri::generate_handler![     // 프론트에서 invoke 가능한 명령 등록
            imaging::list_dir,
            imaging::list_archive,
            imaging::image_meta,
            convert::convert_images
        ])
        .run(tauri::generate_context!())              // tauri.conf.json을 읽어 앱 구성
        .expect("error while running glasspane");
}
```

**Rust 학습 포인트**
- `mod convert;` — Rust의 **모듈 시스템**. 파일 = 모듈. `convert::convert_images`로 경로 접근.
- `pub fn run()` — `pub`은 가시성(visibility). 크레이트 밖에서 호출 가능.
- `#[cfg_attr(mobile, ...)]` — **조건부 컴파일 속성**. `mobile` 빌드일 때만 속성을 붙임.
- `.expect("...")` — `Result`가 `Err`이면 메시지와 함께 패닉. 진입점에서만 쓰는 패턴.

**Tauri 학습 포인트**
- `generate_handler!` — 매크로가 컴파일 타임에 명령 라우팅 코드를 생성. **앱 명령은 권한 설정이 불필요**
  (플러그인 명령만 capability 필요 — §5 참고).
- `generate_context!` — `tauri.conf.json`을 빌드에 인라인.
- 빌더는 **체이닝(method chaining)** 으로 플러그인·핸들러·프로토콜을 조립.

---

## 2. invoke 명령 — 데이터 평면 (`imaging.rs`)

### 2.1 직렬화되는 타입 (계약)

```rust
#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: String,   // "dir" | "archive" | "image"
    pub size: u64,
    pub mtime: u64,
}
```

- `#[derive(Serialize)]` — serde가 이 구조체 → JSON 변환 코드를 자동 생성. 프론트의
  `interface DirEntry`(viewerApi.ts)와 **필드 이름이 1:1로 대응**합니다.
- `convert.rs`의 `ConvertOpts`는 `#[serde(rename_all = "camelCase")]`를 써서 Rust의 `dest_dir`을
  JSON의 `destDir`로 매핑합니다 — Rust(snake_case) ↔ JS(camelCase) 관례 차이를 흡수하는 방법.

### 2.2 명령 함수

```rust
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let rd = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut entries: Vec<DirEntry> = Vec::new();

    for entry in rd.flatten() {                 // Result를 걸러 성공만 순회
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {      // match로 Result 분기
            Ok(ft) => ft,
            Err(_) => continue,
        };
        // ...kind 판정...
        let (size, mtime) = entry.metadata().map(meta_size_mtime).unwrap_or((0, 0));
        entries.push(DirEntry { name, /* ... */ });
    }

    entries.sort_by(|a, b| { /* dir 먼저, 그다음 이름(대소문자 무시) */ });
    Ok(entries)
}
```

**Rust 학습 포인트 (이 함수 하나에 알맹이가 다 있음)**
- **에러 전파 `?`** — `map_err(|e| e.to_string())?`는 "에러면 `String`으로 바꿔 즉시 반환, 아니면 값을 꺼냄".
  `Result<T, String>`을 반환하므로 프론트에서 `try/catch`로 잡힙니다.
- **소유권/빌림** — `fs::read_dir(&path)`는 `path`를 빌려(`&`) 소유권을 넘기지 않음.
- **`Option`/`Result` 콤비네이터** — `.map(...)`, `.unwrap_or((0,0))`, `.and_then(...)`.
- **클로저** — `sort_by(|a, b| ...)`의 `|a, b|`가 클로저. (clippy가 단순 키 정렬은
  `sort_by_key`를 권함 — `list_archive`가 그 예: `out.sort_by_key(|a| a.name.to_lowercase())`.)
- **패턴 구조분해** — `let (size, mtime) = ...` 튜플 분해.

> **프론트 대응** (`viewerApi.ts`):
> ```ts
> export function listDir(path: string): Promise<DirEntry[]> {
>   return invoke<DirEntry[]>("list_dir", { path });
> }
> ```
> 인자 객체의 키(`path`)가 Rust 파라미터 이름과 일치해야 합니다.

---

## 3. 커스텀 프로토콜 — 이미지 바이트 평면 (`imaging.rs`)

이 부분이 glasspane에서 **가장 Tauri다운** 코드입니다.

```rust
pub fn register_imgsrv<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("imgsrv", move |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        std::thread::spawn(move || {              // 워커 스레드: UI 스레드 절대 안 막음
            let response = handle_request(&app, request);
            responder.respond(response);
        });
    })
}
```

- `register_asynchronous_uri_scheme_protocol` — `imgsrv://` 요청을 가로채는 핸들러 등록.
  클로저 시그니처 `|ctx, request, responder|` 는 **설치된 Tauri 2 버전에 맞춰야** 함 (CLAUDE.md §10).
- `std::thread::spawn(move || ...)` — 디코드는 무거우므로 워커 스레드로. `move`는 `app`·`request`의
  **소유권을 클로저로 이동**.
- `<R: Runtime>` — **제네릭 + 트레잇 바운드**. 어떤 Tauri 런타임에도 동작.

요청 라우팅(`handle_request`)은 쿼리스트링을 직접 파싱해(외부 `url` 크레이트 회피) `/thumb`·`/full`로 분기:

```rust
let result = match uri.path() {
    "/thumb" => { let w = query.get("w")...unwrap_or(256); serve_thumb(app, &src, w) }
    "/full"  => serve_full(&src),
    other    => return error_response(StatusCode::NOT_FOUND, ...),
};
```

> **프론트 대응** — `<img src={thumbUrl(item, 256)}>`. URL 빌더는 플랫폼별 origin 차이를 흡수:
> ```ts
> // Windows: http://imgsrv.localhost / 그 외: imgsrv://localhost
> return isWindows ? "http://imgsrv.localhost" : "imgsrv://localhost";
> ```
> 이 **플랫폼 분기**는 흔한 함정이라 꼭 기억하세요 (CLAUDE.md §10).

### 3.1 디스크 캐시 + 캐시 키 (Rust 해시)

```rust
fn cache_key(src: &Src, w: u32) -> String {
    let container = src.archive.as_deref().unwrap_or(&src.path);
    let (size, mtime) = file_sig(container);
    let mut h = DefaultHasher::new();
    container.hash(&mut h);
    size.hash(&mut h);
    mtime.hash(&mut h);
    src.path.hash(&mut h);    // zip 내부 엔트리 이름
    w.hash(&mut h);
    format!("{:016x}", h.finish())   // 16자리 16진수 파일명
}
```

- **캐시 무효화 전략**: 컨테이너 파일의 `(size, mtime)`가 키에 포함 → 원본이 바뀌면 키가 바뀌어
  자동으로 새 썸네일을 생성. 이미지 처리 앱에서 자주 쓰는 패턴입니다.
- 캐시 위치는 `app.path().app_cache_dir()` 아래 `/thumbs` — **Tauri의 경로 API**로 OS별 캐시 폴더를 얻음.

---

## 4. 동시성 — 세마포어를 std만으로 (`imaging.rs`)

그리드가 수백 장 썸네일을 한꺼번에 요청하면 스레드마다 디코드가 동시에 터집니다. 그래서 **동시 디코드 수**를
CPU 수 정도로 제한하는 카운팅 세마포어를 직접 만들었습니다 (외부 크레이트 없이).

```rust
struct Semaphore { permits: Mutex<usize>, cv: Condvar }
struct Permit<'a>(&'a Semaphore);

impl Drop for Permit<'_> {            // RAII: 스코프를 벗어나면 자동 반납
    fn drop(&mut self) {
        *self.0.permits.lock().unwrap() += 1;
        self.0.cv.notify_one();
    }
}

impl Semaphore {
    fn acquire(&self) -> Permit<'_> {
        let mut n = self.permits.lock().unwrap();
        while *n == 0 { n = self.cv.wait(n).unwrap(); }   // 허가 없으면 대기
        *n -= 1;
        Permit(self)
    }
}

fn decode_sem() -> &'static Semaphore {
    static SEM: OnceLock<Semaphore> = OnceLock::new();    // 지연 초기화 전역 싱글턴
    SEM.get_or_init(|| Semaphore {
        permits: Mutex::new(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)),
        cv: Condvar::new(),
    })
}
```

사용처는 캐시 미스일 때만:
```rust
let _permit = decode_sem().acquire();   // 여기서 허가 획득
let raw = read_source_bytes(src)?;
let thumb = make_thumb(&raw, w)?;
// _permit이 함수 끝에서 Drop → 자동 반납
```

**Rust 학습 포인트 (밀도 높음)**
- **`Mutex` + `Condvar`** — 표준 라이브러리만으로 만든 카운팅 세마포어.
- **`Drop` 트레잇 = RAII** — `Permit`이 스코프를 벗어나면 `drop`이 호출돼 허가를 자동 반납. 수동 release 불필요.
- **`OnceLock`** — 스레드 안전한 지연 초기화. 전역 싱글턴을 만들 때의 현대적 관용구.
- **라이프타임 `'a`** — `Permit<'a>`는 빌린 `&Semaphore`보다 오래 살 수 없음을 컴파일러가 보장.
- **`available_parallelism()`** — 논리 코어 수.

---

## 5. 플러그인 · 권한 · CSP (`tauri.conf.json`, `capabilities/`)

- **플러그인**: `tauri_plugin_dialog::init()`으로 네이티브 폴더 선택. 프론트는 `@tauri-apps/plugin-dialog`의
  `open({ directory: true })` 사용.
- **권한(capability)**: 플러그인 명령은 `src-tauri/capabilities/default.json`의 `permissions` 배열에
  `"dialog:allow-open"` 같은 항목이 있어야 호출 가능. (앱 자체 명령은 불필요.)
- **CSP** (`tauri.conf.json`의 `app.security.csp`):
  ```
  img-src 'self' imgsrv: http://imgsrv.localhost data: blob:;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com
  ```
  **`imgsrv` 스킴을 `img-src`에 넣지 않으면 이미지가 조용히 안 뜹니다.** 인라인 스타일·구글폰트 때문에
  `unsafe-inline`과 폰트 호스트도 허용. **보안 정책이 기능에 직결되는 좋은 예.**

---

## 6. 채널로 진행률 스트리밍 (`convert.rs`)

invoke는 "요청→단일 응답"이지만, 변환은 진행 상황을 **여러 번** 흘려보내야 합니다. Tauri 2의 `Channel`을 사용:

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress { pub done: u32, pub total: u32, pub name: String }

#[tauri::command]
pub fn convert_images(
    sources: Vec<Src>,
    opts: ConvertOpts,
    on_progress: Channel<Progress>,     // 프론트가 넘긴 채널
) -> Result<ConvertReport, String> {
    for (i, src) in sources.iter().enumerate() {
        // ...변환...
        let _ = on_progress.send(Progress { done: i as u32 + 1, total, name: ... });
    }
    Ok(report)
}
```

> **프론트 대응** (`viewerApi.ts`):
> ```ts
> const channel = new Channel<ConvertProgress>();
> if (onProgress) channel.onmessage = onProgress;   // 메시지마다 콜백
> return invoke("convert_images", { sources, opts, onProgress: channel });
> ```
> Rust의 `on_progress` ↔ JS의 `onProgress` (snake/camel 자동 변환). 다이얼로그는 이걸로 `변환 중… 3/10`을 표시.

**Rust 학습 포인트**: `.iter().enumerate()`로 인덱스와 함께 순회, `as u32` 캐스팅, `let _ = ...`로 결과 의도적 무시.

---

## 7. 추천 학습 경로 & 연습 과제

코드를 **직접 만져보는 것**이 가장 빠릅니다. 난이도 순:

1. **(쉬움) 명령 하나 추가** — `imaging.rs`에 `#[tauri::command] pub fn ping() -> String { "pong".into() }`를
   만들고 `generate_handler!`에 등록 → `viewerApi.ts`에 래퍼 추가 → 콘솔에서 호출. invoke 왕복 전체를 체감.
2. **(쉬움) 새 이미지 확장자 지원** — `is_image` / `passthrough_content_type`에 포맷 추가하고 동작 확인.
3. **(중간) 썸네일 품질 파라미터** — `encode_jpeg`에 quality를 받게 바꾸고 `/thumb?...&q=80`로 전달.
   쿼리 파싱(`parse_query`)→ JPEG 인코더 옵션까지 한 줄기로 따라가 보기.
4. **(중간) 캐시 비우기 명령** — `thumbs_dir`를 비우는 `clear_thumb_cache` 명령 추가. `app_cache_dir` 이해.
5. **(어려움) 세마포어 한도 설정화** — `decode_sem`의 permit 수를 설정/환경변수로 조절. `OnceLock`·`Mutex` 심화.

각 과제 후 **2단계 검증 루프**(아래)로 돌려보세요.

학습 자료(공식 문서):
- Tauri 2: <https://v2.tauri.app/> (특히 *Calling Rust*, *Custom Protocols*, *Channels*, *Capabilities*)
- Rust: *The Book* <https://doc.rust-lang.org/book/> + *Rust by Example*. 이 앱과 관련해선
  4장(소유권), 6/18장(match·패턴), 10장(제네릭/트레잇/라이프타임), 13장(클로저/이터레이터), 16장(동시성).

---

## 8. 로컬에서 테스트/실행하는 법

### 8.1 사전 준비 (한 번)
- **Node 20+**, **Rust 안정판**(`rustup`), 그리고 OS별 네이티브 의존성:
  - **Debian/Ubuntu**: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libdav1d-dev build-essential file`
    (AVIF용 **libdav1d는 ≥ 1.3.0** 필요 — Ubuntu 22.04는 0.9.2라 안 되고 **24.04**가 1.4.x로 OK. CI도 24.04 사용.)
  - **macOS**: `brew install dav1d`
  - **Windows**: vcpkg로 dav1d
- 의존성 설치: 저장소 루트에서 `npm install`.

> 💡 **libdav1d가 없거나 너무 구버전이면?** `src-tauri/Cargo.toml`의 `image` 줄에서 `avif-native` 피처를
> 빼면 빌드됩니다. WebP/JPEG/PNG/GIF는 그대로 동작하고 AVIF만 깨진-썸네일로 폴백합니다 (CLAUDE.md §7.1/§10).

### 8.2 개발 실행 (핫 리로드)
```bash
npm run tauri dev
```
- 내부적으로 `beforeDevCommand`(= `npm run dev`, Vite를 `localhost:1420`에)를 띄우고 Rust 코어를 빌드해
  네이티브 창을 엽니다. **프론트 수정은 즉시 핫 리로드**, **Rust 수정은 자동 재빌드/재시작**.
- 폴더를 열고(폴더 열기 버튼) 썸네일·뷰어·줌/팬·변환·진행률을 직접 확인하세요.

### 8.3 "2단계 검증 루프" (커밋 전에 매번)
이 저장소의 CI가 보는 것과 동일:
```bash
# 프론트: 타입체크(strict) + 번들
npm run build

# 백엔드: 포맷/린트/컴파일 (CI는 clippy 경고를 에러로 취급)
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo check
```
> ⚠️ **clippy 버전 차이 주의**: CI는 최신 stable의 clippy를 씁니다. 로컬이 구버전이면 잡지 못한 린트가
> CI에서 터질 수 있어요(이번에 `unnecessary_sort_by`로 실제 겪음). `rustup update stable`로 맞추면 동일해집니다.

### 8.4 Rust 단위 테스트 (선택)
순수 로직(예: `cache_key`, `zip_dt_sort_key`, `parse_query`)은 Tauri 없이 테스트 가능합니다.
`imaging.rs` 하단에 추가하고 `cd src-tauri && cargo test`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_parses_pairs_and_percent() {
        let q = parse_query("path=a%20b&w=256");
        assert_eq!(q.get("path").unwrap(), "a b");
        assert_eq!(q.get("w").unwrap(), "256");
    }
}
```

### 8.5 캐시/디버깅 팁
- 썸네일 디스크 캐시는 OS 앱 캐시 폴더의 `glasspane/thumbs/`에 쌓입니다. 캐시 동작을 보려면 이 폴더를 지우고
  다시 스크롤해 보세요(첫 디코드 vs 캐시 히트).
- 프론트 콘솔/네트워크는 dev 창에서 우클릭 → 검사(웹뷰 devtools)로 확인. `imgsrv://.../thumb?...` 요청을
  관찰하면 프로토콜 평면이 눈에 들어옵니다.

---

## 9. 패키징 상태 점검 ✅

**결론: 패키징은 갖춰져 있습니다.** 확인된 항목:

| 항목 | 상태 | 근거 |
|------|------|------|
| 번들 활성화 | ✅ | `tauri.conf.json` → `bundle.active: true`, `targets: "all"` |
| 앱 메타데이터 | ✅ | `productName`, `version 0.1.0`, `identifier com.glasspane.app`, 카테고리/설명/publisher/homepage |
| 아이콘 세트 | ✅ | `src-tauri/icons/`에 `32x32.png`, `128x128(@2x).png`, `icon.icns`(mac), `icon.ico`(win), Windows Store 로고들 |
| Linux 런타임 의존성 | ✅ | `bundle.linux.deb.depends`: `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libdav1d7` |
| 릴리스 자동화 | ✅ | `.github/workflows/release.yml` — `v*` 태그/수동 트리거 시 **mac(ARM+Intel)·Linux(24.04)·Windows** 매트릭스로 `tauri-action`이 빌드하고 **draft 릴리스**에 첨부 |
| PR 게이팅 CI | ✅ | `.github/workflows/ci.yml` — PR/푸시마다 프론트 빌드 + `fmt`/`clippy -D warnings` (이번에 추가) |
| 릴리스 빌드 검증 | ✅ | 과거 `tauri build --no-bundle` 성공(18M 바이너리) 확인 — CLAUDE.md §4 |

### 직접 패키징 해보기
```bash
# 현재 OS용 설치 패키지(.deb/.AppImage, .dmg, .msi 등) 생성
npm run tauri build

# 번들 없이 릴리스 바이너리만 (빠른 확인용)
npm run tauri build -- --no-bundle
```
산출물은 `src-tauri/target/release/bundle/` 아래에 생깁니다.

### 릴리스 배포(태그 푸시)
`release.yml`은 버전 태그에 반응합니다:
```bash
git tag v0.1.0 && git push origin v0.1.0
```
→ 4개 타깃이 빌드되어 GitHub의 **draft 릴리스**에 아티팩트로 붙습니다(수동 게시 전 검토 가능).

### 남은(선택) 개선거리
- macOS **코드사이닝/공증**, Windows **인증서 서명** — 미설정(개인용이라 보통 생략 가능, 배포 시 경고만).
- `tauri-action`의 `releaseDraft: true` → 자동 게시로 바꿀지 여부는 취향.
- (로드맵) 썸네일을 `asset:` 프로토콜로도 서빙하는 대안 — CLAUDE.md §11.

---

## 10. 엔드투엔드 흐름 따라가기 — "폴더 클릭 → 썸네일이 뜬다"

개념을 따로 외우기보다 **하나의 동작이 두 평면을 가로지르는 경로**를 추적하면 전체 그림이 한 번에 들어옵니다.

```
[사용자가 트리에서 폴더 클릭]
        │  (프론트, App.tsx)
        ▼
1) listDir(path)  ──invoke("list_dir")──▶  Rust list_dir()         [데이터 평면]
        │                                      │  fs::read_dir + 정렬
        ◀───────────  Vec<DirEntry> (JSON) ─────┘
        │  kind === "image"만 필터 → ImgRef[]로 매핑 → setNodeItems(...)
        ▼
2) 그리드 재계산 (App.tsx:476-484)
        cols = floor((뷰포트너비 - GAP) / (tile + GAP))
        firstRow/visibleRows로 보이는 행만 slice  ← 수동 가상화
        ▼
3) 보이는 타일마다 <Tile> → <img src={thumbUrl(item, thumbW)} loading="lazy">
        │  thumbUrl()이 imgsrv://localhost/thumb?path=...&w=256 생성
        ▼  (브라우저가 이미지 요청 발사)
4) Rust 프로토콜 핸들러                                              [이미지 평면]
        register_imgsrv → 워커 스레드 → handle_request → "/thumb" → serve_thumb
        │  cache_key로 디스크 캐시 조회
        │   ├─ 히트: 캐시된 JPEG 즉시 반환 (디코드 없음, permit 불필요)
        │   └─ 미스: decode_sem().acquire() → read_source_bytes → make_thumb
        │            (이미지 디코드 → thumbnail 리사이즈 → JPEG 인코드) → 캐시에 기록
        ◀───────────  JPEG 바이트 (HTTP 200) ──────────┘
        ▼
5) <img> onLoad 발화 → loadedRef.add(id) + bumpLoad()  (App.tsx:734-736)
        → opacity 0→1 페이드인 (.28s)  → 스켈레톤 위로 부드럽게 등장
```

스크롤하면 2)~5)가 **보이는 행에 대해서만** 반복됩니다. 이미 본 타일은 `loadedRef`에 기록돼 있어
다시 그려질 때 즉시 표시(페이드인 생략)되고, 디스크 캐시 + 브라우저 캐시 덕에 재요청도 거의 공짜입니다.

> 이 한 장의 흐름에 **invoke 평면 · 커스텀 프로토콜 평면 · 가상화 · 캐시 · 동시성 제한**이 전부 등장합니다.
> 막히는 개념이 생기면 위 번호로 돌아와 해당 단계의 코드를 열어보세요.

---

## 11. 프론트엔드 깊게 보기 — 수동 가상화와 썸네일 로딩 (`App.tsx`)

CLAUDE.md의 방침은 **무거운 그리드 라이브러리를 쓰지 않고 직접 가상화**하는 것입니다. 핵심은 의외로 짧습니다.

### 11.1 수동 가상화 (App.tsx:476-484)
```ts
const cols = Math.max(1, Math.floor((viewport.w - GAP) / (tile + GAP)));  // 너비로 열 수 계산
const rows = Math.ceil(items.length / cols);
const totalH = rows * (cellH + GAP) + GAP;                                // 전체 높이(스페이서)

const firstRow     = Math.max(0, Math.floor(scrollTop / (cellH + GAP)) - OVERSCAN_ROWS);
const visibleRows  = Math.ceil(viewport.h / (cellH + GAP)) + OVERSCAN_ROWS * 2;
const firstIdx     = firstRow * cols;
const lastIdx      = Math.min(items.length, (firstRow + visibleRows) * cols);
const visible      = items.slice(firstIdx, lastIdx);                      // 보이는 것 + 약간의 오버스캔만
```
- 컨테이너는 `height: totalH`인 **스페이서 div** 하나(App.tsx:713). 그 안에서 타일을 **절대 위치**로 배치:
  ```ts
  left: GAP + col * (tile + GAP),
  top:  GAP + row * (cellH + GAP),
  ```
- 그래서 항목이 수천 개라도 **실제 DOM에는 보이는 행(+오버스캔)만** 존재 → 스크롤이 매끄럽습니다.
- `scrollTop`은 `onScroll`로 state에 반영(App.tsx:698)되어 위 계산이 다시 돌고, 보이는 슬라이스가 갱신됩니다.

**학습 포인트**: 가상화의 본질은 "전체 크기만큼 자리를 잡아두고(스페이서), 보이는 것만 그린다"입니다.
react-window 같은 라이브러리도 내부적으로 같은 일을 합니다.

### 11.2 썸네일 페이드인 + `loadedRef` (App.tsx:233, 726, 734, 1124-1136)
```tsx
<img
  src={thumbUrl(item, thumbW)}
  loading="lazy" decoding="async"     // 브라우저에게 지연/비동기 디코드 위임
  onLoad={p.onLoaded}                 // 성공 → loadedRef.add(id) + 리렌더
  onError={p.onBroken}                // 실패 → brokenRef.add(id) → 깨진-이미지 플레이스홀더
  style={{ opacity: loaded ? 1 : 0, transition: "opacity .28s ease", /* ... */ }}
/>
```
- `loadedRef`는 **`useRef<Set<string>>`** (state가 아님). 로드 여부는 렌더 사이에 보존돼야 하지만,
  매 추가마다 리렌더를 유발하면 비효율적이라 `ref`에 담고 `bumpLoad()`로 **한 번만** 리렌더를 깨웁니다.
  → "리렌더가 필요 없는 가변 값은 `ref`, UI에 반영돼야 하는 값은 `state`"라는 React 관용구의 좋은 예.
- 노드를 바꾸면 `loadedRef.current = new Set()`로 초기화(App.tsx:316)하고 스크롤도 0으로(318).

### 11.3 키보드 내비게이션 (App.tsx:498-511)
- 뷰어가 열려 있을 때 `window`에 `keydown` 리스너를 달아 `←/→/Home/End/Esc`를 처리하고,
  effect의 **클린업**에서 `removeEventListener`로 정리합니다(리스너 누수 방지 — React effect의 정석).
- 줌 키(`+`/`-`/`0`)는 `Viewer` 컴포넌트 내부에서 별도 리스너로 처리(역할 분리). 휠 줌은 `preventDefault`가
  필요해 **네이티브 비-passive 리스너**를 ref로 직접 부착합니다.

---

## 12. Rust 심화

### 12.1 소유권 · 빌림 · 라이프타임 (이 코드에서)
- **빌림(`&`)으로 소유권 보존**: `serve_thumb(app, &src, w)` — `src`를 빌려주므로 호출 후에도 `src`를 계속 씀.
- **`move` 클로저로 소유권 이동**: `thread::spawn(move || { ... app ... })` — 스레드는 부모보다 오래 살 수 있어
  값을 **소유**해야 함. 그래서 `app`을 `clone()`해 넘김.
- **라이프타임 `'a`**: `struct Permit<'a>(&'a Semaphore)` — 허가 토큰이 빌린 세마포어보다 오래 살 수 없음을
  타입으로 못 박음. 덕분에 "이미 사라진 세마포어에 반납" 같은 버그가 **컴파일 단계에서** 불가능.
- **문자열 두 종류**: `&str`(빌린 뷰) vs `String`(소유). `ext_of(name: &str) -> String`처럼 입력은 싸게 빌리고
  필요할 때만 소유 문자열을 만듭니다. `as_deref()`(`Option<String>`→`Option<&str>`), `to_string_lossy().into_owned()`
  (OS 문자열→소유 `String`) 같은 변환도 같이 봐 두면 좋습니다.

### 12.2 에러 처리 관용구
- `Result<T, String>`를 명령 반환형으로 쓰면 `Err`가 프론트의 `Promise` reject로 전달돼 `try/catch`로 잡힙니다.
- `?` 연산자는 "에러면 즉시 반환, 아니면 언랩". `map_err(|e| e.to_string())?`가 거의 모든 곳의 패턴.
- `convert_images`는 **부분 실패 모델**: 개별 파일 실패를 `report.failed`에 모으고 전체는 `Ok`로 반환 →
  "한 장 깨졌다고 배치 전체를 죽이지 않기". 에러 설계의 좋은 예시입니다.

**`Option`/`Result` 콤비네이터 빠른 표** (코드에 다 등장):

| 메서드 | 의미 | 코드 예 |
|--------|------|---------|
| `.map(f)` | 값이 있으면 변환 | `entry.metadata().map(meta_size_mtime)` |
| `.and_then(f)` | 변환 결과가 또 `Option/Result` | `.and_then(\|e\| e.to_str())` |
| `.unwrap_or(d)` | 없으면 기본값 | `.unwrap_or((0, 0))` |
| `.ok()` | `Result`→`Option` | `.modified().ok()` |
| `.map_err(f)` | 에러를 변환 | `.map_err(\|e\| e.to_string())` |
| `?` | 에러 전파 | `fs::read_dir(&path)?` |

### 12.3 `image` 크레이트 디코드 파이프라인 (`make_thumb`)
```rust
let img = ImageReader::new(Cursor::new(bytes))   // 메모리 바이트를 읽기 소스로
    .with_guessed_format()?                       // 매직 바이트로 포맷 추론(확장자 불신)
    .decode()?;                                   // DynamicImage로 디코드
let thumb = img.thumbnail(w, w);                  // 종횡비 유지하며 w×w 안에 맞춤
encode_jpeg(thumb)                                // RGB로 낮춰 JPEG 인코드(알파 제거)
```
- WebP는 순수 Rust, **AVIF는 `avif-native` 피처(libdav1d)** 로 디코드(§8.1). 피처를 빼면 AVIF만 폴백.
- `/full` 경로는 webview가 직접 못 그리는 포맷(AVIF 등)만 `transcode_jpeg`로 변환하고, JPEG/PNG/WebP 등은
  **원본 바이트를 그대로** 흘려보냅니다(`passthrough_content_type`).

---

## 13. Tauri 심화

### 13.1 IPC는 실제로 어떻게 도나
- `invoke("list_dir", { path })` → Tauri가 메시지를 코어로 전달 → `generate_handler!`가 만든 라우터가
  `list_dir`를 찾아 인자를 **역직렬화**(serde) → 함수 실행 → 반환값을 **직렬화**해 프론트 `Promise`로 resolve.
- 그래서 **인자/반환 타입은 `Serialize`/`Deserialize`여야** 하고, Rust↔JS 필드명은
  serde `rename_all` 또는 Tauri의 자동 case 변환으로 맞춥니다.
- **커스텀 프로토콜은 이 직렬화 파이프라인을 우회**합니다. 바이트를 JSON에 담지 않고 HTTP 응답처럼
  스트리밍하므로 대용량 이미지에 적합 — 이게 두 평면을 나눈 이유의 핵심입니다.

### 13.2 capability(권한) 모델
- Tauri 2는 **명시적 권한**을 요구합니다. `capabilities/default.json`의 `permissions`에 없는 플러그인 명령은
  프론트에서 호출해도 거부됩니다. dialog 플러그인을 쓰려면 `"dialog:allow-open"`이 있어야 합니다.
- 반면 **우리가 `generate_handler!`로 등록한 앱 명령**(list_dir 등)은 권한 항목이 필요 없습니다.
- 사고방식: "프론트(신뢰 못 함)가 네이티브 능력에 접근하려면, 그 능력이 capability로 *허가*되어 있어야 한다."

### 13.3 dev vs build 파이프라인
- `npm run tauri dev`: `beforeDevCommand`(Vite dev 서버) + Rust 디버그 빌드 → `devUrl`을 가리키는 창.
  프론트 핫리로드, Rust 변경 시 재빌드.
- `npm run tauri build`: `beforeBuildCommand`(= `npm run build`, 정적 `dist/` 생성) + Rust **릴리스** 빌드 +
  번들러가 OS별 설치 패키지 생성. `frontendDist: "../dist"`가 그 정적 산출물을 가리킵니다.
- 즉 **프로덕션 빌드는 로컬 서버 없이** 번들된 정적 자산을 webview가 로드합니다(개발 때만 Vite 서버 사용).

---

## 14. 함정 모음 (실제로 부딪히는 것들)

CLAUDE.md §10 + 이 저장소에서 **직접 겪은** 사례를 묶었습니다.

1. **CSP에 `imgsrv` 누락 → 이미지가 *조용히* 안 뜸.** 에러도 거의 없이 빈 칸만 보입니다.
   `img-src`에 스킴을 넣었는지 가장 먼저 의심하세요.
2. **프로토콜 origin이 플랫폼마다 다름.** Windows는 `http://imgsrv.localhost`, 그 외는 `imgsrv://localhost`.
   `viewerApi.ts`가 UA로 분기 — 하드코딩 금지.
3. **libdav1d 버전.** AVIF는 dav1d **≥ 1.3.0** 필요. **Ubuntu 22.04(0.9.2)에선 빌드 실패**, 24.04(1.4.x)는 OK.
   ← *우리 CI 1차 실패의 실제 원인.* 러너를 24.04로 올려 해결.
4. **clippy 버전 차이.** CI의 최신 stable clippy가 로컬(구버전)이 못 잡은 린트를 잡아 `-D warnings`로 실패할 수 있음.
   ← *우리 CI 2차 실패(`unnecessary_sort_by`).* `rustup update stable`로 로컬을 맞추면 동일해집니다.
5. **base64로 이미지 invoke 금지.** 메모리/IPC 폭발. 반드시 커스텀 프로토콜로.
6. **큰 디렉터리에서 메타데이터 일괄 조회 금지.** 가상화 + lazy `<img>`로 *보이는 것만* 디코드하도록.
7. **스레드 폭주 주의.** 프로토콜 핸들러는 요청마다 스레드를 띄움 → 동시 디코드는 세마포어로 캡(§4).

---

## 15. 용어집

| 용어 | 뜻 |
|------|----|
| **invoke** | 프론트가 Rust 명령을 호출하는 IPC. JSON 직렬화, 요청→단일 응답. |
| **custom (URI scheme) protocol** | `imgsrv://`처럼 직접 등록한 스킴. 바이트를 HTTP 응답처럼 스트리밍. |
| **Channel** | 한 invoke 호출 동안 Rust→프론트로 **여러 번** 메시지를 흘리는 통로(진행률 등). |
| **capability / permission** | 프론트가 쓸 수 있는 (플러그인) 명령을 허가하는 Tauri 2 보안 모델. |
| **CSP** | Content-Security-Policy. webview가 로드 가능한 출처/스킴을 제한. |
| **AppHandle** | 앱 전역 핸들. 경로 API(`app_cache_dir`), 이벤트 등 코어 기능 접근점. |
| **virtualization(가상화)** | 보이는 항목만 DOM에 그려 대량 리스트를 가볍게 유지하는 기법. |
| **overscan** | 뷰포트 밖이지만 미리 그려두는 여분 행(스크롤 시 깜빡임 방지). |
| **RAII / `Drop`** | 자원을 값의 수명에 묶어, 스코프 종료 시 자동 정리(여기선 세마포어 허가 반납). |
| **`OnceLock`** | 스레드 안전 1회 초기화. 전역 싱글턴 지연 생성에 사용. |
| **passthrough** | 디코드/변환 없이 원본 바이트를 그대로 전달(webview-safe 포맷). |
| **transcode** | webview가 못 그리는 포맷(AVIF 등)을 JPEG로 재인코드해 전달. |

---

### 한 줄 요약
- **데이터는 invoke(JSON), 이미지는 커스텀 프로토콜(바이트 스트림)** — 이 분리가 Tauri 설계의 정수(§0, §10).
- **프론트는 수동 가상화 + `ref` 캐시(loadedRef)** 로 수천 장도 매끄럽게(§11).
- Rust 핵심(`Result`+`?`, 소유권/빌림/라이프타임, 트레잇/`Drop`, `Mutex`/`Condvar`/`OnceLock` 동시성)이 이 한 앱에 다 들어있음(§4, §12).
- 실행은 `npm run tauri dev`, 검증은 `npm run build` + `cargo fmt/clippy/check`, 패키징은 이미 완비(`tauri build` / 태그 푸시)(§8, §9).
- 막히면 §10 흐름도로 돌아가 해당 단계 코드를 열고, 이상하면 §14 함정부터 의심.
