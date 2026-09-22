# Content Brief Studio

브랜드 자료와 컨셉을 넣으면 TikTok 크리에이터용 영상 컨텐츠 가이드(기획서)를 만들어 주고,
미리보기에서 말로 다듬은 뒤 노션 **Contents Guidline** 아래에 새 페이지로 올려 주는 PC 프로그램입니다.

- 글은 각자 PC 의 **Claude** 가 씁니다(내 Claude 구독으로 로그인 — API 키 없음).
- 형식과 어조는 [docs/brief-template-guide.md](docs/brief-template-guide.md) 를 그대로 따릅니다.
- 화면 모양은 TikTok Final Report 플러그인과 같습니다.

## 설치 (처음 한 번)

1. 관리자에게 받은 **install.bat** 을 두 번 누릅니다.
   또는 PowerShell 에 이 한 줄:
   ```powershell
   irm https://raw.githubusercontent.com/Yongbeen01/content-brief-studio/main/scripts/install.ps1 | iex
   ```
   관리자 권한이 필요 없습니다. Node·git·Claude Code 가 없으면 알아서 받습니다.
2. 설치 중에 **Claude 로그인** 창이 뜨면 브라우저에서 로그인합니다(Claude Pro/Max/Team 구독 필요).
3. 앱이 열리면 오른쪽 위 **[노션 설정]** → 관리자에게 받은 **팀 설정 코드**(`CBS1.`로 시작)를 붙여넣습니다.
4. 이어서 뜨는 노션 승인 화면에서 **Contents Guidline** 페이지를 선택하고 허용합니다.

다음부터는 바탕화면의 **Content Brief Studio** 아이콘으로 엽니다. 새 버전은 30분마다 알아서 받습니다.

## 쓰는 법

1. 왼쪽 칸을 채웁니다. 별표(*)는 필수입니다.
   - **소구점**: 영상에서 반드시 보여 주고 강조할 점(한 줄에 하나)
   - **컨셉 설명**: 영상 전체의 흐름·타입
   - **사측 공유 파일**: [첨부파일]로 pdf·pptx·docx·xlsx, 또는 노션 링크를 붙여넣고 Enter
2. **[생성]** — 1~2분 뒤 오른쪽에 노션 모양 미리보기가 나옵니다.
3. 다듬기
   - 고치고 싶은 곳을 **누르고** 어떻게 바꿀지 적습니다(한국어로 적어도 영어로 고쳐 줍니다).
   - 블록 **사이**에 마우스를 대면 「+ 여기에 추가」가 나옵니다. 눌러서 넣을 내용을 적습니다.
   - **회색 네모**(사진 자리)를 누르면 사진·GIF 로 바꿉니다.
   - 잘못 고쳤으면 **[되돌리기]**(Ctrl+Z).
4. **[노션에 최종 생성]** — Contents Guidline 아래에 새 페이지가 생깁니다. 안 바꾼 사진 자리는
   회색 이미지로 올라가니 노션에서 이미지를 눌러 「바꾸기」로 나중에 넣어도 됩니다.

적은 내용은 자동 저장됩니다. 창을 닫았다 열어도 그대로 돌아옵니다.

## 자주 묻는 것

- **[Claude 로그인]이 빨간색** — 눌러서 브라우저 로그인. 끝나면 초록색으로 바뀝니다.
- **"Claude 사용 한도에 걸렸습니다"** — 구독 한도입니다. 안내된 시각 뒤에 다시 하세요.
- **노션에 만들기가 "권한이 없습니다"** — 노션 승인 때 Contents Guidline 을 선택하지 않은 것입니다.
  오른쪽 위 노션 버튼 → [다시 연결].
- **약 6개월마다** 노션 승인을 다시 해야 합니다(노션 정책).
- 앱이 안 켜지면 로그를 보내 주세요: `%USERPROFILE%\.content-brief-studio\logs\app.err.log`

## 관리자

### 노션 통합 설정 (한 번)

파이널 리포트가 쓰는 노션 **공개 통합**을 재사용합니다. 통합 설정에서:

- **리디렉션 URI** 에 `http://localhost:4325/api/notion/oauth/callback` 을 **추가**(기존 URI 는 그대로)
- **기능(Capabilities)** 에서 콘텐츠 읽기 + **콘텐츠 삽입(Insert content)** 켜기

### 팀 설정 코드 만들기

```powershell
npm run team-code
```

client ID·secret 을 넣으면(시크릿은 화면에 안 보임) `CBS1.…` 코드를 줍니다.
코드 안에 client secret 이 들어 있으니 **슬랙 DM 처럼 비공개로만** 전달하세요.

### 안전장치

- 이 도구는 노션에 **설정된 부모 아래 새 페이지 만들기**만 합니다. 기존 페이지를 고치거나 지우는
  요청은 보내기 전에 코드가 막습니다(`src/notion/client.js` 쓰기 가드).
- 게시 도중 실패하면 만들던 페이지를 보관(휴지통) 처리해 반쪽 페이지가 남지 않게 합니다.
- 시크릿·토큰·초안은 전부 `%USERPROFILE%\.content-brief-studio\` 에만 있습니다. 레포는 공개입니다.

## 개발

```powershell
npm test                         # 단위 테스트 (Claude·노션 호출 없음)
$env:CBS_PORT=4326; npm start    # 설치본(4325)과 겹치지 않게
$env:CBS_NOTION_PARENT='<샌드박스 페이지 id>'   # 테스트 게시는 샌드박스로
```

규칙은 [CLAUDE.md](CLAUDE.md) 를 보세요. 의존성은 없습니다(`node:` 내장 모듈만).
마크다운 파서는 [markdown-it](https://github.com/markdown-it/markdown-it) (MIT) 를 `web/vendor` 에 담아 씁니다.
