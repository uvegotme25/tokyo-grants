# 도쿄 지원금 보드 東京助成金ボード

일본(도쿄) 정부·기관의 보조금/조성금 정보를 매일 자동 수집해서 한 곳에서 보는 사이트.
jGrants 공개 API(디지털청) 기반, 서버 없이 GitHub Pages + Actions로 동작.

## 기능

- 매일 07:00 JST 자동 수집 (GitHub Actions cron)
- 키워드 검색, 카테고리 칩 필터, **예술만 보기** 토글
- 마감 임박 / 신규 등록 / 금액순 정렬, D-day 스탬프 표시
- 신규 항목 자동 감지 → NEW 뱃지 (7일간)
- (선택) 신규 예술 지원금 Telegram 알림

## 설정 방법

1. GitHub에 새 repo 생성 후 이 폴더 전체를 push
2. repo **Settings → Pages** → Source: `Deploy from a branch`, Branch: `main` / `/docs` 선택
3. **Actions** 탭 → `collect` 워크플로우 → `Run workflow` 클릭 (첫 수집)
4. 몇 분 뒤 `https://<username>.github.io/<repo>/` 접속

### Telegram 알림 (선택)

repo **Settings → Secrets and variables → Actions**에 추가:

- `TELEGRAM_BOT_TOKEN` — 기존 봇 토큰 그대로 사용 가능
- `TELEGRAM_CHAT_ID` — 알림 받을 채팅 ID

첫 실행(전체가 신규)에는 알림을 보내지 않고, 이후 실행부터 신규 예술 항목만 알림.

## 로컬 테스트

```bash
node scripts/collect.js        # docs/data.json 생성
npx serve docs                 # 또는 python3 -m http.server -d docs
```

## 커스터마이즈

`scripts/collect.js` 상단에서 수정:

- `SEARCH_KEYWORDS` — 수집 검색어
- `CATEGORY_RULES` — 카테고리 태깅 규칙
- `ARTS_TAGS` — "예술"로 분류할 태그

## 예술 조성금 소스 (Claude API 추출)

jGrants 외에 예술 전용 소스 7곳(ネットTAM, Arts Council Tokyo, 東京都生活文化局, 文化庁, セゾン·野村·朝日 재단)을 함께 수집.
사이트별 스크래퍼 대신 **페이지 텍스트를 Claude Haiku가 구조화 추출**하는 방식이라
레이아웃이 바뀌어도 계속 작동하고, 소스 추가는 `scripts/arts.js`의 `SOURCES`에 URL 한 줄이면 됨.

활성화하려면 repo Secrets에 **둘 중 하나만** 추가:

- `GEMINI_API_KEY` — **완전 무료.** [Google AI Studio](https://aistudio.google.com/apikey)에서 발급, 카드 등록 불필요.
  무료 티어 한도(모델별 일 수십~수백 회)로 하루 7회 호출은 여유롭게 커버됨
- `ANTHROPIC_API_KEY` — Claude Haiku 사용 (하루 몇 엔 수준의 종량제)

둘 다 있으면 Gemini(무료)를 우선 사용. 둘 다 없으면 예술 소스는 자동 스킵되고 jGrants만 수집됨.
Gemini 모델은 `scripts/arts.js`의 `GEMINI_MODEL`에서 변경 가능.

### 소스 튜닝 팁

- 각 URL은 기관의 **공모/조성 목록 페이지**를 가리킬수록 추출 품질이 좋아짐
- JS로 목록을 그리는 페이지(일부 ネットTAM 검색 결과 등)는 본문이 비어 스킵될 수 있음 — 그 경우 정적 목록 URL로 교체
- 실행 로그(Actions)에서 소스별 건수를 확인하며 URL을 조정하면 됨
