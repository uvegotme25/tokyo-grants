/**
 * collect.js — 도쿄 지원금 정보 수집기
 *
 * 1. jGrants 공개 API(디지털청)에서 키워드별로 보조금 목록 수집
 * 2. 신규 항목만 상세 API 호출 → 상세 URL/본문 확보
 * 3. 제목+본문 기반 카테고리 자동 태깅 (예술 여부 포함)
 * 4. 이전 data.json과 diff → 신규 항목 감지
 * 5. docs/data.json 저장 (+ 신규 예술 항목 Telegram 알림, 선택)
 *
 * 실행: node scripts/collect.js
 * 의존성 없음 (Node 18+ 내장 fetch 사용)
 */

const fs = require("fs");
const path = require("path");
const { collectArtsSources } = require("./arts");

const API_BASE = "https://api.jgrants-portal.go.jp/exp/v1/public";
const DATA_PATH = path.join(__dirname, "..", "docs", "data.json");

// ─── 수집 설정 ───────────────────────────────────────────────

// 폭넓게 수집하기 위한 검색 키워드 (jGrants는 keyword 필수)
const SEARCH_KEYWORDS = [
  // 예술·문화 계열
  "文化", "芸術", "アート", "デザイン", "映像", "音楽", "舞台",
  "クリエイティブ", "コンテンツ", "出版", "写真",
  // 일반 계열 (도쿄 전체 지원금 파악용)
  "東京", "創業", "スタートアップ", "デジタル", "IT導入", "イベント",
];

// 대상 지역 필터: 東京都 대상 또는 전국 대상만 남김
const AREA_FILTER = (area) =>
  !area || area.includes("東京都") || area.includes("全国");

// 카테고리 태깅 규칙: 제목/본문에 키워드가 있으면 태그 부여
const CATEGORY_RULES = {
  "예술·문화": ["文化", "芸術", "アート", "美術", "伝統", "工芸"],
  "영상·사진": ["映像", "映画", "写真", "動画", "アニメ"],
  "음악": ["音楽", "コンサート", "ライブ"],
  "공연·무대": ["舞台", "演劇", "ダンス", "公演", "パフォーマンス"],
  "디자인": ["デザイン"],
  "콘텐츠·출판": ["コンテンツ", "出版", "漫画", "マンガ", "ゲーム"],
  "이벤트": ["イベント", "フェス", "祭"],
  "창업": ["創業", "起業", "スタートアップ"],
  "IT·디지털": ["デジタル", "IT", "DX", "AI", "システム"],
  "설비·판로": ["設備", "販路", "展示会", "海外展開"],
};

// "예술 관련"으로 분류할 태그
const ARTS_TAGS = new Set([
  "예술·문화", "영상·사진", "음악", "공연·무대", "디자인", "콘텐츠·출판",
]);

// 1회 실행당 상세 API 호출 상한 (첫 실행 폭주 방지)
const DETAIL_FETCH_LIMIT = 120;
const DETAIL_FETCH_DELAY_MS = 300;

// ─── 유틸 ────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

function tagItem(text) {
  const tags = [];
  for (const [tag, words] of Object.entries(CATEGORY_RULES)) {
    if (words.some((w) => text.includes(w))) tags.push(tag);
  }
  return tags;
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// ─── 수집 ────────────────────────────────────────────────────

async function fetchList(keyword) {
  const params = new URLSearchParams({
    keyword,
    sort: "acceptance_end_datetime",
    order: "ASC",
    acceptance: "1", // 모집중만
  });
  const url = `${API_BASE}/subsidies?${params}`;
  try {
    const json = await getJSON(url);
    return json.result || [];
  } catch (e) {
    console.warn(`⚠ 목록 수집 실패 (${keyword}): ${e.message}`);
    return [];
  }
}

async function fetchDetail(id) {
  try {
    const json = await getJSON(`${API_BASE}/subsidies/id/${id}`);
    return (json.result && json.result[0]) || null;
  } catch (e) {
    console.warn(`⚠ 상세 수집 실패 (${id}): ${e.message}`);
    return null;
  }
}

async function main() {
  // 이전 데이터 로드 (diff용)
  let previous = { items: [] };
  if (fs.existsSync(DATA_PATH)) {
    try {
      previous = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    } catch { /* 손상 시 새로 시작 */ }
  }
  const prevById = new Map(previous.items.map((it) => [it.id, it]));

  // 1) 키워드별 목록 수집 + 중복 제거
  const collected = new Map();
  for (const kw of SEARCH_KEYWORDS) {
    const list = await fetchList(kw);
    console.log(`  「${kw}」 → ${list.length}건`);
    for (const item of list) {
      if (!AREA_FILTER(item.target_area_search)) continue;
      if (!collected.has(item.id)) collected.set(item.id, item);
    }
    await sleep(150);
  }
  console.log(`수집 합계: ${collected.size}건 (도쿄/전국 대상)`);

  // 2) 항목 구성 — 신규 항목만 상세 조회
  const now = new Date().toISOString();
  const items = [];
  let detailCalls = 0;

  for (const [id, raw] of collected) {
    const prev = prevById.get(id);
    let detailUrl = prev?.detailUrl || null;
    let detailText = prev?.detailText || "";

    if (!prev && detailCalls < DETAIL_FETCH_LIMIT) {
      const d = await fetchDetail(id);
      detailCalls++;
      await sleep(DETAIL_FETCH_DELAY_MS);
      if (d) {
        detailUrl = d.front_subsidy_detail_page_url || null;
        detailText = stripHtml(
          [d.detail, d.use_purpose, d.target_search].filter(Boolean).join(" ")
        ).slice(0, 400);
      }
    }

    const tagSource = `${raw.title || ""} ${detailText}`;
    const tags = tagItem(tagSource);

    items.push({
      id,
      title: raw.title || "",
      institution: raw.institution_name || "",
      area: raw.target_area_search || "",
      maxAmount: raw.subsidy_max_limit ?? null,
      start: raw.acceptance_start_datetime || null,
      end: raw.acceptance_end_datetime || null,
      employees: raw.target_number_of_employees || "",
      tags,
      isArts: tags.some((t) => ARTS_TAGS.has(t)),
      detailUrl,
      detailText,
      source: "jGrants",
      firstSeen: prev?.firstSeen || now,
    });
  }

  // 2.5) 예술 조성금 소스 수집 (Claude API 추출, ANTHROPIC_API_KEY 필요)
  console.log("예술 소스 수집 시작…");
  const artsItems = await collectArtsSources({ tagItem, prevById });
  items.push(...artsItems);
  console.log(`예술 소스 합계: ${artsItems.length}건`);

  // 마감일 오름차순 정렬
  items.sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));

  const newItems = items.filter((it) => !prevById.has(it.id));
  console.log(`신규: ${newItems.length}건 / 상세 호출: ${detailCalls}회`);

  // 3) 저장
  const out = {
    updatedAt: now,
    stats: {
      total: items.length,
      arts: items.filter((i) => i.isArts).length,
      new: newItems.length,
    },
    items,
  };
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 2));
  console.log(`저장 완료 → ${DATA_PATH}`);

  // 4) Telegram 알림 (신규 예술 항목이 있을 때만, 토큰 설정 시)
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const newArts = newItems.filter((i) => i.isArts);
  if (token && chatId && newArts.length > 0 && !previousIsEmpty(previous)) {
    const lines = newArts.slice(0, 10).map(
      (i) =>
        `• ${i.title}\n  마감: ${i.end ? i.end.slice(0, 10) : "미정"}${i.detailUrl ? `\n  ${i.detailUrl}` : ""}`
    );
    const text = `🎨 신규 예술 지원금 ${newArts.length}건\n\n${lines.join("\n\n")}`;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      console.log("Telegram 알림 전송 완료");
    } catch (e) {
      console.warn(`⚠ Telegram 전송 실패: ${e.message}`);
    }
  }
}

// 첫 실행(이전 데이터 없음)에는 전체가 신규라 알림 폭주 → 스킵
function previousIsEmpty(previous) {
  return !previous.items || previous.items.length === 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
