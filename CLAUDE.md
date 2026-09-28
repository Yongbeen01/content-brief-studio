# content-brief-studio

브랜드 자료·소구점·컨셉을 받아 TikTok 크리에이터용 영상 컨텐츠 가이드(기획서)를 만들고,
미리보기에서 프롬프트로 다듬은 뒤 노션 `Contents Guidline` 아래에 새 페이지로 올리는 **로컬 도구**.

## 규칙

- 답변·주석·커밋 메시지 설명은 한국어. 코드·식별자는 그대로.
- **공개 레포다.** 시크릿(노션 client secret·토큰, 팀 설정 코드)은 레포에 절대 넣지 않는다.
  전부 `~/.content-brief-studio/` 에만 있다. 테스트 `test/no-secrets.test.js` 가 패턴을 검사한다.
- **npm 의존성 0.** `node:` 내장 모듈만 쓴다. 마크다운 파서는 `web/vendor/markdown-it.min.js` 를 벤더링해
  브라우저·서버가 같은 파일을 쓴다(미리보기와 노션 변환이 어긋나지 않게).
- **main 에 push = 팀 배포.** 설치본은 30분마다 git 으로 스스로 업데이트한다.
  push 전에 `npm test` 통과와 실화면 확인을 끝내고, 사용자 확인을 받는다.

## 사본이 두 개다

| | 개발 | 실제 사용(설치본) |
| --- | --- | --- |
| 위치 | `Documents\content-brief-studio` | `%LOCALAPPDATA%\content-brief-studio` (설치 스크립트가 clone) |
| 포트 | `CBS_PORT=4326` 으로 띄울 것 | 4325 (기본) |

개발 폴더에서 기본 포트로 띄우면 설치본과 부딪힌다. 노션 OAuth 리디렉션 URI 는 4325 기준이라
OAuth 연결 자체를 확인할 때만 설치본을 멈추고 4325 로 띄운다.

## 노션 쓰기 안전장치

- `src/notion/client.js` 의 쓰기 가드가 **설정된 부모 아래 새 페이지 만들기**와 **이번 게시에서 만든 블록에
  이어 붙이기·보관(롤백)** 만 허락한다. 기존 페이지는 구조적으로 못 건드린다. 가드를 느슨하게 만들지 말 것.
- 개발·테스트 게시는 반드시 샌드박스 부모로: `CBS_NOTION_PARENT=<샌드박스 페이지 id>`.
  기본 부모(Contents Guidline)는 팀 공용 페이지다.
- 원본 템플릿 페이지(`[CLERIVY]US_TikTok_Microdart …`)는 읽기 전용 참고 자료다. 도구는 실행 중에 접근하지 않는다.

## 인코딩 규칙 (Windows)

- `scripts/*.bat` 은 ASCII 만, CRLF. 인터넷에서 받은 .bat 은 Zone.Identifier 를 지우는 줄이 있어야 PowerShell 을 띄운다.
- `scripts/install.ps1` 은 **BOM 없이**(irm | iex 가 BOM 을 명령으로 읽는다).
- `-File` 로 실행하는 `.ps1`(launch, install-shortcut)은 **UTF-8 BOM 필수**(PowerShell 5.1 이 한글을 깨뜨린다).
- `claude` 에 넘기는 경로는 슬래시로, argv 에 줄바꿈 금지(시스템 프롬프트는 파일로).

## 구조

- `docs/brief-template-guide.md` — 템플릿 구성·톤앤매너 지침. **프롬프트가 이 파일을 그대로 읽는다.**
- **언어**: 초안·미리보기는 한국어, 노션에 올릴 때 영어. 고정 문구(섹션 제목·소제목·표 항목 이름·표준 Don't)는
  `web/js/chrome.js` 가 두 벌로 들고 있어 옮기기를 거치지 않는다. 내용만 자리별로 뽑아(`web/js/translatable.js`,
  화면·서버 공용) `src/brief/translate.js` 가 Claude 에게 보내고 같은 순서로 받아 되꽂는다. 해시태그·계정 태그는 그대로 둔다(`AS_IS_ROWS`).
  - **생성할 때 영어본까지 만든다**(마지막 단계). 옮긴 줄은 초안의 `enCache`(「종류|한국어」 → 영어)에 남아,
    [영어로 보기]는 캐시로 되면 요청 없이 바로, 모자라면 **없는 줄만** 보낸다. 묶음(45줄)은 동시에 보낸다.
  - 영어 문서(`doc.lang === 'en'` — 불러온 영어 브리프·옮긴 영어본)는 **한글이 든 줄만** 옮긴다.
- **고정 문구 고치기**: 그릴 때 붙는 문구(스텝 소제목·표 항목 이름·금지 표현 표 제목/머리)는 사람이 고치면 그 노드의
  `labels[key]`, 모든 스텝에 똑같이면 문서의 `labels[key]` 에 든다(`doc.js labelText`). 정해진 문구와 같아지면 지운다.
  스텝 제목 줄에서 「Step N」 을 지우면 `step.heading`(그 줄 그대로, 번호 자동 아님). 고친 문구는 옮기기 대상이다.
  표의 줄 정체는 `rowChrome` 이 계속 들고 있다 — 이름을 바꿔도 검사·옮기기 문체가 안 깨진다.
- **기존 브리프 불러오기**(`src/brief/import.js`): 노션 링크는 공개 페이지(`/api/v3`, 토큰 없음)로 먼저, 안 되면 공식 API 로
  읽어 간단한 블록 나무로(`src/sources/notion-blocks.js`) → 우리 문서로. PDF 는 Claude(sonnet)가 정해진 마크업으로
  옮겨 적고(`src/brief/import-pdf.js`) 같은 나무로. 링크 주소(/URI)와 사진(쪽마다 그리는 순서)은 코드가 PDF 에서 꺼내
  목록으로 준다 — Claude 는 `image:N` 번호만 적는다.
  - **글자 그대로**가 목표다. 스텝·Dos/Don'ts·한눈에 보기 표·금지 표현은 알아보면 칸별로, 아니면 일반 블록으로 둔다(억지로 맞추지 않는다).
    원본 소제목·항목 이름이 우리 문구와 다르면 labels 로 살린다. 모든 스텝이 같으면 문서 labels 로 올린다.
  - 원본에 사진이 없던 자리는 `optional` — 비워 두면 노션에 회색 이미지를 만들지 않는다. Dos 사진이 줄 위면 `imagesFirst`.
  - 글을 먼저 `job.data.doc` 로 내보내고 사진은 받는 대로 `job.data.assets` 에 더한다(작업 중간 결과 — `jobs.js`).
    공개 페이지 사진은 `getSignedFileUrls` 로 서명해 원본(움직이는 GIF)을 받는다.
  - 불러온 문서는 `origin: 'import'` — 폼의 Account ID 가 Account Tag 를 덮지 않는다.
- `src/claude/` — Claude CLI 호출(구독 로그인, stream-json, --json-schema), JSON 추출.
- `src/sources/` — 사측 공유 파일 읽기(docx·pptx·xlsx 는 의존성 없는 ZIP/XML 파서, PDF 는 Claude 가 직접 읽음, 노션 링크).
  사진도 같이 꺼낸다: `images.js`(추려내기)·`pdf-images.js`(PDF 안의 사진 객체 → JPEG 그대로 / PNG 로 다시 포장,
  투명도 `/SMask` 를 같이 넣지 않으면 오려낸 제품 컷 배경이 검게 나온다)·`imagemeta.js`(크기).
- `src/brief/` — 작성·보정·문서 트리·편집/추가. 제품 사진은 `product-image.js` 에서 **Claude 가 후보를 보고** 고른다
  (제일 큰 사진을 넣으면 십중팔구 배경 그라데이션이다). 글쓰기와 같이 돌려 기다림이 겹치지 않게 한다.
- 고치는 길이 둘이다: 글자만 있는 자리는 `web/js/direct.js` 가 Claude 없이 바로(무엇을 직접 고칠 수 있는지는
  그 파일에만 있다), 여러 조각이 얽힌 자리는 `src/brief/edit.js` 가 프롬프트로. 둘의 대상 판단은 짝이 맞아야 한다.
- `src/media/`·`src/video/` — 스텝 참고 GIF: 영상에서 구간을 찾아 잘라 넣는다.
  도구(ffmpeg·whisper.cpp)는 **앱이 내려받아** `~/.content-brief-studio/tools/` 에 둔다(레포·npm 에는 넣지 않는다).
  1초에 한 장씩 뽑아 **12장을 격자 한 장**으로 합치는 게 비용의 핵심이다 — 낱장을 읽히면 왕복마다 대화가 다시 올라가
  몇 배가 된다. 화면 설명은 **영상당 한 번**(haiku) 만들어 `frames.json` 에 남기고, 구간 고르기는 **GIF 하나당 한 번**(opus).
  돌려받은 구간은 코드가 다시 다듬는다(길이 3~10초·영상 범위·겹침). 실측: 2분 영상 준비 42초, 구간 고르기 7초.
  화면(`web/js/video.js`): 진행은 **회색 상자 안에서** 보이고 창은 구간 고를 때만 뜬다. 올리기는 상자마다 동시에,
  Claude 처리는 올린 순서대로 한 줄(큐)로. 패널은 상자 내용을 **덮기만** 한다 — 지우고 그리면 패널이 빠질 때
  넣은 GIF 가 돌아오지 않는다. 문서를 다시 그릴 때마다 `paint()` 를 불러 상태를 되살린다.
  자리는 노드 id 로 다시 찾는다(작업 중에 스텝이 밀릴 수 있다), 같은 영상은 바이트가 같으면 하나로 친다.
  한 자리에 **영상을 여러 개** 올릴 수 있다. 구간 고르기는 한 번에 두 가지를 받는다 — 한 구간짜리 후보 3개와,
  한 구간으로 안 담길 때 쓰는 **이어 붙이기**(조각 2~4개, 서로 다른 영상에서 와도 된다). 이어 붙이기는
  조각마다 크기·fps 를 맞춘 뒤 concat 한다(`media/ffmpeg.js` 의 `stitch`) — 필터 하나로 묶으면 크기가
  다른 영상에서 조용히 깨진다. 길이는 조각 1.5~6초·전체 12초까지로 코드가 자른다.
- `src/notion/` — OAuth(파이널 리포트 공개 통합 재사용), 쓰기 가드, 블록 변환, 게시.
- `web/` — Final Report 플러그인과 같은 모양의 화면(빌드 없음).
- 데이터: `~/.content-brief-studio/` (`CBS_DIR` 로 바꿀 수 있음).

## 검증

- `npm test` — 단위 테스트(Claude·노션 호출 없음).
- 실화면: standalone Playwright 하니스(`C:\Users\GUHADA\pw-verify\`)로 폼 → 생성 → 편집 → 게시(샌드박스)까지.
