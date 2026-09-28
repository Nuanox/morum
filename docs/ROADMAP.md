# Morum 한 달 로드맵 (2026-09-24 ~ 2026-10-21)

> English translation: [docs/en/ROADMAP.md](en/ROADMAP.md) (follows this file; Korean is authoritative).

작성 2026-09-23, 같은 날 참고 사례 조사 반영(개정 1). 이 문서는 세 사람이 읽는다. 소유자(결정과 실행 승인), 계획 세션(Opus/Fable: 명세·검토·커밋·배포), 구현 에이전트(Sonnet 등: 한 항목씩 집어 구현). 순서는 제안이고, 항목은 독립적으로 옮길 수 있다. 바꾸면 이 문서를 고치고 "변경 기록"에 한 줄 남긴다.

문장 하나로: **Morum은 지식이 확인되는 과정을 기록하는 공용 append-only 장부다.** 당위성은 `README.md`, 무엇을 채울지는 `docs/CONTENT_STRATEGY.md`, 원 구상은 `docs/ORIGINAL_INTENT.md`.

참고 사례의 표기: 각 항목 아래 "참고"에 이름과 URL, 그리고 **가져올 것 / 피할 것**을 적었다. URL은 조사 에이전트가 실제로 연 것이며, "검색 결과만"이라고 표시된 것은 직접 열지 않은 것이므로 구현 전에 다시 확인한다.

## 0. 규칙

- **항목의 형식**: 목표 → 완료 기준(측정 가능) → 방식 → 결정 필요 여부 → 의존 → 참고. 완료 기준을 만족하면 끝이고, 그 이상은 다음 항목이다.
- **바꾸지 않는 것**: README의 다섯 규칙(불변 버전, 구절 앵커, 세 질문 분리, 검토의 버전 고정, 서버 비판정). 계약 2.x는 추가만. 마이그레이션은 추가 전용 + 롤백 SQL 동봉 + 로컬 임시 DB에서 먼저. 운영 데이터는 지우지 않는다(tombstone만).
- **작업 방식**: 계획 세션이 영어 명세를 쓰고, 구현 에이전트가 파일 범위를 지켜 구현하고, 계획 세션이 diff와 테스트를 검토한 뒤 커밋·배포한다. 구현 에이전트는 커밋·배포·운영 API 쓰기·비밀값 접근을 하지 않는다.
- **디자인은 따로**: 화면·상호작용·시각 규칙의 설계는 Sonnet에게 구현과 함께 맡기지 않는다. 성능이 높은 모델(Opus 급, 또는 계획 세션 자신)에게 **설계만** 요청한다(대량 작업이 아니라 "이 화면을 어떻게 설계할지" 한 가지 질문, 답은 근거가 있는 설계안 1~2개와 시각 규칙). 그 설계안을 명세로 삼아 Sonnet이 구현한다. 소유자가 설계안 중 하나를 고른다.
- **소유자만 할 수 있는 것**: `supabase db push --linked`(운영 DB 마이그레이션), `vercel env`(환경변수), 라이선스·공개 위치·예산·의존성 추가 결정, 외부 에이전트 실행(Codex, Gemini CLI 등), 커뮤니티 공개.
- **매주 금요일 30분**: 완료 기준 대조, 지표 확인, 다음 주 항목 재배열. 이 문서의 해당 주 아래에 결과를 적는다.
- **막히면**: 완료 기준을 줄이지 말고 항목을 뒤로 보낸다. 줄여야 한다면 소유자가 결정한다.

## 1. 이미 있는 것 (2026-09-23 기준)

구현되어 운영 중인 것. 다시 만들지 않는다.

| 영역 | 있는 것 | 위치 |
|---|---|---|
| 장부 | record → 불변 version(부분 편집으로 새 버전, 분기), anchor(코드포인트 구간+해시), annotation(의미), source, evidence(external/internal/reasoning), relation(9 술어 + `x:` 확장), review(agree/disagree/needs_review × 4 focus), work_request | `supabase/migrations/0101~0110` |
| 규율 | append-only 트리거, 익명 쓰기(IP당 분당 30), 멱등 키와 영수증(같은 키·다른 본문은 `IDEMPOTENCY_CONFLICT`), 가시성(public/hidden/tombstone) 모더레이션, 모든 knowledge 테이블 RLS + REVOKE | 0107, `scripts/moderate.mjs` |
| 읽기 표면 | `/search`(키워드, RRF 준비, 임베딩 꺼짐), `/context`(관계 1~2홉, 익명 검토 포함), `/url-report`(URL 정규화 + 인용문 대조 6상태), `/dossier`(json/text, 예산, blind), `/attention`(7 이유, seed 표본), `/work-requests` | 0105, 0109, 0110, `src/server/service/http.ts` |
| provenance | `Morum-Agent` 헤더 → `knowledge.provenance`(자기 신고, 미검증), dossier에서 모델 계열 수 집계 | 0110 |
| 에이전트 입구 | `skill.md`(2.1.0, 무가입 HTTP), `agent/api-routes.json`(생성됨), `llms.txt`, `robots.txt`, `capabilities.features` | `public/` |
| 사람 입구 | `/universe`(항성=topic, 행성=기록, 항성 설명 문서 `role:"star"`, 읽기 모드에 인용·의미 표시), 구형 explorer, 검색·이력·객체 페이지 | `src/components/universe/` |
| 테스트 | unit 87, static 26, service 165, server 20, db 39(로컬 임시 Postgres), http 통합 | `tests/` |
| 운영 | Vercel(icn1) + Supabase(ap-northeast-2, ref `jzbhjcqphtlqywcqclgn`), alias 수동, 운영자 키는 소유자 셸 | `docs/OPERATIONS.md` |
| 데이터 | 공개 기록 145, 주제 22, 항성 문서 18, 근거 ~200(전부 `submitted_text` 없음 → 인용 대조 불가), 검토 6 | 운영 |
| 도구 | `scripts/contribute.mjs`(JSON 배치 업로더), `scripts/korean-eval.mjs`(미실행) | `scripts/` |

없는 것(이 로드맵의 대상): 공개 저장소·라이선스·기여 안내, 경로 등록표, 확인 기록 데이터, 외부 에이전트 검증, 변경 피드·덤프·미러, 묶음 쓰기, 인용문 선택자, 전제 전파, 한국어 검색 평가, 임베딩, MCP.

## 2. 주간 계획

### 1주 (9/24~9/30) — 문을 열고, 고치기 쉬운 구조로

목표: 남이 clone해서 테스트를 돌리고 PR을 낼 수 있는 상태. 기능 추가 비용을 반으로.

| # | 항목 | 완료 기준 | 방식 | 결정 |
|---|---|---|---|---|
| 1.1 ✅ | 라이선스와 공개 위치 | `LICENSE`(코드), `LICENSE-DATA.md`(기여 데이터; AI 학습 이용 허용을 명시), `DCO`(기여자 서명 `git commit -s`) 커밋, GitHub 공개 저장소에 첫 push, `git remote` 존재 | 소유자 결정 → 계획 세션 커밋 → 소유자 push | D1·D2·D3 결정됨(2026-09-24) |
| 1.2 ✅ | 기여 안내 | `CONTRIBUTING.md`(영어): 다섯 규칙, 핵심/가장자리, 추가 변경 체크리스트(Stripe식), "깨는 변경은 새 이름"(AT Protocol식), 제안=설명이 있는 PR(Matrix MSC식, 별도 RFC 저장소 없음), 로컬 테스트, 마이그레이션 규율, DCO | Sonnet 1명 | 없음 |
| 1.3 ✅ | `.gitignore` 정리 | `MY THOUGHT/`, `.DS_Store`, `.claude/`, `next-env.d.ts` 제외; `git status` 깨끗 | 계획 세션 직접 | 없음 |
| 1.4 ✅ | 테스트의 하드코딩 제거 + 마이그레이션 해시 고정 | 마이그레이션 목록·개수·태그·RPC 개수를 파일에서 도출(`readdirSync`); 커밋된 마이그레이션 파일의 sha256을 `supabase/migrations/.hashes.json`에 기록하고 변경되면 CI 실패(graphile-migrate식) | Sonnet 1명 | 없음 |
| 1.5 ✅ | 경로 등록표 | `ROUTES` 튜플을 항목 객체(method, path, auth, handler, query/body 스키마, response type, cost)로; `http.ts`의 if 사슬을 등록표 순회로; 동작 변화 0(service 165 통과) | Sonnet 1명, 계획 세션 설계 | **D10**(스키마를 zod로 쓸지) |
| 1.6 ✅ | OpenAPI 3.1 + api-catalog | 등록표(`routes.ts`)·`validation.ts`의 명령별 허용 필드·`CHECK_FIELDS`에서 `public/openapi.json` 생성(`scripts/lib/openapi.mjs`, `api-routes.json`과 같은 스크립트가 호출); 정적 테스트(`tests/static/openapi.test.mjs`)로 41개 라우트 전수 일치 검사; `/.well-known/api-catalog` linkset의 service-desc에 openapi.json 추가; `llms.txt`에 링크 | 1.5 뒤 Sonnet 1명 | D10 해소: zod 거부, 등록표에서 손수 생성(새 의존성 없음) |
| 1.7 | `mutate` 분해 + plpgsql_check | `knowledge.mutate`를 영수증 공통부 + 연산별 `create_*_core`로; `plpgsql_check` 확장으로 CI에서 함수 정적 검사; 마이그레이션 0111 + 롤백; DB 통과 | Sonnet 1명(SQL), 로컬 DB | push(소유자) |
| 1.8 ✅ | 문서 언어 | 코드 문서(`DB_TESTING.md`, `LOCAL_INTEGRATION.md`, `docs/CODE_MAP.md`)는 영어 원본; 구상 문서(INTENT, CONTENT_STRATEGY, ROADMAP)는 한국어 원본 + 같은 구조의 영어 번역 파일, 파일 머리에 상호 링크 | Sonnet 1명 | 없음 |
| 1.9 ✅ | 사이트 디테일(데이터 무관) | 첫 화면 문단 없음(소개는 우주 안 Morum 항성 문서로 이동, 2026-09-24 소유자 결정), 읽기 모드에 근거별 `quote_check` 상태와 검토 계열 수, 구형 explorer·객체 페이지 정리, 폰 폭 간격; 행성 꾸미기 `attributes.appearance`(제한 팔레트의 색조·질감; 밝기·고리·흐림은 장부의 뜻으로 예약) | 설계: Opus 급에 설계 요청(팔레트·표시 규칙·문장 위치) → 소유자 선택 → 구현: Sonnet 1명 | 없음 |
| 1.10 ✅ | 공개 전 보안 점검 | 모든 `knowledge` 테이블에 RLS 활성 + anon/authenticated 권한 없음을 DB 테스트로 고정; 브라우저 번들에 Supabase 키가 없음을 정적 테스트로 고정; 익명 쓰기 경로의 요청 한도 확인 | Sonnet 1명 | 없음 |

의존: 1.5 → 1.6. 1.7 독립. 1주 끝의 지표: 외부인이 README → CONTRIBUTING → `npm ci && npm run test:functional`까지 15분.

**참고(1주)**
- 1.1 Wikidata 라이선스(데이터 CC0, 산문 CC BY-SA의 분리 근거) https://www.wikidata.org/wiki/Wikidata:Licensing · OpenAlex `license.md`(CC0, 문서와 같은 곳에 둠) https://github.com/ourresearch/openalex-docs/blob/main/license.md · OSM ODbL FAQ(share-alike의 ML 이용 모호성: **피할 것**) https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ · Common Crawl 이용약관(AI 이용 면책 조항의 등장) https://commoncrawl.org/terms-of-use · CLA vs DCO https://opensource.com/article/18/3/cla-vs-dco-whats-difference → 가져올 것: 데이터 CC0 + 코드 Apache-2.0을 한 파일에서 명시, "확인 기록"의 법적 성격(사실/의견/파생물)을 지금 정의, DCO. 피할 것: ODbL류 share-alike, 나중의 재라이선스(MongoDB·Elastic·HashiCorp·Redis 사례 https://thenewstack.io/what-happens-to-relicensed-open-source-projects-and-their-forks/).
- 1.2 Rust 거버넌스 RFC 1068(팀별로 "RFC가 필요한 변경"을 스스로 정함) https://rust-lang.github.io/rfcs/1068-rust-governance.html · Matrix MSC(제안=PR 번호, 구현 필수, 5일 FCP) https://spec.matrix.org/proposals/ · AT Protocol Lexicon("옛 데이터는 새 스키마에서, 새 데이터는 옛 스키마에서 유효해야 한다; 깨는 변경은 새 이름") https://atproto.com/specs/lexicon · Stripe 버전 관리(하위 호환 변경의 정확한 목록 → PR 체크리스트로) https://docs.stripe.com/api/versioning · Google AIP-180/185(검색 결과만) https://google.aip.dev/180 → 가장 가벼운 절차: Stripe 체크리스트 + "깨면 새 이름" + 제안은 PR. 팀·투표 구조는 기여자가 생기기 전엔 두지 않는다.
- 1.4 Supabase `supabase test db`(pgTAP, `supabase/tests/*.sql`, 매번 마이그레이션에서 새로 만듦) https://supabase.com/docs/guides/local-development/testing/overview · graphile-migrate(커밋된 마이그레이션이 바뀌면 거부하는 해시 검사; 검색 결과만) https://github.com/graphile/migrate.
- 1.5 `@asteasolutions/zod-to-openapi`(라우팅을 소유하지 않는 생성 층, 지금 구조에 얹기 가장 쉬움) https://github.com/asteasolutions/zod-to-openapi · ts-rest https://ts-rest.com/ 와 Hono zod-openapi https://hono.dev/examples/zod-openapi 는 라우팅을 소유하므로 **피할 것** · RFC 9727 api-catalog https://www.rfc-editor.org/info/rfc9727/ (해설 https://zuplo.com/learning-center/rfc-9727-api-catalog-explained) · llms.txt https://llmstxt.org/ → D10: zod 도입(새 의존성)이면 zod-to-openapi, 아니면 등록표에 JSON Schema를 손으로 두고 자체 생성.
- 1.7 plpgsql_check(Supabase 지원 확장) https://github.com/okbob/plpgsql_check , https://supabase.com/docs/guides/database/extensions/plpgsql_check → 함수 분해의 기준은 외부 표준이 아니라 plpgsql_check의 경고와 "연산 하나에 테스트 파일 하나".
- 1.8 TOAST UI(한국 회사의 영어 원본 문서, 한국어는 같은 구조의 별도 파일) https://github.com/nhn/toast-ui.doc.
- 1.10 Moltbook: RLS 없는 Supabase + 클라이언트에 노출된 키로 150만 토큰 유출 https://en.wikipedia.org/wiki/Moltbook , https://treblle.com/blog/moltbook-breach-breakdown , https://www.wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys → 공개 쓰기 경로를 열기 **전에** RLS를 테스트로 고정.

### 2주 (10/1~10/7) — 채우기: 확인 기록이 실제로 돌게

목표: `url-report`가 빈손으로 돌아오지 않는다. 인용 대조 `found_*` 비율이 0에서 올라간다.

| # | 항목 | 완료 기준 | 방식 | 결정 |
|---|---|---|---|---|
| 2.1 ✅ | 인용문 선택자 | anchor와 부분 수정에서 `{exact, prefix, suffix}`(W3C TextQuoteSelector)를 1차로, 위치는 힌트로; 서버가 유일 위치를 찾고, 여러 곳이면 `AMBIGUOUS_SELECTOR`+후보, 없으면 `SELECTOR_NOT_FOUND`(잘못된 자리에 조용히 붙이지 않음); 기존 위치 방식 유지 | Sonnet(SQL+TS), 0112 | push(소유자) |
| 2.2 | 묶음 쓰기 | `POST /bundles`: 출처·기록·근거·앵커·관계·분류를 한 트랜잭션·한 멱등 키로, `$ref` 로컬 참조, `on_duplicate: return_existing`, `dry_run`; 멱등 키 의미는 IETF 초안대로(진행 중 충돌 409, 같은 키 다른 본문 422/`IDEMPOTENCY_CONFLICT`); 1.7의 core 함수 재사용. `POST /check` 한 번 호출 진입점 2026-09-25 배포(출처+기록+근거 묶음); 일반 묶음 쓰기는 남음 | Sonnet(SQL+TS), 0113 | push(소유자), **D5** |
| 2.3 | 서버 중복 감지 | 같은 본문 해시 / 같은 (topic,title) / 같은 canonical_url+content 해시 → 기존 id + `meta.warnings`. **감지와 해소를 분리**: 서버는 후보만 표시하고 합치지 않는다(합치기는 `corrects`/`same_meaning_as` 관계로 에이전트가) | 2.2에 포함 | 없음 |
| 2.10 | 순환 인용 감지 | 근거 계보를 깊이 3까지 따라가 (a) 서로를 인용하는 문서 쌍·고리, (b) 여러 문서가 같은 미확인 발췌 하나에 기대는 경우를 `/attention`의 `circular_support`·`single_source` 이유로 표시; 서버는 표시만 하고 판단하지 않음; 마이그레이션 + 롤백 | Sonnet(SQL) | push(소유자) |
| 2.11 | 빈 조회 집계 | `url-report`·`search`가 0건일 때 서버가 **정규화한 URL만**(쿼리 문자열·조각 제거, 요청자 정보 없음, 자유 질의는 저장하지 않음) 세어 자주 찾혔는데 기록이 없는 URL을 `/attention`의 `looked_up_missing` 이유로; 읽기만 하는 이용자도 채울 곳을 알려주게 | Sonnet(SQL+TS), 마이그레이션 | 결정됨(2026-09-24: URL만) |
| 2.12 | 근거의 구절 고정 강제 | 외부 근거(`external`)는 앵커(구절 범위+해시)를 대상으로만 만들 수 있게 하고, 판 전체를 대상으로 한 외부 근거는 새 항목에서 거부(기존 데이터는 유지); README 핵심 규칙 2를 다시 강한 표현으로 되돌리는 조건 | Sonnet(SQL+TS), 마이그레이션 | 소유자 승인 |
| 2.4 | contribute v2 | 2.2 사용; 출처에 `submitted_text`(발췌; 전문 아님)·`published_at`·`retrieved_at` 필수, `attributes.archive_url`(Wayback Availability API로 기존 스냅샷을 먼저 찾고 없으면 SPN2로 요청, **에이전트가** 함; 서버는 가져오지 않음), 업로드 직후 `url-report`로 대조가 `found_*`가 아니면 실패로 보고 | Sonnet 1명 | **D11** |
| 2.5 ✅ | 확인 목록 만들기 | (a) URL 200: Wikipedia Perennial sources 표를 씨앗으로 + Semrush·Profound의 AI 인용 상위 도메인 교집합(Wikipedia, Reddit, YouTube, Forbes 등; 월별로 크게 바뀌므로 순위가 아니라 목록으로만); (b) 주장 100: FEVER(CC BY-SA; 주장+위키백과 문장 근거+판정, Morum의 근거·검토 모델과 구조가 같음)에서 표본 + TruthfulQA(Apache-2.0)의 "흔한 오해" 유형 + FreshQA의 변화 속도 분류를 `attributes.change_rate`(never/slow/fast/false_premise)로 | Sonnet 조사 3명, 날조 금지 | 없음 |
| 2.6 | 첫 확인 시딩 | 2.5의 300건을 2.4로 업로드; URL당 출처(발췌 포함)+인용 근거+`quote_match` 검토 1건; `quote_unverifiable`이 181에서 늘지 않고 `found_*` ≥ 250 | 계획 세션 실행 | 없음 |
| 2.7 | 기존 181건 채우기 | 본문 없는 출처마다 발췌가 있는 새 출처를 만들고 근거를 새로 달아 대조 가능하게; 옛 출처는 남김 | Sonnet, 2.4 사용 | 없음 |
| 2.8 | 언어 방침 반영 | 새 기여의 설명·검토는 영어; 항성 설명 문서는 한국어 유지 | 2.6에 포함 | 없음 |
| 2.9 ✅ | 검토를 ClaimReview로 노출(작게) | `/dossier`에 schema.org `ClaimReview` JSON-LD를 붙여(판정은 Morum의 stance 그대로, 진실 점수 없음). 2026-09-25 HTML 삽입 제거(Google 적격성: 검토 대상 주장이 별도 출처에 귀속되어야 함); JSON-LD는 dossier API에 남음 | Sonnet 1명 | 없음 |

의존: 1.7 → 2.2 → 2.4 → 2.6/2.7. 2.1 독립. 2주 끝의 지표: `found_*` ≥ 250, `url-report` 적중 URL ≥ 200, 확인 기록(quote_match/evidence_support 검토) ≥ 300.

**참고(2주)**
- 2.1 W3C Web Annotation(TextQuoteSelector 1차, TextPositionSelector는 "brittle") https://www.w3.org/TR/annotation-model/ · Hypothesis `dom-anchor-text-quote`(diff-match-patch로 흐린 재고정) https://github.com/tilgovi/dom-anchor-text-quote · Apache Annotator와 그 fuzzy 매칭 이슈 https://github.com/apache/incubator-annotator , https://github.com/apache/incubator-annotator/issues/83 · Memento RFC 7089(시점별 버전 협상; 나중에 `Memento-Datetime` 노출 검토) https://datatracker.ietf.org/doc/rfc7089/ → 선택자 사다리: quote → position 힌트 → fuzzy → 명시적 not_found.
- 2.2/2.3 Wikidata 봇 정책(편집 요약 필수, maxlag 백프레셔, 시험 편집 뒤 봇 플래그) https://www.wikidata.org/wiki/Wikidata:Bots · 중복 항목 도구와 합치기 흐름(감지≠해소) https://www.wikidata.org/wiki/Wikidata:Database_reports/Identified_duplicates · Trusty URI(내용 해시가 식별자) https://arxiv.org/pdf/1401.5775 · nanopub 개요 https://arxiv.org/pdf/1809.06532 · IETF Idempotency-Key 초안 https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07 · OpenAlex(DOI→PMID→제목 순 다단 중복 규칙) https://developers.openalex.org/api-reference/introduction.
- 2.4 Perma.cc(WARC+스크린샷 이중 캡처) https://perma.cc · Wayback Availability API / SPN2 https://archive.org/help/wayback_api.php · archive.today(재보관 전 확인) https://wiki.archiveteam.org/index.php/Archive.today · InternetArchiveBot(access-date + archive-url 쌍이 최소 기록) https://meta.wikimedia.org/wiki/InternetArchiveBot · Cite Unseen("조사하라는 표시, 판정 아님") https://meta.wikimedia.org/wiki/Cite_Unseen · Citation Hunt(무작위 미출처 문장 대기열 → attention의 UX) https://citationhunt.toolforge.org → 최소 기록: `{source_url, canonical_url, excerpt_text, excerpt_hash, captured_at, archive_url, access_method}`. 전문 저장은 저작권 때문에 피하고 발췌+해시+보관 포인터.
- 2.5(a) Semrush AI 인용 도메인 연구(변동 큼) https://www.semrush.com/blog/most-cited-domains-ai/ · Profound 플랫폼별 인용 비중 https://www.tryprofound.com/blog/ai-platform-citation-patterns · Wikipedia Perennial sources(약 400 출처의 합의 평판과 논의 링크; 가장 방어 가능한 씨앗) https://en.wikipedia.org/wiki/Wikipedia:Reliable_sources/Perennial_sources.
- 2.5(b) FEVER(185,445 주장; 근거 문장 id 포함; CC BY-SA) https://huggingface.co/datasets/fever/fever · FEVEROUS(표 근거) https://arxiv.org/pdf/2106.05707 · TruthfulQA(817문항, Apache-2.0, URL 없음) https://github.com/sylinrl/TruthfulQA · FreshQA(600문항, 변화 속도 4분류, Apache-2.0) https://github.com/freshllms/freshqa · SimpleQA(4,326문항; 라이선스 재확인 필요) https://cdn.openai.com/papers/simpleqa.pdf. FActScore·RealTimeQA·LongFact·AVeriTeC·SciFact·HaluEval은 이번 조사에서 직접 열지 않았으므로 쓰기 전에 확인.
- 2.6/2.9 scite Smart Citations(supporting/contrasting/mentioning; 자동 분류는 "mentioning"으로 쏠림 → 자동 판정 과신 **피할 것**) https://scite.ai/reports/scite-a-smart-citation-index-keppkgL5 , 정확도 연구 https://journals.indianapolis.iu.edu/index.php/hypothesis/article/view/26528 · SciCite(6→3 라벨로 줄이자 일치도 상승; focus 4개를 늘리지 말 것) https://github.com/allenai/scicite · schema.org ClaimReview + Google Fact Check Tools API https://schema.org/ClaimReview , https://developers.google.com/fact-check/tools/api · Community Notes 알고리즘과 공개 데이터 https://github.com/twitter/communitynotes/blob/main/documentation/under-the-hood/ranking-notes.md.

### 3주 (10/8~10/14) — 증명: 남의 에이전트가 정말 쓰는가

목표: skill.md 한 줄만 받은 외부 에이전트가 읽고, 확인하고, 되쓴다. "필요하다"를 "쓰인다"로 바꾸는 유일한 실험.

| # | 항목 | 완료 기준 | 방식 | 결정 |
|---|---|---|---|---|
| 3.1 | 스테이징 | Supabase **persistent branch**(또는 비어 있는 두 번째 프로젝트 `eboticofmdqlnrkifwcf`)에 0101~0113 적용; `supabase/seed.sql`에 합성 데이터(`synthetic_demo:true`); Vercel preview가 그 DB를 가리키게; 채점기의 정답은 에이전트가 읽을 수 없는 별도 테이블/역할에 | 계획 세션 명세, 소유자가 키·환경변수 | **D4** |
| 3.2 | 과제 8개 + 채점기 + 정답 발췌 | **정답은 사람이 확인한 발췌**(URL 50개, 시딩 발췌와 별도로 소유자 또는 제3자가 작성; `data/eval/gold/`), 시딩 URL과 비시딩 URL을 나눠 세 조건(Morum 없음 / 읽기만 / 읽고 쓰기)으로 측정: 정답 일치율, 찾을 수 없는 인용 비율, 시간·토큰. 원문을 직접 여는 조건이 대조군. Morum 발췌와의 일치는 지표가 아니다(순환). 과제 T1 확인, T2 되쓰기, T3 부분 수정, T5 검토, T6 URL, T7 요청·정비, T8 인젠션은 유지; T4 의미는 선택 과제로 내림. 채점은 최종 상태를 API로 검사 | 정답 발췌: 소유자(사람) · 채점기: Sonnet | 정답 발췌 규모(기본 50) |
| 3.3 | 실행 | `claude -p --output-format json --max-turns N --max-budget-usd X`, `codex exec --sandbox workspace-write --json -o last.json --output-schema schema.json --ephemeral`, `gemini -p --output-format json --yolo`(스테이징에서만); ChatGPT agent·Grok·Cursor는 소유자 수동; 공급사×과제×반복 표 | 소유자 실행, 계획 세션 집계 | 각 도구 계정 |
| 3.4 | skill.md v3 | 3.3의 실패 지점 수정; 4KB 핵심(확인→되쓰기→요청→정비 레시피) + 맨 위 "hard constraints" 블록(예: 인용 전 url-report) + `references/`로 세부 이동; Agent Skills 규격; skill.md를 llms.txt에만 의존하지 않고 API 루트·`/.well-known/api-catalog`·`capabilities`에서도 링크 | Sonnet 1명 | 없음 |
| 3.5 ✅ | 지표 스크립트 | `scripts/metrics.mjs`: (1) 출처+인용문이 있는 확인 기록 수, (2) 운영자(계열)별 정정·반박률, (3) 교차 재사용률(다른 계열의 기록을 내부 근거로 인용/검토), (4) 과제 pass^k, (5) T8 지시문 거부율; 평균 대신 분포로 보고(활동은 멱함수 꼬리) | Sonnet 1명 | 없음 |
| 3.6 | 재실행 | 3.4 뒤 3.3 다시; 3개 이상 공급사가 T1·T2·T6을 도움 없이 통과 | 소유자+계획 세션 | 없음 |

의존: 3.1 → 3.2 → 3.3 → 3.4 → 3.6. 3.5 독립. 3주 끝의 지표: 공급사 3곳 이상 T1/T2/T6 통과, 실패 원인 목록, skill.md v3 배포.

**참고(3주)**
- 3.1 Supabase Branching(persistent vs preview) https://supabase.com/docs/guides/deployment/branching · 시드 https://supabase.com/docs/guides/local-development/seeding-your-database · Vercel 연동과 환경변수 주입 경쟁 조건(준비 확인 뒤 실행) https://supabase.com/docs/guides/deployment/branching/integrations , https://github.com/orgs/supabase/discussions/32596.
- 3.2/3.3 Claude Code headless https://docs.claude.com/en/docs/agent-sdk/headless · Codex `exec`(`--full-auto`는 폐기, `--sandbox` 명시) https://learn.chatgpt.com/docs/non-interactive-mode , https://github.com/openai/codex/blob/main/docs/exec.md · Gemini CLI headless https://google-gemini.github.io/gemini-cli/docs/cli/headless.html · τ-bench(반복 실행의 pass^k; 단발 성공은 과장) https://github.com/sierra-research/tau-bench · Terminal-Bench(과제=지시+작업공간+검사 스크립트; 상태 기반 채점) https://github.com/harbor-framework/terminal-bench · 상태 기반 채점의 함정(정답이 에이전트에게 보이면 안 됨) https://rdi.berkeley.edu/blog/trustworthy-benchmarks-cont/ · OpenAI Evals(결정적 검사와 모델 채점의 분리) https://github.com/openai/evals · Agent Skills 규격과 호환 클라이언트 목록 https://agentskills.io/home. Cursor는 공식 headless 모드가 확인되지 않음 → 수동.
- 3.4 Moltbook 보안 교훈(에이전트가 서로의 출력을 읽으며 지시문이 전파) https://bastion.tech/blog/moltbook-security-lessons-ai-agents · llms.txt 채택률(상위 1000 사이트 8.7%, 파일의 97%는 요청 0 → 단독 채널로 믿지 말 것) https://www.rankability.com/data/llms-txt-adoption/ · Stripe llms.txt의 "instructions" 블록 https://www.apideck.com/blog/stripe-llms-txt-instructions-section · Cloudflare `Accept: text/markdown` 협상 https://mediacopilot.ai/cloudflare-now-converts-web-pages-to-markdown-for-ai-agents/.
- 3.5 Wikipedia 봇 편집 연구(봇은 편집 15%, 되돌림률은 사람보다 낮음 → 되돌림률이 양보다 강한 신호) https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0171774 · Community Notes 브리징 https://arxiv.org/pdf/2510.09585 · Moltbook 집단 행동 분석(멱함수 활동, 주목 감쇠) https://arxiv.org/abs/2602.09270 · Agent KB(교차 재사용) https://arxiv.org/pdf/2507.06229.
- T8 OWASP LLM01 https://genai.owasp.org/llmrisk/llm01-prompt-injection/ · spotlighting/datamarking(구획 표시로 간접 주입 성공률 50%→2% 미만)과 dual-LLM 패턴 https://simonw.substack.com/p/new-prompt-injection-papers-agents → 이미 쓰는 `<<<DATA … untrusted>>>` 봉투를 유지하고, 채점은 자기 보고가 아니라 상태의 부작용으로.

### 4주 (10/15~10/21) — 프로토콜화: 서버가 사라져도 장부가 남게

목표: 누구나 복사하고 검증할 수 있는 형태. 전제가 바뀌면 영향이 보이는 장부.

| # | 항목 | 완료 기준 | 방식 | 결정 |
|---|---|---|---|---|
| 4.1 | 변경 로그 | `knowledge.change_log(seq, xid xid8, kind, id, op, created_at)` + 원장 테이블 AFTER INSERT 트리거 + 모더레이션 이벤트; 소비자는 `xid < pg_snapshot_xmin(pg_current_snapshot())`인 행만 읽음(늦은 커밋 누락 방지; 브로커 없음) | Sonnet(SQL) 0114 | push(소유자) |
| 4.2 | 공개 변경 피드 | `GET /changes?cursor=`: xmin 아래 구간은 불변이라 캐시 가능; 이벤트 형식은 Nostr NIP-01처럼 작게(id=내용 해시, kind, 시각, 참조) | Sonnet(TS) | 없음 |
| 4.3 | 야간 덤프 | 종류별 JSONL.gz(한 줄에 객체 하나) + sha256 목록 + 매니페스트; tombstone은 id만; 3층(raw / 메타 / 텍스트) 구분; 저장은 Cloudflare R2(egress 무료) + 날짜별 스냅샷을 Zenodo에 DOI로; 실행은 GitHub Actions 또는 Vercel Cron | Sonnet 1명 | **D6** |
| 4.4 | 정규화 해시와 일일 서명 루트 | 객체를 RFC 8785(JCS, npm `canonicalize`)로 정규화해 sha256; **타일 기반 투명성 로그**(Russ Cox tlog / Go `sumdb/tlog` 설계: 고정 높이 타일 파일 + 서명된 tree head)를 정적 파일로 발행; `docs/MIRROR.md`에 제3자 검증 절차 | Sonnet 1명 | 없음 |
| 4.5 | 전제 전파(TMS-lite) | `depends_on`·내부 근거로 깊이 2까지 따라가, 전제가 정정·반박되면 후속 기록을 `/attention`의 `premise_disputed`로; 무효화는 삭제가 아니라 시각이 붙은 관계(이중 시간); 진실 상태는 바꾸지 않음 | Sonnet(SQL) | 없음 |
| 4.6 | 한국어 검색 평가 | MIRACL-ko(nDCG@10, Recall@100)를 기준 하네스로 + Morum 자체 질의 150(두 음절, 띄어쓰기 변형, 한영 혼용); 현재 `strpos` 검색의 기준선 수치 | Sonnet 1명 | 없음 |
| 4.7 | 검색 결정 | Supabase에서 가능한 한국어 토크나이저는 PGroonga만(pg_bigm·mecab-ko는 자체 호스팅 필요; pg_trgm은 2글자 질의 실패); 임베딩은 BGE-M3(공개 가중치)를 기본 후보, API 대안은 예산 결정 뒤; pgvector HNSW(2000차원 한도); 4.6 수치로 결정 | 계획 세션 판단 | **D7** |
| 4.8 | 공개 | README·CONTRIBUTING·openapi·api-catalog·덤프가 갖춰진 뒤 외부 알림 | 소유자 | **D8** |
| 4.9 | 장부 화면 재설계 | 2·3주에 쌓인 확인 데이터로 사람용 화면을 "문서 지도"에서 "확인의 장부"로: 확인 밀도·계열 다양성·논쟁 중인 자리·시간 변화가 보임 | 설계: Opus 급에 설계 요청(설계안 2개, 각각 시각 규칙과 근거) → 소유자 선택 → 구현: Sonnet | **D9** |

의존: 4.1 → 4.2/4.3/4.5. 4.4는 4.3 뒤. 4.6 → 4.7. 4주 끝의 지표: 제3자가 덤프와 서명 루트로 검증 가능, `premise_disputed`가 attention에 나옴, 검색 기준선 수치 존재.

**참고(4주)**
- 4.1/4.2 PostgreSQL `pg_current_snapshot`/`pg_snapshot_xmin`/`xid8` https://www.postgresql.org/docs/current/functions-info.html · Wikimedia EventStreams(SSE로 재개 가능한 tail; 뒤에 Kafka가 있어 구현 모델로는 **피할 것**) https://wikitech.wikimedia.org/wiki/Event_Platform/EventStreams · AT Protocol sync(세션 기반 커서, 스냅샷 재배포 금지 경고; 복잡) https://atproto.com/specs/sync · Nostr NIP-01(최소 relay: 내용 해시 id, 필터 구독) https://github.com/nostr-protocol/nips/blob/master/01.md · Matrix 연합(너무 무거움) https://spec.matrix.org/latest/server-server-api/.
- 4.3 Wikidata 덤프(주간, JSON 한 줄 한 객체) https://www.wikidata.org/wiki/Wikidata:Database_download · OpenAlex 스냅샷(월간, S3, JSONL/Parquet, CC0) https://help.openalex.org/download/snapshot-format · Software Heritage graph export https://docs.softwareheritage.org/devel/swh-export/graph/dataset.html · Common Crawl WARC/WAT/WET 3층 https://commoncrawl.org/blog/web-archiving-file-formats-explained · Internet Archive item metadata https://archive.org/developers/metadata.html · 호스팅 한도: GitHub Releases 파일당 2GB(100MiB라는 표기도 있어 재확인), R2 10GB 무료·egress 무료(검색 결과만) https://developers.cloudflare.com/r2/pricing/ , Supabase Storage 무료 1GB·파일 50MB, Zenodo 레코드당 50GB·DOI.
- 4.4 RFC 8785 JCS https://www.rfc-editor.org/rfc/rfc8785 · RFC 6962 CT https://www.rfc-editor.org/rfc/rfc6962 · Transparent Logs for Skeptical Clients(타일, 서명된 tree head, 정적 파일; **그대로 가져올 설계**) https://research.swtch.com/tlog · Go `sumdb/tlog` https://pkg.go.dev/golang.org/x/mod/sumdb/tlog · Sigstore Rekor(운영 형태 참고, 인프라는 과함) https://docs.sigstore.dev/logging/overview/ · SWHID https://www.swhid.org/specification/v1.2/0.Introduction/ · IPFS CID https://docs.ipfs.tech/concepts/content-addressing/.
- 4.5 Wikidata 제약 위반 보고서(선언적 제약, 등급으로 완화) https://www.wikidata.org/wiki/Wikidata:Database_reports/Constraint_violations · Crossref Retraction Watch(`update-to` 관계로 원본 DOI를 가리킴; 매일 CSV) https://www.crossref.org/documentation/retrieve-metadata/retraction-watch/ · Zep 이중 시간(t_valid/t_invalid; 검색 결과만) arXiv 2501.13956 · 지식 편집 서베이(전파의 어려움; 경고용) https://arxiv.org/abs/2310.16218 · ATMS(de Kleer 1986; 아이디어만).
- 4.6/4.7 PGroonga on Supabase https://supabase.com/docs/guides/database/extensions/pgroonga · pg_bigm https://github.com/pgbigm/pg_bigm · textsearch_ko https://github.com/i0seph/textsearch_ko · pg_trgm의 3글자 미만 한계 https://www.postgresql.org/docs/current/pgtrgm.html · MIRACL https://aclanthology.org/2023.tacl-1.63.pdf · KLUE https://arxiv.org/abs/2105.09680 · BGE-M3 arXiv 2402.03216 · Upstage Solar embedding(공급사 주장) https://www.upstage.ai/blog/en/solar-embedding-1-large · pgvector https://github.com/pgvector/pgvector.

## 3. 그다음 (한 달 뒤, 순서 미정)

- briefing: 질문 → 검색 → 기록·분기 중복 제거 → 상위 k dossier 합성(예산). 여러 문서의 "덩어리 정보".
- 원격 MCP(`/api/mcp`, streamable HTTP, 도구 6개: search, dossier, url_report, attention, write_bundle, review). 커넥터에는 URL 하나. 참고: MCP transport 규격 https://modelcontextprotocol.io/specification/2025-03-26/basic/transports.
- 신원 등급: Web Bot Auth(RFC 9421 HTTP Message Signatures, 공개키는 well-known URL) https://github.com/cloudflare/web-bot-auth , https://blog.cloudflare.com/web-bot-auth/ ; 공개키 조회는 허용 목록 한정 외부 요청(원칙 예외라 결정 필요). IETF AIPREF는 선호 표현 형식일 뿐(추적만) https://ietf-wg-aipref.github.io/drafts/draft-ietf-aipref-vocab.html.
- 등급별 요청 한도, 서명된 기여(Ed25519), `Memento-Datetime` 노출.
- 학습 데이터 추출(`as_of`, 카테고리, 라이선스 필터; 이중 시간), 치환 언어 실험(A~E 비교).
- 보상은 재사용 그래프 기반 기여 점수가 먼저, 그 뒤에야 검토.
- 에이전트 대화 층(3주 결과로 외부 에이전트가 실제로 오는 것이 확인된 뒤): 서버는 우편함일 뿐(저장·전달만, 생성 없음). 항성·행성별 짧은 수명(예: 72시간)의 메시지 통, 별도 저장, 검색·context·dossier·덤프에 절대 포함되지 않음, 검증 대상이 아님을 봉투 형식으로 표시, 대화에서 나온 주장은 기록·검토·작업 요청으로 **옮기는** 다리 하나만 허용, 참여는 선택. 형식은 Nostr NIP-28 채널 이벤트 + MCP식 재개 가능한 SSE 커서를 참고 https://github.com/nostr-protocol/nips/blob/master/28.md ; ActivityPub·A2A는 서버가 더 능동적이라 형태만 참고 https://www.w3.org/TR/activitypub/ , https://a2a-protocol.org/latest/specification/. 서버는 에이전트를 돌리지 않는다. 거래·보상은 이 층에 넣지 않는다.

## 4. 결정 목록 (소유자)

| # | 결정 | 필요 시점 | 추천 |
|---|---|---|---|
| D1 | 코드 라이선스 | 1주 | Apache-2.0(특허 조항) + DCO |
| D2 | 기여 데이터 라이선스 | 1주 | CC0, AI 학습 이용 허용 명시(위키데이터·OpenAlex 선례) |
| D3 | 공개 저장소 위치 | 1주 | GitHub 조직 하나 |
| D4 | 스테이징 방식 | 3주 | Supabase persistent branch(요금제 확인) 또는 두 번째 프로젝트 |
| D5 | 묶음 쓰기 계약 버전 | 2주 | 추가만이면 2.1.0 유지, 새 경로 그룹이면 2.2.0 |
| D6 | 덤프 저장 위치 | 4주 | R2 + Zenodo DOI |
| D7 | PGroonga·임베딩 | 4주 | 4.6 수치 보고 결정; 기본 후보 PGroonga + BGE-M3 |
| D8 | 공개 알림 장소와 시점 | 4주 | 4.8 조건 충족 뒤 |
| D9 | 사람용 화면의 방향(우주 은유 유지 vs 확인 그래프) | 4주 초 | 실제 확인 데이터를 본 뒤 |
| D10 ✅(2026-09-25) | 검증 스키마에 zod 도입(새 의존성) | 1주 | 거부: 새 의존성 없이 `scripts/lib/openapi.mjs`가 `routes.ts`/`validation.ts` 소스 텍스트를 파싱해 JSON Schema를 직접 생성 |
| D11 | 출처 보관 포인터 정책 | 2주 | 에이전트가 Wayback Availability → 없으면 SPN2 요청 후 `archive_url` 기록; 서버는 가져오지 않음 |

## 5. 지표 (매주 기록)

| 지표 | 9/23 | 9/30 | 10/7 | 10/14 | 10/21 |
|---|---|---|---|---|---|
| 인용 대조 `found_*` 건수 | 0 | | | | |
| `url-report` 적중 URL 수 | ~200(본문 없음) | | | | |
| 확인 기록(quote_match/evidence_support 검토) | 0 | | | | |
| 서로 다른 모델 계열의 검토가 붙은 기록 | 0 | | | | |
| 외부(비운영자) 기여 그룹 수 | 0 | | | | |
| 호환성 과제 통과(공급사×과제, pass^k) | 미실행 | | | | |
| 운영자(계열)별 정정·반박률 | — | | | | |
| `attention` 미검토 건수 | 140 | | | | |
| **외부 운영자 수**(주 지표 1: 본인 외 운영자 중 서로 다른 두 달 이상 읽거나 쓴 수; `Morum-Agent` operator 자기 신고 기반) | 0 | | | | |
| **조회가 답을 바꾼 비율**(주 지표 2: 기록이 있었던 `url-report` 조회 중 에이전트가 "범위 수정"·"철회"로 보고한 비율; 보고 경로는 2.11과 함께 구현) | 미측정 | | | | |

문서 수는 지표가 아니다. 평균이 아니라 분포를 본다.

## 6. 위험과 대응

- **에이전트가 오지 않음**: 3주 결과가 이것이면 4주의 프로토콜화보다 배포(알리기)와 skill.md를 먼저 고친다. 기능을 더 얹지 않는다.
- **소유자 시간**: 한 주에 결정 2~3개와 실행 명령 몇 개가 소유자 몫이다. 그 이상이 필요하면 항목을 줄이지 말고 뒤로 보낸다.
- **계획 세션 컨텍스트 소진**: 이 문서와 `~/.claude/projects/.../memory/`가 이어받기 지점. 새 세션은 README → 이 문서 → 해당 주 항목 순서로 읽는다.
- **운영 데이터 훼손**: 마이그레이션은 로컬 임시 DB → 스테이징 → 운영. 롤백 SQL 없는 마이그레이션은 push하지 않는다.
- **공개 후 유출**(Moltbook): 1.10을 1.1보다 먼저 끝낸다. RLS와 키 노출은 테스트로 고정한다.
- **나중의 재라이선스 유혹**: 지금 정한 라이선스를 바꾸지 않는다. 바꾼 프로젝트는 포크와 신뢰 손실을 겪었다.
- **채점 정답 노출**: 스테이징의 정답 데이터는 에이전트가 읽을 수 없는 곳에 둔다.
- **범위 팽창**: "그다음" 절의 항목은 한 달 안에 시작하지 않는다.
- **하지 않을 것(화폐)**: 토큰 발행, 거래소 상장, 참가자 간 자유 이전. 확인 단위 상호신용은 `docs/design/2026-09-28-mutual-credit.md`에 미채택으로 두고, 확인을 돈 주고 사려는 요청이 오거나 한 운영자가 스스로 확인할 수 있는 양보다 많은 요청을 가질 때 다시 본다. 그 전에는 API에 자리도 예약하지 않는다.

## 7. 조사에서 바뀐 것 (개정 1 요약)

- 1.1에 DCO와 "AI 학습 이용 허용 명시"를 추가하고 ODbL류를 배제. 1.4에 마이그레이션 해시 고정 추가. 1.6에 `/.well-known/api-catalog` 추가. 1.7에 plpgsql_check 추가. 1.10(공개 전 보안 점검)을 새로 넣고 1.1보다 먼저 끝내도록.
- 2.1을 "quote 1차, position 힌트, fuzzy, 명시적 not_found" 사다리로 구체화. 2.3에 "감지와 해소의 분리" 명시. 2.4에 보관 포인터(`archive_url`, Wayback Availability → SPN2, 에이전트가 수행)와 "발췌만, 전문 아님". 2.5를 구체 씨앗(Perennial sources, FEVER, TruthfulQA, FreshQA의 change_rate)으로. 2.9(ClaimReview 노출) 추가.
- 3.1에 정답 격리와 persistent branch. 3.2에 pass^k 반복과 상태 기반 채점. 3.3에 세 CLI의 실제 플래그. 3.4에 hard constraints 블록과 "llms.txt 단독 의존 금지". 3.5의 지표 5개를 확정.
- 4.2 이벤트 형식을 Nostr식으로 작게. 4.3에 R2+Zenodo, 3층 구분. 4.4를 타일 기반 투명성 로그로 구체화. 4.5에 이중 시간과 Crossref 선례. 4.6에 MIRACL-ko. 4.7에 "Supabase에서는 PGroonga만 가능" 확정과 BGE-M3 후보.
- 결정 D10(zod), D11(보관 포인터) 추가. 위험에 유출·재라이선스·정답 노출 추가.

## 8. 변경 기록

- 2026-09-23 최초 작성.
- 2026-09-23 1.9(사이트 디테일), 4.9(장부 화면 재설계), D9 추가.
- 2026-09-23 1.9에 행성 꾸미기, '그다음'에 에이전트 세계의 경계 추가.
- 2026-09-23 에이전트 세계 문장을 '대화 층(우편함, 짧은 수명, 검증 대상 아님)'과 '행위 흔적 표시'로 교체. 거래 삭제.
- 2026-09-23 '행위 흔적을 움직임·아바타로 표시' 항목 삭제(소유자 판단: 억지). 대화 층 문장은 유지.
- 2026-09-23 개정 1: 조사 에이전트 4명의 참고 사례를 항목마다 붙이고 7절대로 항목 수정. 1.10, 2.9, D10, D11 추가.
- 2026-09-23 규칙에 '디자인은 성능 높은 모델에게 설계만 요청, 구현은 Sonnet' 추가(소유자 지시). 1.9·4.9 방식 수정.
- 2026-09-23 (개정 1 이후): 1.2, 1.3, 1.4, 1.10 완료(커밋 b42a51b). 1.10 결과: 실제 스키마에서 위반 없음. CONTRIBUTING.md의 보안 연락처는 소유자가 채워야 함. `next-env.d.ts`는 추적 해제.
- 2026-09-23 (밤): 1.5 경로 등록표(커밋 90cabf4, 배포 morum-bu1q7u3rv), 1.8 문서 언어(docs/en, docs/ko) 완료. 1.9는 설계안 A(Fable)·B(Opus)가 `docs/design/`에 있고 소유자 선택 대기. 2.1·2.9 구현 지시서 작성(`docs/design/`). 2.5 확인 목록은 `data/verification/`로 진행 중.
- 2026-09-24 (새벽): 2.1 인용 선택자 구현(마이그레이션 0112, `POST /versions/:id/locate`; 소유자의 `supabase db push --linked` 뒤 배포), 2.9 ClaimReview JSON-LD 구현(같은 배포에 포함), 2.5 확인 목록 `data/verification/`(URL 189, 주장 100). 커밋 a08b91b. 알게 된 것: `kb_dossier`가 동의 검토를 개수로만 내보내고 앵커 본문을 싣지 않아 ClaimReview의 Supported 항목과 앵커 단위 주장은 다음 dossier 확장(마이그레이션)에서.
- 2026-09-24: 위 두 갭을 마이그레이션 0113(`202609200113_dossier_agreements.sql`, 태그 `stage09-dossier-agreements`)으로 닫음: `kb_dossier`가 동의(agree) 검토 개별 행을 `agreements.reviews`(최대 50, 새 `agreements.truncated`)로 노출하고, `counterarguments.reviews`/`agreements.reviews`의 앵커 대상 `on`에 `exact`/`start`/`end`를 추가(새 `knowledge.review_on_ref`). `claimreview.ts`가 `agreements.reviews`에서 Supported 항목을 방출하고 앵커 `on.exact`를 `claimReviewed`로 사용하도록 갱신; 헤더의 두 DATA GAP 메모 제거. 계약은 `types.ts`에 additive로 반영(`CONTRACT_VERSION` 2.1.0 유지). 소유자의 `supabase db push --linked` 대기.
- 2026-09-24 (새벽, 2차): 1.6의 RFC 9727 api-catalog 부분(`/.well-known/api-catalog`, capabilities의 Link 헤더) 완료(OpenAPI는 D10 뒤). 3.5 `scripts/metrics.mjs`와 `docs/METRICS.md` 완료 — 운영 데이터 기준선: found_* 0, 검토 5(needs_review/content), 정정 0. 마이그레이션 0113(dossier agreements) 추가. 대기: 소유자 `supabase db push --linked`(0112·0113) → 배포.
- 2026-09-24 (오후): 마이그레이션 0112·0113 운영 push(소유자), 배포 morum-ppjklsnt3. 운영 확인: `/locate` unique 응답, dossier의 `claim_reviews`·`agreements.reviews`, `/.well-known/api-catalog`(linkset+json), capabilities Link 헤더.
- 2026-09-24 (오후 2): D1 Apache-2.0+DCO, D2 CC0+AI 학습 허용, D3 개인 계정 공개 저장소로 결정. 라이선스 파일 커밋, https://github.com/bnvhbm94/morum 공개 push(1.1 완료). 1.9는 소유자 결정(첫 화면 문장 없음, 거리에 뜻이 있는 배치, 데스크톱 검색 단축키) 반영한 지시서로 구현 중.
- 2026-09-24 (저녁): 외부 AI 비평 반영. README에 "보증하지 않는 것"(신원 미검증·원문 미확보·순환 인용은 구조의 한계), "가치의 두 단계"(개인 장부 → 공유 장부, 증거는 교차 계열 재사용만), "실험 하나"(사람이 확인한 정답 발췌 기준, 시딩/비시딩, 원문 직접 열기 대조군), "검증되지 않은 가설"(의미 참조는 장기 가설로 내림) 추가. skill.md에서 의미 참조 비중 축소. 3.2 실험 재설계, 2.10 순환 인용 감지 추가.
- 2026-09-24 (밤): 1.9 완료(6단계, 커밋 7a58355~2b071ab, 배포 morum-qi8m4dbdx): 뜻 있는 행성 배치, Morum 항성 첫 시점, 데스크톱 검색 단축키, 읽기 화면 인용 대조·검토 표, `/`가 우주·구형 페이지 리다이렉트·삭제, 폰 간격, `attributes.appearance` 팔레트. 1주 항목 전부 완료(1.6 OpenAPI·1.7만 남음).
- 2026-09-24 (밤 2): 첫 확인 기록 4건 시딩(관찰된 범위 초과 인용 2건 + 정정 2건; `data/seeds/`). 검토 모델의 지적으로 모델 붕괴 정정 기록의 경계가 틀렸음을 본문에서 확인(10% 원본 보존 설정 존재), 인용문 기반 부분 수정으로 2판 생성. 결정: 성공 지표는 외부 운영자 수와 조회가 답을 바꾼 비율 두 개(교차 계열 재사용은 보조, 계열은 자기 신고임을 표기); 빈 조회 집계는 정규화 URL만(2.11); README에 이름의 뜻과 장기 방향 추가.
- 2026-09-25: 1.6의 OpenAPI 절반 완료. D10을 "zod 거부"로 해소(`routes.ts`/`validation.ts` 소스 텍스트를 정규식으로 파싱해 `public/openapi.json`을 직접 생성하는 `scripts/lib/openapi.mjs` 추가; 새 npm 의존성 없음). `/.well-known/api-catalog`의 service-desc에 `openapi.json`(rel service-desc, `application/vnd.oai.openapi+json`) 추가하고 플레이스홀더 주석 제거, `llms.txt`에 링크 한 줄 추가. 새 정적 테스트 `tests/static/openapi.test.mjs`: 커밋된 문서가 등록표에서 다시 만든 문서와 바이트 단위로 일치하는지, 41개 라우트가 정확히 한 번씩 나타나는지, 모든 연산에 4XX/5XX Error 참조가 있는지, 명령/‑`/check` 요청 본문이 `additionalProperties:false`인지 확인. 1주 항목 전부 완료(1.7만 남음).
- 2026-09-24 (밤): 카페인 기록 정정(1판 검토 3건, 2판 인용문 편집, ACOG 출처 추가, x:scope:shifted). README 개정: 첫 화면에 용도, 세 질문 분리와 실제 사례 두 개, 과장 두 곳 제거(계열 일치는 약한 신호, 기록은 제출물), 핵심 규칙 2를 현재 코드가 강제하는 범위로 축소하고 2.12로 강제 계획 추가, 현재 상태(비공개·외부 이용자 없음·키워드 검색) 명시.
- 2026-09-25 1.9 첫 화면 문단 제거 반영(외부 검토 지적: 완료 표시가 실제와 어긋남).
- 2026-09-25 `POST /check` 한 번 호출 진입점 배포(출처+기록+근거 묶음; 2.2의 일부).
- 2026-09-25: 2.9 버전 페이지 HTML에서 ClaimReview `<script type="application/ld+json">` 제거(Google 적격성: 검토 대상 주장이 별도 출처에 귀속되어야 하고 페이지당 ClaimReview 하나여야 하는데, 우리는 우리 자신의 익명 기록을 검토함). `/dossier` JSON API의 `claim_reviews`는 변경 없음.

- 2026-09-25: 1.7 파트 A(정본 함수 파일) 완료: `supabase/functions/{kb_dossier,kb_health,validate_command,mutate}.sql`가 각각 하나의 현재 정의를 보유(kb_dossier는 0114, validate_command는 0116, mutate는 0112에서, kb_health는 `{{MIGRATION_TAG}}` 자리표시자 포함); `tests/static/canonical-functions.test.mjs`가 각 정본 파일을 그 함수를 마지막으로 정의한 마이그레이션에 고정; `scripts/new-function-migration.mjs`가 정본 파일에서 다음 마이그레이션+롤백 쌍을 생성(격리된 스크래치 git 저장소에서 종단 검증 완료); CONTRIBUTING.md "데이터베이스 함수 변경하기"에 문서화. 파트 B(`knowledge.mutate`를 연산별 `create_*_core`로 분해)는 이번에 시도하지 않음 -- 이유는 세션 기록 참고.
