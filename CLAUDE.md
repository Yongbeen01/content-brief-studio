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
- 바로가기 아이콘은 `scripts/app.ico`(파란 바탕 클래퍼보드, 16~256px PNG 를 담은 ico — `*.ico binary`). 예전 설치본 바로가기는
  윈도우 기본 아이콘(`shell32.dll,70`, 노트 모양)이라 `launch.ps1` 이 켤 때마다 **이 사본을 가리키는 바로가기만** 앱 아이콘으로 맞춘다.
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
  - **2026-10-16 고친 것**(현업 테스트에서 나온 넷):
    - PDF 사진 목록은 **그린 자리마다** 하나(`pdfImageList` — 같은 GIF 를 두 스텝에 쓰면 PDF 는 사진 하나를 두 번 그린다. 예전엔 하나로 세서
      목록이 그림보다 짧았고, Claude 가 다음 번호를 앞당겨 「다음 GIF 가 위로 오고 그 자리 GIF 는 빠짐」). Claude 가 같은 번호를 두 자리에 적으면
      `repairImageNumbers` 가 앞뒤 번호 사이의 안 쓴 번호로 바로잡고(없으면 0 = 회색 자리) 경고한다.
    - 불러올 사진 상한 20MB → **100MB**(`notion-blocks.js MAX_IMAGE_BYTES` — 실제 브리프 GIF 가 20~40MB 라 회색으로 남고 노션에도 회색으로 올라갔다).
      공식 API 가 파일 주소를 안 주는 사진(`image` 에 caption 만)은 빈 자리가 아니라 회색 자리 + 경고(예전엔 노션에 아예 안 올라갔다).
    - 노션 게시: 칸 나누기는 칸을 나눠 보내지 않는다(`publish.js splitForRequest` — 칸 하나짜리를 보내 「column_list ≥ 2」 400 으로 게시가 통째로 실패).
      칸은 전부 보내고 칸 안 블록의 자식만 떼었다가 `listChildren` 으로 id 를 얻어 붙인다(쓰기 가드는 만든 블록의 자식 id 를 읽을 때 기억한다).
    - 불러오기도 **아카이브에 남는다**(아래 「아카이브」).
  - **글자 그대로, 놓인 자리 그대로**가 목표다. 스텝·Dos/Don'ts·한눈에 보기 표·금지 표현은 알아보면 칸별로, 아니면 일반 블록으로
    둔다(억지로 맞추지 않는다). 원본 소제목·항목 이름이 우리 문구와 다르면 labels 로 살린다(색·굵기째 — 「💬 Mandatory Subtitle」 의
    빨간 글자). 모든 스텝이 같으면 문서 labels 로 올린다.
  - **칸 나누기는 칸 그대로**(2026-10-01) — 문서 노드 `columns`(`{ columns: Node[][], ratios? }`). 예전엔 펴서 위아래로 늘어놓아
    「사진 왼쪽·글 오른쪽」이 「사진 아래 글」이 됐다. 글이 남는 칸이 하나뿐이면 편다. 칸 안은 박스 안처럼 글 블록을 넣을 수 있고
    (`doc.js childLists` — 문서를 끝까지 훑는 곳은 이걸 쓴다), 노션에는 column_list 로 올라간다(API 가 칸 비율은 안 받는다).
    1️⃣ 섹션의 첫 사진은 칸 안에 있어도 제품 사진.
  - **서식**: 마크다운에 없는 부분 색·밑줄은 서식 태그 `<span color="red">`·`<u>`(`web/js/inline.js`). `**` 가 앞뒤 문장부호 때문에
    안 먹는 자리(`**"quote"**word`)는 `<b>`·`<i>`·`<s>` 로 다시 쓴다 — 예전엔 그 줄의 서식을 통째로 버렸다. 원문에 태그처럼 생긴
    글자는 `escapeMd` 가 `\<` 로 막는다. 같은 모양 조각은 붙인다(노션은 같은 굵은 글을 두 조각으로 주기도 한다 → `**a****b**` 로 깨졌다).
    글 전체가 한 글자색이면 예전처럼 블록 색, 바탕색(형광펜)은 늘 태그. 박스 제목 줄의 글자색은 `textColor`.
  - 들여쓴 하위 목록은 `levels`(줄마다 깊이), 노션에서 줄여 둔 사진은 `width`(px, 본문 708px 기준)·`align` — 미리보기만 따른다.
    목록 줄 수가 바뀌면 `fixup` 이 levels 를 버린다(엉뚱한 줄이 들어가지 않게). 미리보기 굵게는 노션처럼 600(제목 안이 900 이 됐었다).
  - 원본에 사진이 없던 자리는 `optional` — 비워 두면 노션에 회색 이미지를 만들지 않는다. Dos 사진이 줄 위면 `imagesFirst`.
  - **Do's/Don'ts 예시 사진은 두 모양**(`doc.js syncGrid`): 새로 만든 기획서는 `perItem` — 항목마다 하나, **번호 아래**(사진은
    `item.image` 가 들고 있어 항목을 넣고 빼도 같이 움직인다, 정사각형). 불러온 브리프는 노션 원본처럼 두 항목(한 줄)마다 하나(`grid.images`).
    예전에 만든 초안은 열 때(`main.js useDraft` → `upgradeGrids`) 항목마다로 바뀌고, 그 줄에 넣어 둔 사진은 그 줄 첫 항목으로 간다(2026-10-06).
    항목 글을 고칠 때(한 자리 편집·직접 고치기) 그 항목의 사진은 남긴다.
  - 글을 먼저 `job.data.doc` 로 내보내고 사진은 받는 대로 `job.data.assets` 에 더한다(작업 중간 결과 — `jobs.js`).
    공개 페이지 사진은 `getSignedFileUrls` 로 서명해 원본(움직이는 GIF)을 받는다.
  - 불러온 문서는 `origin: 'import'` — 폼의 Account ID 가 Account Tag 를 덮지 않는다.
  - **사진 자리**(2026-10-01): 제품 사진은 사진만 올리고, 그 밖의 모든 자리(스텝·일반 사진·Do's 예시·칸 안)는 스텝 GIF 와 같은
    상자([레퍼런스 검색]·[영상으로 자동 생성]·[GIF 업로드], `preview.js isVideoSlot`). 스텝이 아닌 자리는 **그 사진의 장면 글**로 찾는다
    (`doc.js slotScene` — 화면·구간 고르기 `match.js stepSummary`·검색어 `reference.js stepForSearch` 가 같이 쓴다):
    칸 안이면 옆 칸 글 + 같은 칸 아래 글, 아니면 아래로 다음 사진(·스텝·큰 제목) 전까지, Do's 예시는 그 줄의 두 항목,
    옆·아래가 비면 위 안내 글을 쓰고 그 위가 스텝이면 그 스텝(「[Please attach this image]」 처럼 스텝 뒤에 붙은 사진).
    틱톡 다운로더는 스텝 번호가 0 이면 [Step N GIF 생성]을 안 띄워서, 스텝이 아닌 자리는 가까운 앞 스텝 번호(없으면 몇 번째 사진)를
    넘긴다 — 어느 자리로 갈지는 번호가 아니라 slotId 가 정한다. 하니스 `pw-verify/cbs-import-slots.mjs`(실제 Claude, 14항목),
    배치 비교 `cbs-notion-shot.mjs`(노션 원본) ↔ `cbs-layout-shot.mjs`(불러온 미리보기).
- **전체 수정**(`src/brief/revise.js`, 화면은 [불러오기] 아래 `#revise_section` — 업로드 탭 + `origin: 'import'` + 불러오기가 끝난 뒤에만 보인다):
  지시 하나로 문서 전체에서 필요한 곳만 고친다. **문서를 통째로 다시 받지 않는다** — 고칠 수 있는 자리마다 번호(P1…)·위치·지금 값을
  보여 주고(`listParts`·`outline`), Claude(opus)는 바꿀 자리만 `edits`·`inserts`·`moves`·`deletes` 로 돌려준다. 목록에 없는 자리는
  글자 그대로다(불러온 브리프는 원문 그대로가 목표 — 통째로 다시 쓰게 하면 안 건드린 곳까지 슬쩍 바뀐다).
  - 자리 하나를 고치는 방법은 한 자리 편집(`edit.js resolveTarget`)을 그대로 쓴다. 스텝은 머리(제목·HOOK·⭐)와 칸(⏱·Action…)을
    따로, 한눈에 보기 표는 줄마다(줄 이름이 고정 문구라), 박스·Do's 는 안의 자리마다. 사진·임베드·구분선은 옮기기·지우기만.
    값 모양은 `schema.js REVISE_VALUE`(불러온 브리프에 맞게 한 자리 편집보다 너그럽다 — Subtitle 없는 스텝, 넓은 표).
  - 고치기는 원래 경로로 먼저(구조가 안 바뀐다), 옮기기·넣기·지우기는 처음에 집어 둔 **객체**로 자리를 찾는다(앞에서 지우면 번호가 밀려서).
  - 자리가 틀린 답은 이유를 붙여 한 번 다시 묻고, 그래도 틀린 것은 빼고 맞는 것만 반영한 뒤 알린다. 지금 값과 같은 고치기는 뺀다.
  - 결과는 되돌리기 한 번으로 통째로 돌아간다(`state.reviseLast` — 그 기록까지 되돌리면 안내를 지우고 지시문을 칸에 돌려놓는다).
    바뀐 자리는 `changed`(새 문서 경로)로 받아 반짝인다. 실측(ILLIYOON 6스텝): 순서·자막·박스 한 줄 24초, 내레이션 전부 12초.
    하니스 `pw-verify/cbs-revise-real.mjs <노션 링크>`(실제 Claude, CBS_PORT=4326).
- **아카이브**(`src/archive.js`): [생성]이 끝나는 순간 **서버가** 그때 입력 + 결과를 한 건씩 남긴다(창을 닫아도 남는다).
  `archive/<id>.json` + 목록용 `index.json`. 기록은 고치지 않는다 — 열면 화면이 `draftId` 초안을 열어 이어서 고친다
  (그 초안이 없거나 다른 생성으로 넘어갔으면 기록으로 새 초안을 만들고 연결을 바꾼다). 초안의 `generation` 이 어느 기록에서
  왔는지 들고 있고, 이미 기획서가 있는 초안에서 다시 생성하면 **새 초안으로 갈라진다**(`main.js forkDraft`).
  기록을 열면 폼은 늘 그 생성 때 입력으로 돌린다. 기록이 쓰는 사측 공유 파일은 폼에서 지워도 파일을 남긴다(`DELETE /api/sources`).
  **기존 브리프 불러오기도 남긴다**(2026-10-16 사용자 요청, `archive.addImport`, kind `import`): 글이 나오는 순간 서버가 넣은 노션 링크(PDF 면
  파일 이름)와 불러온 브리프를 남기고, 사진을 다 받으면 그 기록을 채운다(`updateEntry`). 화면은 불러오기 때 이어서 고칠 초안 id 를 보낸다
  (`POST /api/import` 의 `draftId` — 기록이 있던 초안이면 새 초안으로 갈라진다). 목록에는 「기존 브리프 · 노션 원본」 링크와, 그 초안을
  고쳐 저장하면 「마지막 수정 …」(`PUT /api/drafts` → `archive.touchDraft` 가 목록 요약에만 적는다 — 불러온 뒤 1분 안 저장은 안 보인다).
  열면 그 초안(마지막 수정본)이 [기존 브리프 업로드] 탭·넣었던 링크와 함께 열린다. 하니스 `pw-verify/cbs-import-archive.mjs`(13항목).
- **켜면 늘 새 초안**(2026-10-13 사용자 지시, `main.js loadDraft`): 바탕화면 아이콘·케비서·새로고침 어느 쪽으로 열어도 빈 폼
  ([새로 생성] 탭)·빈 미리보기로 시작한다. 지난 입력과 기획서는 아카이브에서 연다. 창을 닫은 사이 끝난 생성도 바로 열지 않는다
  (예전엔 `fromDraftId` 로 알아보고 열었다 — 서버는 아직 기록만 한다). 빈 초안은 무언가 넣어야 저장되고, `GET /api/drafts/current` 는 화면이 안 쓴다.
  아카이브에 안 남는 것(생성 전 폼)은 다시 켜면 화면에서 안 보인다 — 파일은 `drafts/` 에 남아 있다. [불러오기]로 연 기존 브리프는
  2026-10-16 부터 아카이브에 남는다(그 전에 불러온 것은 `drafts/` 에만 있다).
  **실화면 하니스**: 미리 만든 초안으로 시작하려면 `current.txt` 대신 주소에 `?draft=<id>`(시험용, 새로고침해도 그 초안).
  예전 하니스(current.txt 로 초안을 심던 것)는 goto 주소에 이것을 붙여야 한다. 하니스 `pw-verify/run-fresh-account.sh`(가짜 Claude, 49항목).
- **완료 알림**(`web/js/notify.js`): 브라우저 Notification = 윈도우 오른쪽 아래 알림. 소리는 앱이 Web Audio 로 내고 알림은 silent.
  허용 묻기·소리 켜기는 [생성]을 누른 순간에(사용자 동작이 있어야 된다).
- **Account ID 여러 개**(`web/js/account.js`, 화면·서버 공용): 칸에는 `ID1, @ID2`, Account Tag 에는 `@ID1, @ID2`.
- **캠페인 고르기**(`src/external/kglowing.js` + 화면 `web/js/campaign.js` — 파이널 리포트 campaign-combo 와 같은 동작):
  kglowing 외부 API(`X-API-KEY`, `config.externalApi.key`). 목록은 `/api/v1/seeding/campaigns`(200개씩, 전체 7초 → 켤 때 미리 받고
  5분 지나면 옛 목록을 주며 뒤에서 새로 받는다). **Account ID** = `hashTagAccount` — 태그 감지용 변형 목록이라
  (`clerivy.global, CLERIVY.GLOBAL, Clerivy,global`) 대소문자·점밑줄만 다른 것과 다른 계정의 조각을 걸러 낸다(`campaignAccounts`).
  **업로드폼 링크는 늘 직접 넣는다**(2026-10-12 사용자 지시 — 캠페인을 골라도 자동으로 채우지 않는다. 계정만 캠페인에서 가져온다).
  **계정은 칸에 채운다**(2026-10-13 사용자 지시 — 예전엔 칸을 숨기고 캠페인 계정을 그대로 썼다): 캠페인을 고르면 Account ID 칸이 보이고
  그 캠페인 계정으로 채워진다(`pickCampaign`). 생성 전에 고칠 수 있고, 같은 캠페인을 다시 고르면 고친 값을 두며, 계정 없는 캠페인으로
  바꾸면 칸을 비운다(앞 캠페인 계정이 남지 않게).
  예전엔 캠페인 메일 템플릿(`/mail-templates`)의 리마인드·땡큐레터 버튼에서 찾아 채웠다 — 서버 `GET /api/campaigns/:id`·`findUploadForm`
  (점수: 배송 뒤 메일 +, 영상 제출 말 +, 지원·가입 말 −)은 남아 있지만 화면은 부르지 않는다. 키가 없거나 목록을 못 받으면 둘 다 직접 넣는다.
  폼 값: `inputs.campaign`(고른 캠페인 스냅숏) → `uploadUrl`(= `manualUploadUrl`)·`accountId`(= Account ID 칸) 는 **쓰일 값**.
  예전 초안의 `manualAccountId` 는 더 쓰지 않는다 — 그때도 `accountId` 가 쓰인 값이라 열면 그것이 칸에 들어온다.
  케비서 캠페인 미리 고르기의 「빈 초안」 판단(`open-campaign.js isBlankDraft`)은 계정이 캠페인 계정과 다를 때만 사람이 쓴 것으로 본다.
  자동으로 채우던 때의 초안·아카이브(`campaign.uploadUrl` 만 있음)는 열 때 그 링크를 업로드폼 칸에 보여 준다(`fillForm`).
- **브리프 이름은 받지 않는다**: 작성 결과의 `titleProduct`·`titleConcept`(영어, 스키마 맨 끝 = 내용을 다 쓴 뒤)로
  `build.js briefTitle` 이 `[BRAND]US_TikTok_<제품> _<컨셉> Guide` 를 만든다. 고치는 곳은 [노션에 최종 생성] 창의 제목 칸뿐.
  예전 초안의 `inputs.briefName` 은 있으면 그대로 따른다.
- **필수 칸**: 캠페인(목록을 쓸 수 있을 때)·업로드폼·Account ID·소구점·컨셉.
  「필수: …」 문구는 없다 — 생성 버튼은 늘 눌리고, 누르면 빈 칸이 번쩍인다(`flashMissing`).
- **사측 공유 파일은 선택**(2026-10-12 사용자 지시). 다만 없으면 제품 설명·사용법·제품 사진이 비거나 일반적인 내용이 되므로
  [생성]을 누르면 앱 창(`#nosrc_dialog`, `main.js confirmNoSources`)으로 묻고, 「그래도 만들기」 를 눌러야 `allowNoSources` 를 붙여 보낸다
  (서버도 이 표시 없이는 자료 없는 생성을 막는다). 자료 대신 쓸 길이 둘이다.
  - **「제품 정보」 칸**(`inputs.productInfo`, 선택): 사람이 적은 사실 — 프롬프트에 「제품 정보 칸」 자료로 들어간다(`prompts.js sourcesBlock`).
  - **아마존 상세페이지 링크**: 링크 칸에 넣으면 정리한 PDF 자료가 된다(아래 `src/sources/amazon.js`).
- **비밀값은 화면 오른쪽 위에서 넣는다**(2026-09-29 사용자 지시 — 설치 파일에 담아 자동 등록하던 방식은 되돌렸다):
  노션 = [노션 설정] → 팀 설정 코드(CBS1, `npm run team-code`, 노션 정보만). Kglowing API = [Kglowing API] → X-API-KEY
  (`POST /api/external-api/key` → `kglowing.setKey`: 캠페인 한 건으로 확인한 뒤 config.json 에 저장, 틀린 키는 저장 안 함, 빈 값=지우기).
  버튼 상태 `externalApi = kglowing.status()`(끝 네 글자만). 키가 있는데 목록을 못 받으면 [Kglowing API 확인 필요].
  개발·시험 때만 `CBS_EXTERNAL_API_KEY` 환경변수로 넣는다(파일에 적지 않는다, 있으면 화면 값보다 앞선다).
- **케비서 iframe**(2026-10-13 사용자 지시): 케비서 「TTLabs › 컨텐츠 브리프 생성」(`/ttlab-content-brief`)이 이 화면을
  `http://127.0.0.1:4325` 그대로 iframe 으로 담는다. 일은 지금처럼 이 PC 에서 하고, 케비서는 화면을 담고 비밀값을 넣어 준다.
  - 담을 수 있는 곳 = `src/embed.js KEBISO_ORIGINS`(운영·dev) + `CBS_EMBED_ORIGINS`(로컬 케비서 검증용). 모든 응답에 `frame-ancestors`.
  - 비밀값: 케비서 화면이 `postMessage kebiso:provision` → `web/js/embed.js` 가 **출처와 `e.source === window.parent`** 를 확인 →
    `POST /api/provision`(세션 토큰) → `applyProvision`(바뀐 것만, Kglowing 키는 `setKey` 로 확인). 노션은 케비서 공용 내부 통합 키(`notion.token`)
    → 각자 OAuth 보다 앞선다. config.json `provision.fields` 로 「kebiso 자동 설정」 을 표시한다. **레포에는 여전히 값이 없다.**
  - 알림: iframe 안에서는 크롬이 알림 권한을 못 묻게 막아 `notify.js` 가 `cbs:notify` 로 케비서에 넘긴다(소리는 여기서).
  - 이 화면 → 케비서 `cbs:hello`(준비 상태: Claude 로그인·확장 버전·노션·키, 비밀값 없음)는 `refreshState` 마다 다시 보낸다.
  - 케비서가 켜기: `launch.ps1` 이 켤 때마다 HKCU `kglowing-brief://` 를 **설치본(%LOCALAPPDATA%)일 때만** 등록한다
    (`wscript app.vbs -NoBrowser`). 시험은 `CBS_SKIP_PROTOCOL=1`.
  - 확장은 1.3.0 부터 iframe 안에도 붙는다(`all_frames`, 앱을 탭+프레임 번호로 기억). 화면은 켤 때 `askExtension('hello')` 로 알린다.
  - **캠페인을 골라 둔 채 열기**(2026-10-13): 케비서 TTLab › Campaign 의 [컨텐츠 브리프 생성] → `kebiso:open-campaign {campaignId}`
    (또는 주소 `?campaign=`) → `state.pendingCampaign` → `applyPendingCampaign()`(켜기 끝·목록 받음·작업 끝·부탁 때 다시 시도).
    판단은 `web/js/open-campaign.js openCampaignPlan` — 같은 캠페인 그대로 / 빈 초안 그 자리 / 내용 있는 초안 → 저장 후 새 초안.
    키가 없으면(케비서가 넣는 중) 30초 기다린다. 목록에 없는 번호는 `/api/campaigns/:id` 로 한 번 더. 답은 `cbs:campaign-opened`,
    hello 의 `features: ['open-campaign']` 로 케비서가 예전 판을 알아본다. `loadCampaigns` 는 요청 순번으로 늦게 온 옛 응답을 버린다.
  - 하니스 `pw-verify/cbs-embed-check.mjs`(시험 부모 페이지가 iframe 으로 담는다), `pw-verify/cbs-kebiso-campaign.mjs`(캠페인 미리 고르기 14, 4325→4326 돌려 쓰기).
- **레퍼런스 검색**(`src/brief/reference.js`, 문안은 `prompts.js REFERENCE_PROMPT` — CR팀이 준 글 그대로): 스텝 하나 → 틱톡 검색어 15개(sonnet).
  {{step}} 의 칸 이름은 문안이 부르는 [행동]·[화면]·[자막]·[내레이션]·[시간]으로 고정. [새로 고침]만 직전 키워드를 덧붙여 겹치지 않게 한다.
  - **틱톡 다운로더(확장 1.1+) 연결**(`web/js/tiktok-bridge.js`, 확장 쪽은 별도 프로젝트 `Documents\tiktok-video-downloader` 의
    `src/app-bridge.js`): 확장이 이 화면에 `<html data-ttdl-bridge>` 를 남기면, 검색어를 눌렀을 때 확장이 틱톡 탭을 열고
    그 탭에 기획서 id·스텝 자리 id·스텝 번호를 기억한다. 그 탭에서 영상을 골라 [Step N GIF 생성]을 누르면 확장이 영상을
    받아 `POST /api/videos` 로 **직접** 올리고(다운로드 폴더 안 거침, 토큰은 `GET /api/session`), 이 화면에 begin →
    progress → videos 를 알린다(`video.js fromExtension`). videos 부터는 파일을 올린 것과 같은 큐다. 답(`{ok}`)이 없거나
    ok 가 아니면 확장이 멈춘다 — 다른 초안이 열려 있거나 그 자리가 처리 중이면 거절, 받는 중 [취소]면 cancelled.
    확장이 없거나 답이 없으면 검색어는 그냥 새 탭으로 열린다. Ctrl·가운데 클릭도 확장에 맡긴다(`background` — 뒤쪽 탭) —
    브라우저가 그냥 열면 그 탭은 어느 스텝인지 몰라 버튼이 안 뜬다. 설치·업데이트 전부터 열린 이 화면에는 확장(1.1.1~)이
    연결 스크립트를 직접 넣어 준다(새로고침 불필요).
    확장 1.2~ 는 고른 영상을 **스텝 자리마다 하나로** 모은다 — 같은 스텝에서 연 검색어 탭 여러 개에서 고른 영상이 한 목록이
    되고, 아무 탭에서나 [Step N GIF 생성]을 누르면 전부 온다. 다 받으면(videos ok) 이 화면은 레퍼런스 검색 창을 닫고,
    확장은 그 스텝으로 연 틱톡 탭들을 닫는다.
  - 창 오른쪽 카드는 그 스텝 글을 문서와 똑같이 그린다(`preview.js renderStepCard` — 문서의 스텝 오른쪽 칸과 같은
    `stepFields` 를 쓰고, 누를 자리 표시만 없다).
  - 창 아래 버튼 줄은 없다(닫기는 오른쪽 위 ✕). 목록 오른쪽 위(오른쪽 카드와 윗선 맞춤)에 **[한국어로 생성]·[새로 고침]**(2026-10-06).
    한국어는 기준이 모두 같고 언어를 정하는 6번 줄만 `REFERENCE_RULE_KO` 로 바꾼다(문안 원문은 그대로, 브랜드명은 1번대로 영문 표기 허용).
    `cleanKeywords(list, { lang })` 는 영어면 한글이 든 것을, 한국어면 한글이 없는 것을 뺀다. 화면 캐시·요청은 「스텝 id|언어」 별로 —
    한국어로 바꾼 뒤 버튼은 [영어로 생성]이 되고, 받아 둔 언어로는 기다림 없이 돌아간다. [새로 고침]은 지금 언어로 다시.
    언어를 바꾸면 `refTarget` 을 새 객체로 바꿔 끼워 늦게 온 다른 언어 답을 버린다. 하니스 `pw-verify/cbs-ref-grid-check.mjs`(실제 Claude 21항목).
- `src/claude/` — Claude CLI 호출(구독 로그인, stream-json, --json-schema), JSON 추출.
- `src/sources/` — 사측 공유 파일 읽기(docx·pptx·xlsx 는 의존성 없는 ZIP/XML 파서, PDF 는 Claude 가 직접 읽음, 노션 링크).
  사진도 같이 꺼낸다: `images.js`(추려내기)·`pdf-images.js`(PDF 안의 사진 객체 → JPEG 그대로 / PNG 로 다시 포장,
  투명도 `/SMask` 를 같이 넣지 않으면 오려낸 제품 컷 배경이 검게 나온다)·`imagemeta.js`(크기).
  - **아마존 상세페이지 → 정리한 PDF**(`amazon.js` + `pdf-writer.js`, 2026-10-12): **브라우저를 띄우거나 조종하지 않는다** — kebiso(서버)로
    옮길 수 있게 Node 내장 기능만 쓴다. HTML 을 그냥 받아(`lc-main=en_US` 쿠키 + `language=en_US` — 한국 IP 여도 영어 원문) 아마존이 칸마다
    붙이는 `data-feature-name` 경계로 상품 정보 칸만 잘라 내고(상품명·한 줄 소개·브랜드·상품 정보 표·About this item·중요 정보(성분·사용법·주의)·
    상품 설명·A+·브랜드 소개·세부 정보·사진), 그것으로 PDF 를 **직접** 만든다(Helvetica 기본 글꼴·WinAnsi — 라틴 문자만, JPEG 는 그대로 `/DCTDecode`).
    가격·별점·순위·리뷰·스폰서 광고·관련 상품은 처음부터 안 담는다(경쟁사 상품명·문구가 섞이지 않게). 화면을 그대로 PDF 로 찍으면
    5쪽 중 4쪽이 광고·추천·리뷰였고 「About this item」 은 접힌 칸이라 빠졌고 한국어 기계번역으로 나왔다 — HTML 에는 접힌 칸까지 다 있다.
    A+ 의 PNG 는 아마존 이미지 서버 `_FMjpg_` 로 JPEG 를 받는다(`jpegUrl`, 확장자만 .jpg 로 바꾸면 404). 실측: 상품당 2~4초, 6~8쪽, 1~4MB.
    그 뒤로는 올린 PDF 와 똑같다(`sources/index.js addAmazonLink` — `kind:'pdf'`, `origin:'amazon'`): Claude 가 직접 읽고, 안의 사진은
    제품 사진 후보가 된다. 프롬프트는 아마존 PDF 가 있으면 `AMAZON_RULE` 을 붙인다 — 소매 판매 문구라 **사실만** 쓰고, 「100%」·「#1」 같은
    판매 문구는 브랜드 자료·소구점에 같은 말이 없으면 대사에 넣지 않으며, 다르면 브랜드 자료가 앞선다. PDF 첫머리에도 같은 안내가 있다.
    다 읽은 PDF 자료는 이름을 누르면 새 탭으로 열린다(`GET /api/sources/:id/file`) — 무엇이 들어갔는지 사람이 확인한다.
    **kebiso 로 옮길 때**: 그대로 돈다. 다만 서버(데이터센터) IP 는 아마존이 로봇 확인으로 더 자주 막을 수 있다 — 막히면 같은
    `parseProduct` 결과 모양(상품명·불릿·사진…)을 SP-API 상품 정보(Catalog Items: summaries·attributes(bullet_point)·images)로 채워
    `buildProductPdf` 에 넘기면 된다(A+ 는 그 API 에 없다). 하니스 `pw-verify/run-amazon-source.sh`(진짜 아마존·진짜 Claude, `SKIP_GEN=1` 이면 생성 빼고).
- `src/brief/` — 작성·보정·문서 트리·편집/추가. 제품 사진은 `product-image.js` 에서 **Claude 가 후보를 보고** 고른다
  (제일 큰 사진을 넣으면 십중팔구 배경 그라데이션이다). 글쓰기와 같이 돌려 기다림이 겹치지 않게 한다.
- 고치는 길이 둘이다: 글자만 있는 자리는 `web/js/direct.js` 가 Claude 없이 바로(무엇을 직접 고칠 수 있는지는
  그 파일에만 있다), 여러 조각이 얽힌 자리는 `src/brief/edit.js` 가 프롬프트로. 둘의 대상 판단은 짝이 맞아야 한다.
  - **페이지 제목**(2026-10-13): 미리보기 맨 위 제목을 누르면 직접 고치기(`direct.js` 경로 `['title']`, aiOff). 노션 페이지 제목으로
    글자 그대로 올라간다(옮기지 않는다). 고치면 예전 초안의 `inputs.briefName`(문서 제목보다 앞선다)을 비운다(`main.js` 편집기 commit).
- **글 속 링크 고치기**(2026-10-13 사용자 요청, 새로 생성·기존 브리프 업로드 둘 다): 미리보기에서 링크를 누르면 링크 창
  (`web/js/link-editor.js`, `#link_pop`) — 링크 텍스트·URL 두 칸, [적용]·[링크로 이동](지금 칸에 적힌 URL 을 새 창으로, 적용 전에도)·[취소].
  - 링크마다 `data-link = { at: 그 글의 문서 경로, k: 그 글의 몇 번째 링크 }`(`preview.js rich(text, at)`). 고정 문구 줄은 노드의 `'text'` 경로.
    경로를 안 주는 곳(스텝 제목 줄·소제목·Do's 제목·고정 문구 Do's)의 링크는 예전처럼 문단 편집으로 간다.
  - **위치는 파서가 실제로 링크로 읽은 원문 범위**: `inline.js` 가 link·autolink·linkify 규칙을 감싸 원문 시작·끝(글자 칸·주소 칸)을
    `link_open` 토큰에 적고 `parse(text).links` 로 준다. 조각의 `link` = 몇 번째 링크(같은 URL 의 링크가 붙어 있어도 안 합친다).
  - **바꾼 뒤 다시 읽어 확인**(`web/js/links.js verify`): 링크 수 같음, 그 링크의 href·글자가 넣은 값과 같음, 다른 링크·링크 밖 글자·서식이
    하나도 안 바뀜. 못 통과하면 고치지 않고 오류. 주소 칸만/글자 칸만 바꿔 끼우고(나머지 원문 그대로), 괄호 든 URL 은 `<URL>`.
    글자는 마크다운으로 안 읽히게 이스케이프하고, 링크 글자 전체에 걸린 서식(굵게·색)은 태그로 다시 씌운다(부분 서식은 창에서 알린다).
  - **글자가 곧 URL 인 링크**(맨 주소·`<URL>`·`[https://a](https://a)`): URL 만 바꾸면 보이는 글자도 새 URL(`showsUrl`). 맨 주소가
    뒤 글자와 붙어 안 읽히면 `<URL>`. 보이는 글자와 걸린 URL 이 다른 링크(불러온 TAESI.K 의 음악 칸)는 창에 둘이 따로 보인다.
  - **고정 문구 줄**(📢 박스의 제출·아마존·틱톡샵 줄): URL 만 바꾸면 `vars.url` 만(+ 같이 저장된 한국어 `text` 도 — `edit.js` 가
    이 문단을 Claude 에게 넘길 때 그 글을 쓴다, 옛 URL 이 남으면 되살아난다). 노션에는 정해진 영어 문구에 새 URL(옮기기 안 거침).
    텍스트를 바꾸면 chrome 을 떼고 사람이 쓴 글이 된다(노션에 올릴 때 옮긴다).
  - **영어본의 URL**: 사람이 쓴 줄의 URL 만 바꾸면 옮겨 둔 영어 줄(enCache)도 새 URL 로 옮긴다(`relinkCache` — 다시 옮기지 않는다).
    옮기기 결과는 `translate.js` 가 원문과 링크를 맞춘다(`keepLinks` — 바뀐 URL 은 원문 것으로, 링크가 빠지거나 늘면 다시 시키고 두 번째도 그러면 실패).
  - 창을 연 사이 문서가 바뀌었으면(되돌리기·다른 편집) 넣지 않는다(`readLink().str` 비교). 다시 그려 그 링크가 사라지면 창을 닫는다.
  - 하니스 `pw-verify/run-link-edit.sh`(가짜 Claude, 53항목 — 새로 생성 + 실제 불러온 ILLIYOON·TAESI.K, 포트 4333), 단위 `test/links.test.js`.
- `src/media/`·`src/video/` — 스텝 참고 GIF([영상으로 자동 생성]): 영상에서 구간을 찾아 잘라 넣는다.
  도구(ffmpeg·whisper.cpp)는 **앱이 내려받아** `~/.content-brief-studio/tools/` 에 둔다(레포·npm 에는 넣지 않는다).
  1초에 한 장씩 뽑아 **12장을 격자 한 장**으로 합치는 게 비용의 핵심이다 — 낱장을 읽히면 왕복마다 대화가 다시 올라가
  몇 배가 된다. 화면 설명은 **영상당 한 번**(sonnet) 만들어 `frames.json` 에 남기고, 구간 고르기는 **GIF 하나당 한 번**(opus).
  - **화면 설명은 sonnet, 격자 4장씩 나눠 동시에**(2026-09-30). haiku 는 긴 영상 격자를 제대로 못 읽고 장면을 지어냈다 —
    「Step 2: soak cotton pads」 자막이 뚜렷한 장면을 「목에 톡톡」으로 적어, 영상 2개를 넣어도 엉뚱한 한 영상만 잘려 들어갔다.
    설명에는 화면 속 글자(`text`, 자막·캡션)도 받는다 — 튜토리얼 영상에서 구간을 가르는 가장 확실한 단서다.
    설명 방식을 바꾸면 `prompts.js DESCRIBE_VERSION` 을 올린다 — meta 의 `describeVersion` 이 다르면 준비 때 다시 읽는다
    (한 번 만든 설명은 영구 재사용이고 같은 파일은 해시로 합쳐지므로, 안 올리면 틀린 설명이 계속 쓰인다).
  - 준비 때 장면이 바뀌는 시각도 뽑아 둔다(`cuts.json`, ffmpeg scene, 2분 영상 1초). 조각 경계를 ±1초 안의 컷에 붙인다(컷 안쪽으로 0.1초 단위).
  - 구간 고르기: 스텝의 행동 줄에 번호를 달아 주고, 조각마다 맡은 행동(`covers`)을, 영상이 여럿이면 영상마다 한 줄(`videoNotes`)을 받는다.
    영상이 여럿이면 행동마다 **모든 영상**에서 가장 잘 보이는 곳을 비교하게 한다(예전 「한 영상 우선」 문구가 한 영상 쏠림을 부추겼다). 연결용 조각 금지.
  - **실제 장면 확인**(`src/video/verify.js`, sonnet): 미리보기를 1초 한 장 격자로 만들어 후보마다 **따로 동시에** 보인다
    (넷을 한 번에 보이면 1분 가까이 걸렸다 → 약 15초). 결과는 **통과/미흡 판정**으로만 쓴다 — 후보를 하나씩 따로 매긴 점수는
    서로 견주기엔 흔들려서, 순서는 구간 고르기의 확신도를 따르고 미흡(50% 미만)만 내린다(`web/js/clip-rank.js`, 화면·서버 공용).
    이어 붙인 것에 안 맞는 조각이 있으면 빼고 남은 조각(둘 이상)으로 다시 붙인다(`fitsWithout`). 확인이 실패해도 결과는 그대로 준다.
  - 미리보기 이름에 실행마다 표시를 붙인다(`k3xs1`·`k3xseq`) — 같은 영상을 다른 스텝에서 또 고르면 덮이고 캐시로 옛 것이 보였다.
  돌려받은 구간은 코드가 다시 다듬는다(길이 3~10초·영상 범위·겹침·컷). 실측(2026-09-30, 25초+2분 영상 2개): 준비 35·77초(동시),
  구간 고르기 약 35초, 실제 장면 확인 약 15초 — 올린 뒤 결과까지 약 2분. 하니스 `pw-verify/cbs-video-multi2.mjs`(`run-multi2.sh`).
  화면(`web/js/video.js`): 진행은 **회색 상자 안에서** 보이고 창은 구간 고를 때만 뜬다. 올리기는 상자마다 동시에,
  Claude 처리는 올린 순서대로 한 줄(큐)로. 한 상자 안의 영상 여러 개는 준비를 **동시에** 돌린다(상자의 `jobIds` — [취소]가 전부 멈춘다). 패널은 상자 내용을 **덮기만** 한다 — 지우고 그리면 패널이 빠질 때
  넣은 GIF 가 돌아오지 않는다. 문서를 다시 그릴 때마다 `paint()` 를 불러 상태를 되살린다.
  패널은 상자 크기(회색 비율·넣은 GIF 크기)를 그대로 두고 **상자 세로 가운데**에 뜬다(2026-10-06, `app.css .n-slot.has-panel` — 원래 내용은
  `visibility: hidden` 으로 자리만 차지하고 패널과 같은 grid 칸에 겹친다. 예전엔 상자가 버튼 높이로 줄어 위쪽에 붙어 보였다).
  **이미 GIF 가 들어 있는 칸**을 누르면 만들기 버튼 대신 [삭제]·[GIF 다운로드](`video.js filledPanel`, 2026-10-06 — 새 브리프·불러온 브리프 모두).
  삭제는 회색 자리로 돌리고(되돌리기로 살린다) 상자를 연 채라 곧바로 만들기 버튼 셋이 뜬다. 다운로드는 `/api/assets/<id>` 를
  a[download] 로(이름은 자산 이름, 사진이면 [이미지 다운로드]). 하니스 `pw-verify/cbs-filled-slot-check.mjs`(16항목, Claude 없음).
  이 두 버튼은 **하늘색 네모로 덮지 않고 그 GIF 썸네일 위에** 흰 카드로 뜬다(2026-10-16 사용자 요청 — `filledPanel` 의 `data-over-image` →
  상자 `panel-over-image`, `app.css .vp-over`). 회색 자리·작업 중 패널은 예전처럼 하늘색 바탕.
  자리는 노드 id 로 다시 찾는다(작업 중에 스텝이 밀릴 수 있다), 같은 영상은 바이트가 같으면 하나로 친다.
  한 자리에 **영상을 여러 개** 올릴 수 있다. 구간 고르기는 한 번에 두 가지를 받는다 — 한 구간짜리 후보 3개와,
  한 구간으로 안 담길 때 쓰는 **이어 붙이기**(조각 2~4개, 서로 다른 영상에서 와도 된다). 이어 붙이기는
  조각마다 크기·fps 를 맞춘 뒤 concat 한다(`media/ffmpeg.js` 의 `stitch`) — 필터 하나로 묶으면 크기가
  다른 영상에서 조용히 깨진다. 길이는 조각 1.5~6초·전체 12초까지로 코드가 자른다.
  - **구간 고르기 창**(2026-10-12): 위는 추천 후보 **최대 3개를 나란히**(`clip-rank.js rankedPicks` — 이어 붙인 것을 한 구간짜리들
    사이 제자리에 끼우고, 맨 앞은 늘 `topPick` 이라 그 칸만 진하게 파란 칸), 아래는 **직접 컷 편집**(`web/js/cut-editor.js`,
    구간 계산은 화면 없이 시험하는 `web/js/cut-ranges.js`). 예전 「직접 구간 지정」 숫자 칸을 대신한다.
    - **배치**(같은 날 2차, 사용자 지시): 창을 열자마자 **스크롤 없이 바가 보여야** 한다(아래에 있으면 기능이 없는 줄 안다).
      왼쪽 = 썸네일 → 재생 줄·시퀀스 바 → 합계·[GIF 만들기], 오른쪽 = 미리보기. 「고른 구간」 목록과 창 아래 [닫기] 줄은 없앴다(✕·Esc).
      **바(950px)·미리보기(영상 비율, 세로 169px) 폭은 예전 그대로** — 창이 미리보기만큼 넓어진다(`--ce-stage-w`, `.clip-dialog`
      max-width = 1014px + 미리보기). 추천 카드 영상 높이도 예전 169px 로 고정(넓어진 만큼 카드가 길어져 바가 밀리지 않게).
      1920×950·1440×1000 은 영상 3개여도 바·버튼까지 보인다. 125% 배율 노트북(1536×730)은 영상 3개면 아직 조금 내려야 한다.
    - 처음엔 가장 유력한 후보의 구간(`fromParts`). 바의 빈 곳을 누르면 그 자리부터 1초, 양 끝 손잡이로 늘이고 줄인다(옆 구간·반대쪽
      끝을 못 넘는다). 한쪽 끝을 반대쪽 끝에 붙이면(0초) 빨간 테두리 + 「구간 선택 취소」, 그대로 놓으면 지운다.
      **파란 구간 가운데를 끌면 길이 그대로 옮긴다**(`moveRange` — 옆 구간·영상 끝에서 멈춤, 누르기만 하면 인디케이터만).
      끝을 끌거나 옮기는 동안 인디케이터가 그 끝(옮길 땐 시작)을 따라가고 위에 그 자리 화면(큰 화면 프레임을 canvas 로 옮겨 그린다)이 뜬다.
    - **필름스트립**: 바의 영상 칸에 장면 사진을 깐다. 서버가 0.5초마다 한 장(높이 64px)을 가로 한 줄 JPEG 로(`GET /api/videos/<id>/strip`
      = 칸 정보, `/strip.jpg` = 사진, `scrub.js ensureStrip`), 화면은 칸 높이에 맞춘 폭으로 이어 놓고 칸마다 그 자리 초의 장면을
      background-position 으로 고른다(`cut-editor.js stripTiles`). 고른 구간 밖은 어둡게, 안은 `backdrop-filter` 로 밝게.
    - 지금 GIF 가 될 조각은 편집기 루트의 `data-parts`(JSON)에도 적는다 — 화면엔 안 보이고 실화면 시험이 읽는다.
    - 영상이 여럿이면 썸네일로 넣고 뺀다 — **누른 순서대로** 바에 이어 붙고(`order`), 빼도 그 영상의 구간은 남아(`ranges`)
      다시 넣으면 그대로다. GIF 는 order 순서, 영상 안에서는 시간 순(`partsOf`). 편집 상태는 상자의 작업(`job.cut`)에 남아
      창을 닫았다 열어도 이어진다. 눈금(위쪽 띠)·인디케이터 머리를 끌면 인디케이터만 옮기고, ▶ 는 고른 구간만 이어서 재생.
    - 화면은 서버의 **탐색용 영상** `GET /api/videos/<id>/scrub`(`src/video/scrub.js` — 긴 변 640px, 소리 없음, 키프레임 8장마다라
      끌어도 바로 그 장면, HEVC 원본도 H.264 로). **Range 요청에 206** 으로 답해야 <video> 가 옮겨 간다(없으면 처음으로 돌아간다).
      구간 고르기 작업이 Claude 를 기다리는 동안 같이 만들고, 없으면 처음 열 때 만든다. 영상마다 <video> 하나, 인디케이터가 있는
      영상만 보인다. 바의 영상 길이는 준비 결과(`usedSec`)를 쓴다 — 올린 직후 받은 영상 정보는 길이가 0 이라 `prepareAll` 이 갈아 끼운다.
    - 하니스 `pw-verify/run-cut-editor.sh`(가짜 준비·구간 고르기, 41항목 — 올리기·탐색용 영상·장면 사진·GIF 는 진짜, 폭·스크롤 없이 보임 포함),
      `REAL=1 bash run-cut-editor.sh`(진짜 Claude 한 번, 영상 2개).
- `src/notion/` — OAuth(파이널 리포트 공개 통합 재사용), 쓰기 가드, 블록 변환, 게시.
- **틱톡 다운로더**(아카이브 오른쪽 [틱톡 다운로더 설치]): 케비서 **운영** 프로그램 다운로드 센터
  (`https://kglowingai.com/download-center`)를 새 탭으로 여는 링크일 뿐이다. 확장(별도 프로젝트
  `Documents\tiktok-video-downloader`)의 배포본은 이 레포에 넣지 않는다 — 공개 레포라 넣으면 공개된다.
- `web/` — Final Report 플러그인과 같은 모양의 화면(빌드 없음).
- 데이터: `~/.content-brief-studio/` (`CBS_DIR` 로 바꿀 수 있음).

## 검증

- `npm test` — 단위 테스트(Claude·노션 호출 없음).
- 실화면: standalone Playwright 하니스(`C:\Users\GUHADA\pw-verify\`)로 폼 → 생성 → 편집 → 게시(샌드박스)까지.
