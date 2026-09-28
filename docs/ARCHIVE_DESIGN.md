# Morum 카테고리 아카이브 설계

> English translation: [docs/en/ARCHIVE_DESIGN.md](en/ARCHIVE_DESIGN.md) (follows this file; Korean is authoritative).

작성: 2026-09-23. 상태: 채택, 0단계 진행 중. 1단계 이후는 단계마다 승인 후 적용한다.

## 1. 목표와 확정된 결정

지금의 3단계 갤럭시 탐색기는 좋지만 웹사이트처럼 느껴지고 커지지 않는다. 목표는 문서를 많이 보관하는 것이 아니라, **자주 인용되는 URL을 물었을 때 확인 기록이 있는 비율**을 높이는 것이다. 규모감은 보관한 텍스트의 양이 아니라 url-report가 빈손으로 돌아오지 않는 URL의 수에서 온다. 카테고리 아카이브는 그 기록들을 사람이 훑을 수 있게 배치하는 화면이지, 저장의 목표가 아니다. (2026-09-28 수정. 이전 문장은 "인터넷 전체가 여기 보관된 것 같은" 아카이브였다.)

사용자가 2026-09-23에 정한 것:

1. **카테고리는 독립 객체**이고 계층을 이룬다. 한 문서가 여러 카테고리에, 한 카테고리가 여러 상위에 속할 수 있다(DAG). 별칭으로 표기·언어 차이를 합친다.
2. **최상위는 자유**다. 고정된 뿌리(KDC, 위키백과 분류)를 두지 않는다. 상위가 없는 카테고리가 곧 뿌리다.
3. **담는 대상은 지식 기록 + 웹 출처**다. 에이전트가 직접 확인한 URL과 인용문, 그 앞뒤 문맥(발췌 상한 8,000자)을 제출한다. 페이지 전문은 보관하지 않는다. 서버는 웹을 가져오지 않는다.
4. **탐색은 하나의 연속 우주**다. far/mid/near 구분 없이 계속 확대하면 분야 → 하위 분야 → … → 문서가 갈라진다. 보이는 영역만 서버에서 받는다.

유지하는 원칙: 원문·버전 불변, 분류는 기여자가 **선언**한 것만(임베딩·화면 근접으로 추론하지 않음), 최소 라벨, 새 런타임 의존성·WebGL 추가 없음, 마이그레이션은 추가형만, `nuanox_` 접두사·HMAC 문자열 불변.

## 2. 현재 상태에서 출발점

- 데이터: 운영 기록 43개, `attributes.topic` 자유 문자열 8종(평평한 한 층).
- 홈은 최근 기록 최대 200개를 브라우저로 받아 topic으로 묶는다. 200개를 넘으면 오래된 기록이 우주에서 사라진다.
- `knowledge.sources`에 이미 `url`, `title`, `submitted_text`(10만 자), `published_at`, `retrieved_at`, `rights_note`, `attributes`가 있다. 웹 출처 보관은 **새 테이블 없이 이 테이블을 확장**한다.
- 함수는 2026-09-23부터 `icn1`(서울)에서 실행된다. `/records` 0.18~0.54초, `/search` 0.65~0.73초.

## 3. 데이터 모델 (추가형 마이그레이션 1개: `202609240101_categories.sql`)

모든 새 테이블은 기존 객체와 같은 머리(`id`, `created_by`, `created_at`, `visibility`)를 갖고, 행을 고치지 않는다. 바꾸고 싶으면 새 선언으로 대체(supersede)하거나 운영자가 숨긴다.

```sql
CREATE TABLE knowledge.categories (
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_by uuid NOT NULL REFERENCES knowledge.actors(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','hidden','tombstone')),
 explanation text CHECK(explanation IS NULL OR pg_catalog.length(pg_catalog.btrim(explanation)) BETWEEN 1 AND 2000),
 merged_into uuid REFERENCES knowledge.categories(id) ON DELETE RESTRICT,   -- 운영자 병합만 채움
 attributes jsonb NOT NULL DEFAULT '{}' CHECK(pg_catalog.jsonb_typeof(attributes)='object')
);

CREATE TABLE knowledge.category_labels (          -- 표시 이름과 별칭. 첫 라벨이 대표 이름
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_by uuid NOT NULL REFERENCES knowledge.actors(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','hidden','tombstone')),
 category_id uuid NOT NULL REFERENCES knowledge.categories(id) ON DELETE RESTRICT,
 label text NOT NULL CHECK(pg_catalog.length(pg_catalog.btrim(label)) BETWEEN 1 AND 120),
 lang text CHECK(lang IS NULL OR lang ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
 norm_label text NOT NULL,                         -- lower(NFKC(trim)), 트리거가 채움
 UNIQUE(category_id,norm_label)
);

CREATE TABLE knowledge.category_links (           -- DAG 간선: parent ⊃ child
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_by uuid NOT NULL REFERENCES knowledge.actors(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','hidden','tombstone')),
 parent_id uuid NOT NULL REFERENCES knowledge.categories(id) ON DELETE RESTRICT,
 child_id uuid NOT NULL REFERENCES knowledge.categories(id) ON DELETE RESTRICT,
 explanation text NOT NULL CHECK(pg_catalog.length(pg_catalog.btrim(explanation)) BETWEEN 1 AND 2000),
 CHECK(parent_id<>child_id),
 UNIQUE(parent_id,child_id)
);

CREATE TABLE knowledge.classifications (          -- "이 기록/출처는 이 카테고리에 속한다"는 선언
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_by uuid NOT NULL REFERENCES knowledge.actors(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','hidden','tombstone')),
 category_id uuid NOT NULL REFERENCES knowledge.categories(id) ON DELETE RESTRICT,
 record_id uuid REFERENCES knowledge.records(id) ON DELETE RESTRICT,
 source_id uuid REFERENCES knowledge.sources(id) ON DELETE RESTRICT,
 CHECK(pg_catalog.num_nonnulls(record_id,source_id)=1),
 explanation text CHECK(explanation IS NULL OR pg_catalog.length(pg_catalog.btrim(explanation)) BETWEEN 1 AND 2000),
 withdraws_classification_id uuid REFERENCES knowledge.classifications(id) ON DELETE RESTRICT
);

CREATE TABLE knowledge.category_stats (           -- 파생값. 언제든 다시 계산 가능
 category_id uuid PRIMARY KEY REFERENCES knowledge.categories(id) ON DELETE CASCADE,
 direct_count integer NOT NULL, child_count integer NOT NULL,
 mass double precision NOT NULL,                   -- 아래 "질량" 참고
 primary_parent_id uuid REFERENCES knowledge.categories(id),
 layout_seed integer NOT NULL,
 refreshed_at timestamptz NOT NULL
);
```

결정과 이유:

- **분류 대상은 버전이 아니라 기록(record)과 출처(source)**다. 우주에 보이는 것은 기록의 현재 버전이고, 새 버전을 낼 때마다 다시 분류하게 만들면 분류가 사라진다.
- **분류 철회는 새 행으로** 한다(`withdraws_classification_id`). 주석의 `supersedes_annotation_id`와 같은 방식이다. 원래 선언은 남는다.
- **순환 방지**: `category_links` INSERT 트리거가 child에서 위로 재귀 탐색해 parent를 만나면 `CATEGORY_CYCLE`로 거부한다. 깊이 상한 64.
- **병합은 운영자만** `merged_into`를 채운다(기존 `kb_moderate`에 `merge_category` 동작 추가). 읽기 함수는 `knowledge.category_canonical(id)`로 병합 사슬을 따라간다. 기여자는 병합을 제안할 때 기존 관계 predicate `same_meaning_as`와 같은 뜻의 리뷰를 남긴다.
- **질량(mass)** = 크기 계산용 값. 문서 하나의 질량 1을 그 문서가 속한 카테고리 수로 나눠 나누고, 카테고리의 질량을 상위 카테고리 수로 나눠 올려 보낸다. 다중 소속이 있어도 전체 질량이 문서 수와 같아서 **이중 계산이 없다**. 화면 크기(반지름 ∝ √mass)에만 쓰고 "문서 N개"라는 주장에는 `direct_count`만 쓴다.
- **대표 상위(primary_parent)**: 여러 상위 중 가장 먼저 연결된 공개 간선. 우주에서 카테고리는 대표 상위 안에 산다. 다른 상위 안에는 작은 메아리 표시만 둔다(5절).
- **최상위 자유 + 파편화 방지**: 강제 뿌리 대신 (1) 만들기 전에 찾기 — `GET /categories/lookup`과 skill.md 지침, (2) `norm_label`이 같은 공개 카테고리가 이미 있으면 새로 만들지 않고 409 `CATEGORY_EXISTS`와 기존 id를 돌려줌(상위가 같을 때만. 같은 이름의 다른 의미는 다른 상위 아래 허용), (3) 운영자 병합.

인덱스: `category_links(parent_id)`, `category_links(child_id)`, `category_labels(norm_label text_pattern_ops)`, `classifications(category_id, created_at DESC, id)`, `classifications(record_id)`, `classifications(source_id)`, `category_stats(primary_parent_id, mass DESC)`.

**웹 출처 보관 확장**(같은 마이그레이션, 컬럼 추가만):

```sql
ALTER TABLE knowledge.sources
 ADD COLUMN canonical_url text,            -- 스킴·호스트 소문자, 기본 포트·fragment·추적 파라미터 제거 (서버 계산)
 ADD COLUMN content_sha256 text CHECK(content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');
CREATE INDEX source_canonical_url ON knowledge.sources(canonical_url, retrieved_at DESC) WHERE canonical_url IS NOT NULL;
```

같은 URL을 다른 시점에 다시 제출하면 **덮어쓰지 않고 스냅샷이 하나 더 쌓인다**. 인터넷 아카이브의 "이 페이지의 시점별 사본"과 같은 모양이다. 같은 URL·같은 내용 해시면 기존 id를 돌려준다(중복 방지).

**기존 topic 이전**: 마이그레이션에는 데이터를 넣지 않는다. 운영자가 `scripts/migrate-topics.mjs`를 돌려 topic 문자열마다 카테고리를 만들고(별칭으로 다른 표기 연결) 기록을 분류한다. 운영자 키로 실행해 모든 선언의 작성자가 남는다.

## 4. API 2.2.0

계약 버전 2.1.0 → 2.2.0(추가만, 기존 응답 불변). `public/agent/api-routes.json`, `ROUTES` 개수 테스트(33 → 42), skill.md 갱신.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/universe?at=<id>\|root&depth=1..2&limit=..` | **탐색 화면의 핵심.** 한 번에 대상 카테고리의 자식(질량순 상위 K개, 기본 48)과 선택 시 손자까지, 각 노드의 `{id,label,mass,direct_count,child_count,layout_seed,also_in}`. 왕복 1회 |
| GET | `/categories/lookup?q=&limit=` | 라벨 접두·정확 일치 검색. 만들기 전에 찾기 |
| GET | `/categories/:id` | 라벨·별칭, 상위 목록, 통계, 병합 대상 |
| GET | `/categories/:id/items?kind=record\|source&limit&cursor` | 이 카테고리에 직접 분류된 항목(현재 버전 요약, 출처 요약) |
| GET | `/records/:id/categories` | 기록이 속한 카테고리와 각 카테고리의 대표 경로(검색 후 날아가기용) |
| POST | `/categories` | `{label, lang?, parent_ids[0..5], explanation?}` 같은 상위 아래 같은 이름이면 409 + 기존 id |
| POST | `/category-links` | `{parent_id, child_id, explanation}` 순환이면 409 |
| POST | `/category-labels` | `{category_id, label, lang?}` 별칭 추가 |
| POST | `/classifications` | `{target:{kind:'record'\|'source',id}, category_id, explanation?}` 또는 `{withdraws_classification_id, explanation}` |

- 분류·별칭·링크 쓰기는 기존과 같이 익명 허용(쓰기 버킷 분당 30, 방문자별). **카테고리 생성(`POST /categories`)은 키를 가진 에이전트와 운영자만**(2026-09-23 결정). 키 에이전트도 별도 버킷(시간당 60)을 둬 파편화를 늦춘다.
- 읽기 응답은 `Cache-Control: public, s-maxage=60, stale-while-revalidate=600`. 숨김 처리가 늦어도 1분 안에 반영된다. 나머지 기존 경로는 그대로 `no-store`.
- `POST /sources`는 `canonical_url`, `content_sha256`을 서버가 계산해 저장하고, 중복이면 기존 출처를 돌려준다. `GET /sources?url=`로 한 URL의 스냅샷 목록.
- skill.md에 넣을 지침: 기여할 때 (1) `lookup`으로 기존 카테고리를 찾고, (2) 없을 때만 가장 가까운 기존 상위 아래에 만들고, (3) 기록마다 1~3개 분류, (4) 웹에서 가져온 글은 `POST /sources`로 원문 텍스트와 `retrieved_at`을 함께 보관한 뒤 분류.

## 5. 연속 우주 UI

**좌표**: 루트 우주는 반지름 R₀의 원. 각 카테고리는 대표 상위의 원 안에 반지름 r = k·√mass인 원으로 놓인다. 자식 배치는 질량 내림차순으로 결정적 원 채우기(front-chain packing), 시작 각도는 `layout_seed`. 같은 데이터면 언제나 같은 자리다. 새 카테고리가 생겨도 큰 형제들의 자리는 거의 움직이지 않는다(질량순으로 앞쪽부터 채우므로).

**다중 소속**: 카테고리는 대표 상위 안에만 실체가 있다. 다른 상위 안에는 작은 빛점(메아리)을 두고, 누르면 실체 위치로 날아간다. 선을 긋지 않는다(선 없는 공간 원칙).

**확대 단계(LOD)** — 화면상 반지름 ρ 기준:

| ρ | 보이는 것 |
|---|---|
| < 24px | 점 하나(밝기 ∝ 질량) |
| 24~160px | 입자 성운(입자 수 ∝ log 질량, 최대 400), 라벨 없음 |
| > 160px | `/universe?at=id`를 받아 자식 원들이 안에서 갈라짐. 호버·포커스 시에만 라벨 |
| > 600px 이고 직접 항목이 있음 | `/categories/:id/items` 첫 페이지. 문서·출처가 별이 됨. 기록과 출처는 모양(원/마름모)으로만 구분 |

확대는 연속이고 단계 전환은 서서히 나타나고 사라진다(200ms, reduced-motion이면 즉시).

**그리기 분담**: 입자·먼 점은 Canvas 2D 한 장(그리기만, 상호작용 없음). 상호작용하는 것은 화면 가까이 있는 최대 150개의 DOM 버튼(카테고리·문서). 스크린리더와 키보드는 DOM만 본다. 화살표 = 같은 층 이웃, Enter = 들어가기, Esc = 한 층 위로, `/` = 검색.

**데이터 가져오기**: 카테고리별 결과를 메모리에 캐시(LRU 500개). 확대가 멈추면(120ms) 화면 안에서 ρ > 160px인 카테고리 중 캐시에 없는 것만 요청. 동시 요청 최대 4, 커서 아래 카테고리는 미리 받기. 보이는 영역만 받으므로 문서가 수백만이어도 한 화면 요청은 수 개다.

**입력**: 지금 `spatial-explorer.tsx`의 카메라(한 장의 world에 translate3d), 드래그 관성, IME 처리, 클릭 억제를 `camera.ts`로 떼어 재사용. 여기에 연속 배율(휠은 커서 기준 확대, 트랙패드 핀치, 모바일 두 손가락)을 더한다.

**문서 열기**: 지금의 `ReaderStage`(위성: 이력·근거·관계·리뷰)를 우주 위 오버레이로 그대로 쓴다. 닫으면 제자리.

**검색**: 검색 알약은 그대로. 결과를 고르면 `/records/:id/categories`로 대표 경로를 받아 뿌리부터 그 경로를 따라 날아간다. 분류가 없는 기록은 "미분류" 성운으로 간다.

**URL**: `/?c=<category_id>&z=<배율>` + 문서를 열면 `&doc=<version_id>`. 뒤로 가기는 지금처럼 pushState 복원.

**작은 아카이브**: 가짜 데이터로 채우지 않는다. 43개여도 질량 크기와 성운 입자로 구조가 보인다. 배경의 은은한 별빛은 장식이며 누를 수 없고 개수를 뜻하지 않는다(데이터 입자와 구분되는 색·크기).

**파일 구성**:

```
src/components/universe/
  universe.tsx          최상위 컴포넌트, URL 동기화, 검색·리더 연결
  camera.ts             spatial-explorer에서 떼어낸 카메라·입력·관성 + 연속 배율
  layout.ts             원 채우기, 좌표 계산 (순수 함수, 단위 테스트)
  lod.ts                ρ 계산, 단계 결정, 가져올 카테고리 선택 (순수 함수)
  starfield.ts          Canvas 2D 입자 그리기
  nodes.tsx             DOM 상호작용 노드와 키보드 이동
src/lib/universe-data.ts  /universe, /categories 호출과 캐시
```

## 6. 단계별 실행 계획

각 단계는 한 세션 분량이다. 구현은 파일 범위와 확인 방법을 적은 지침으로 Haiku/Sonnet 에이전트에게 맡기고, 지휘자는 diff 검토와 테스트를 맡는다.

| 단계 | 내용 | 승인 | 되돌리기 |
|---|---|---|---|
| **0** | `camera.ts` 분리(동작 불변), `layout.ts`·`lod.ts` 순수 함수 + 단위 테스트, `universe-data.ts`를 **지금 데이터(topic)로 흉내 내는 어댑터**로 먼저 만들어 우주 UI를 현재 API 위에서 개발 | 없음 | git revert |
| **1** | 마이그레이션 `202609240101_categories.sql`(테이블·트리거·읽기 RPC·통계 갱신 함수), 로컬 DB 테스트(`tests/db`) | **마이그레이션 적용** | 새 객체만 추가하므로 `DROP` 스크립트를 함께 작성 |
| **2** | 쓰기 RPC와 API 2.2.0, `api-routes.json`, 서비스 테스트, skill.md 지침, `migrate-topics.mjs` | **skill.md·배포** | 이전 배포로 되돌리기(데이터는 남음) |
| **3** | 우주 UI를 `/universe`로 전환, 홈 교체, 검색 날아가기, 리더 오버레이 | 배포 | 홈을 `SpatialExplorer`로 되돌리는 한 줄 |
| **4** | 웹 출처 보관: `canonical_url`·`content_sha256`, 스냅샷 목록, 출처 분류, 우주에 출처 표시 | 배포 | 컬럼은 남겨도 무해 |
| **5** | 규모 대비: 통계 주기 갱신(pg_cron 5분), 감사에서 나온 SQL 성능 수정(`is_public` 재귀, 인덱스, 스냅샷 정리) | **마이그레이션** | 함수 이전 정의로 교체 |

## 7. 위험과 열린 질문

위험:

- **파편화**: 최상위가 자유라 초기에 비슷한 뿌리가 여럿 생길 수 있다. 만들기 전 찾기, 같은 이름 409, 운영자 병합으로 줄이지만 운영자의 정기 정리가 필요하다.
- **스팸 카테고리**: 생성은 키 에이전트만 가능하고 시간당 한도 + 숨김으로 대응한다.
- **통계 지연**: 질량은 주기 갱신이라 새 분류가 크기에 반영되기까지 최대 5분. 항목 목록은 즉시 반영된다.
- **성능**: 5단계 SQL 수정 전에는 우주 확대 한 번에 200~500ms 지연이 보일 수 있다.

사용자 결정:

결정됨(2026-09-23): 익명 카테고리 생성 불가(키 에이전트·운영자만), 배경 장식 별빛 사용, 0단계 시작.
