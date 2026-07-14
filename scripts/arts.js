/**
 * arts.js — 예술 조성금 소스 수집기
 *
 * 각 소스 페이지의 HTML을 가져와 텍스트로 변환한 뒤,
 * Claude API(Haiku)로 "모집중인 조성금" 정보를 구조화 추출한다.
 * 사이트별 스크래퍼가 필요 없어서 레이아웃 변경에 강하고,
 * 소스 추가는 아래 SOURCES에 URL 한 줄이면 됨.
 *
 * 필요 환경변수: ANTHROPIC_API_KEY (없으면 이 모듈은 조용히 스킵)
 */

const crypto = require("crypto");

// ─── 예술 조성금 소스 목록 ──────────────────────────────────
// url은 각 기관의 "공모/조성 정보" 페이지로 조정 가능
const SOURCES = [
  { name: "ネットTAM",            url: "https://www.nettam.jp/funding/" },
  { name: "アーツカウンシル東京", url: "https://www.artscouncil-tokyo.jp/ja/what-we-do/support/grants/" },
  { name: "東京都生活文化局",     url: "https://www.seikatubunka.metro.tokyo.lg.jp/bunka/katsu_shien/0000000629" },
  { name: "文化庁",               url: "https://www.bunka.go.jp/shinsei_boshu/kobo/" },
  { name: "セゾン文化財団",       url: "https://www.saison.or.jp/" },
  { name: "野村財団",             url: "https://www.nomurafoundation.or.jp/" },
  { name: "朝日新聞文化財団",     url: "https://www.asahizaidan.or.jp/" },
];

const MODEL = "claude-haiku-4-5-20251001";
const GEMINI_MODEL = "gemini-2.5-flash-lite"; // 무료 티어 모델
const MAX_PAGE_CHARS = 16000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // 링크는 URL을 살려서 텍스트화 → Claude가 상세 URL을 추출할 수 있게
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, " $2 [$1] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; grants-board/1.0)",
      Accept: "text/html",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function buildPrompt(sourceName, sourceUrl, pageText) {
  return `以下は「${sourceName}」(${sourceUrl}) のウェブページのテキストです。
このページに掲載されている、芸術・文化分野の助成金/補助金/公募プログラムを抽出してください。

ルール:
- 現在募集中、またはこれから募集予定のものだけを対象にする（募集終了は除外）
- 助成金・公募でないもの（ニュース、イベント告知、コラム等）は除外
- 情報が1件もなければ空配列 [] を返す
- 必ずJSON配列のみを返す。前置き・後置き・マークダウン記法は一切不要

各項目のフォーマット:
{
  "title": "プログラム名",
  "organization": "実施団体名（不明なら"${sourceName}"）",
  "deadline": "申請締切をISO形式 YYYY-MM-DD で。不明なら null",
  "amount": 助成上限額を円の数値で。不明なら null,
  "url": "詳細ページのURL（テキスト中の [URL] から。無ければ "${sourceUrl}"）",
  "summary": "対象・内容の要約（日本語、100字以内）"
}

--- ページテキスト ---
${pageText.slice(0, MAX_PAGE_CHARS)}`;
}

function parseJsonArray(text, sourceName) {
  try {
    const arr = JSON.parse(text.replace(/```json|```/g, "").trim());
    return Array.isArray(arr) ? arr : [];
  } catch {
    console.warn(`⚠ ${sourceName}: JSON 파싱 실패`);
    return [];
  }
}

async function extractWithClaude(sourceName, sourceUrl, pageText, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: buildPrompt(sourceName, sourceUrl, pageText) }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return parseJsonArray(text, sourceName);
}

// Gemini 무료 티어 (Google AI Studio에서 키 발급, 카드 등록 불필요)
async function extractWithGemini(sourceName, sourceUrl, pageText, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(sourceName, sourceUrl, pageText) }] }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n");
  return parseJsonArray(text, sourceName);
}

/**
 * 예술 소스 전체 수집 → collect.js의 item 포맷으로 반환
 */
async function collectArtsSources({ tagItem, prevById }) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  let extract;
  if (geminiKey) {
    extract = (n, u, t) => extractWithGemini(n, u, t, geminiKey);
    console.log("추출 엔진: Gemini (무료 티어)");
  } else if (claudeKey) {
    extract = (n, u, t) => extractWithClaude(n, u, t, claudeKey);
    console.log("추출 엔진: Claude Haiku");
  } else {
    console.log("ℹ GEMINI_API_KEY / ANTHROPIC_API_KEY 없음 → 예술 소스 수집 스킵 (jGrants만 수집)");
    return [];
  }

  const now = new Date().toISOString();
  const items = [];

  for (const src of SOURCES) {
    try {
      const html = await fetchPage(src.url);
      const text = htmlToText(html);
      if (text.length < 200) {
        console.warn(`⚠ ${src.name}: 본문이 거의 없음 (JS 렌더링 페이지일 수 있음)`);
        continue;
      }
      const extracted = await extract(src.name, src.url, text);
      console.log(`  ${src.name} → ${extracted.length}건`);

      for (const g of extracted) {
        if (!g.title) continue;
        // 소스+제목 기반 안정적 ID (재실행해도 동일 항목은 동일 ID)
        const id = "arts-" + crypto
          .createHash("sha1")
          .update(`${src.name}|${g.title}`)
          .digest("hex")
          .slice(0, 12);
        const prev = prevById.get(id);
        const tags = tagItem(`${g.title} ${g.summary || ""}`);
        if (!tags.includes("예술·문화")) tags.unshift("예술·문화");

        items.push({
          id,
          title: g.title,
          institution: g.organization || src.name,
          area: "",
          maxAmount: typeof g.amount === "number" ? g.amount : null,
          start: null,
          end: g.deadline ? `${g.deadline}T23:59:59+09:00` : null,
          employees: "",
          tags,
          isArts: true,
          detailUrl: g.url || src.url,
          detailText: g.summary || "",
          source: src.name,
          firstSeen: prev?.firstSeen || now,
        });
      }
    } catch (e) {
      console.warn(`⚠ ${src.name} 수집 실패: ${e.message}`);
    }
    await sleep(500);
  }
  return items;
}

module.exports = { collectArtsSources, SOURCES };
