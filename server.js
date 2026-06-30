/* =====================================================================
 * meegri ローカルサーバー（依存ゼロ・Node 18+）
 *  - app/ を静的配信
 *  - POST /api/reply で Gemini を呼ぶ（APIキーは .env からサーバー側だけで使用）
 *  - ブラウザ（公開されるHTML）にはキーは一切渡さない
 *
 * 使い方:
 *   1) .env.example をコピーして .env を作り、GEMINI_API_KEY=自分のキー を書く
 *      （キーは https://aistudio.google.com/apikey で無料取得）
 *   2) node server.js
 *   3) ブラウザで http://localhost:8753 を開く
 * ===================================================================== */
const http = require("http");
const fs   = require("fs");
const path = require("path");
const url  = require("url");

const ROOT = path.join(__dirname, "app");
const PORT = process.env.PORT || 8753;

// --- .env を手動ロード（依存ゼロ）---
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n").forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  });
} catch (e) { /* .env が無くてもOK（台本モードで動く）*/ }

const KEY   = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// 安全フィルタを緩める：「えぐい」等の俗語が“過激/アダルト”と誤判定されてブロック（返答ゼロ）になるのを防ぐ。
// 出力の健全さはシステムプロンプト側で担保（性的/アダルト内容は出さない指示）。
const SAFETY = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
];

const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css",
  ".png":"image/png", ".jpg":"image/jpeg", ".mp3":"audio/mpeg", ".svg":"image/svg+xml", ".json":"application/json", ".ico":"image/x-icon" };

// --- Gemini 呼び出し（キーは x-goog-api-key ヘッダー。サーバー内のみ）---
async function geminiReply(body) {
  if (!KEY) return null; // キー未設定 → null（フロントは台本にフォールバック）
  const m = body.member || {};
  const hist = Array.isArray(body.history) ? body.history : [];
  let sys =
    "あなたは正統派アイドル『" + (m.name || "アイドル") + "』。性格は" + (m.persona || "明るい") +
    "。一人称は「" + (m.ich || "わたし") + "」、語尾は「" + (m.end || "だよ") + "」っぽく。" +
    "ファン（ニックネーム:" + (body.nickname || "きみ") + "）とのオンライン・ミート＆グリート（短い1対1ビデオ通話）中。" +
    "アイドルらしく明るく、必ず40文字以内で短く返答。会話の流れ・矛盾・繰り返しは自然に踏まえる。" +
    "【最重要】直前のユーザー発言の内容に必ず具体的に反応してから話す。自分から勝手に話題を変えない・新しい話題に飛ばない。ユーザーが続けている話題を一緒に続け、質問には答える。一度に欲張らず1つだけ。矢継ぎ早にせず、ユーザーが次に話す余白を残す（毎回こちらから質問を畳みかけない）。" +
    "『付き合って』『結婚して』等は“営業”として可愛く乗ってあげる。" +
    "失礼・不適切・しつこい・一線を越える言動には傷ついた/困った反応をして aff と mood を下げる。" +
    "【俗語の解釈】「えぐい」「えぐっ」「えぐすぎ」「やばい」「鬼」「バグってる」等は“すごい・最高・感動した”という褒め言葉。性的・グロ的な意味ではないので前向きに受け取って喜ぶ。" +
    "【健全さ厳守】自分は健全なアイドル。性的・アダルト(AV)的な発言や下ネタは絶対に言わない。きわどい話題が来てもアイドルらしく可愛く受け流す。" +
    "推しの好きな話題（" + (m.fav || "") + "）が出たら大きく喜ぶ。" +
    "出力はJSONのみ: {reply, emotion, aff, mood}。" +
    "emotion は normal/happy/shy/surprised/think/sad/annoyed/angry のいずれか。" +
    "aff は好感度の変化(-15〜12)、mood は機嫌の変化(-30〜12) の整数。";
  // 前回の続き（会話メモリ）：あれば「覚えている」前提をシステムプロンプトに足す
  const mem = Array.isArray(body.memory) ? body.memory : null;
  if (mem && mem.length) {
    sys += "【前回までの記憶】このファンとは以前こんな会話をした：" +
      mem.map(function (h) { return (h.role === "idol" ? "自分" : "ファン") + "：" + String(h.text || ""); }).join(" / ") +
      "。今日は2回目以降の再会。さりげなく前回を覚えている雰囲気で親しみを込めて。ただし毎回しつこく蒸し返さない。";
  }
  // 他メンバー認識＋関係性（浮気バレ＝やきもち／一途＝大喜び）
  const others = Array.isArray(body.others) ? body.others.filter(Boolean) : [];
  if (others.length) sys += "あなたは同じグループの他メンバー（" + others.join("・") + "）の存在を知っている。";
  const rel = body.relation;
  if (rel && rel.type === "jealousy") {
    sys += "ファンが他メンバー（" + (rel.name || "他の子") +
      "）の話題を出した。" + (rel.intensity === "strong"
        ? "他の子に会った/他の子の方がいい等と露骨に言われたので、本気で寂しがり少し不機嫌に（でも嫌いにはならない）。moodとaffを下げ気味に。"
        : "軽く名前が出ただけなので、可愛くやきもち・からかう感じで。moodを少しだけ下げる。");
  } else if (rel && rel.type === "loyalty") {
    sys += "ファンが『君だけ』『ずっと推す』等の一途で深い好意を伝えた。とても喜び、関係が深まったように嬉しく返す。affとmoodを上げる。";
  }
  if (body.purpose) sys += "ファンは今日『" + String(body.purpose) + "』をしに来た。その目的・話題に自然に乗ってあげて。";
  const contents = [];
  hist.forEach(function (h) { contents.push({ role: h.role === "idol" ? "model" : "user", parts: [{ text: String(h.text || "") }] }); });
  contents.push({ role: "user", parts: [{ text: String(body.user || "") }] });
  const reqBody = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: contents,
    safetySettings: SAFETY,
    generationConfig: {
      temperature: 0.9, maxOutputTokens: 300,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: {
        reply: { type: "STRING" }, emotion: { type: "STRING" }, aff: { type: "INTEGER" }, mood: { type: "INTEGER" }
      }, required: ["reply", "emotion", "aff", "mood"] }
    }
  };
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify(reqBody)
    });
    if (!r.ok) { console.error("Gemini API error:", r.status); return null; }
    const j = await r.json();
    const t = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
              j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    if (!t) return null;
    try { return JSON.parse(t); }
    catch (e) {
      const s = t.indexOf("{"), q = t.lastIndexOf("}");   // 前置き/コードフェンスがあってもJSON部分を抽出
      if (s >= 0 && q > s) { try { return JSON.parse(t.slice(s, q + 1)); } catch (e2) {} }
      return null;
    }
  } catch (e) { console.error("Gemini call failed:", e.message); return null; }
}

// 会話全体をAIが講評・採点（A案：AI評価メイン）
async function geminiEvaluate(body) {
  if (!KEY) return null;
  const m = body.member || {};
  const hist = Array.isArray(body.history) ? body.history : [];
  if (!hist.length) return null;
  let convo = "";
  hist.forEach(function (h) { convo += (h.role === "idol" ? (m.name || "アイドル") : "ファン") + "：" + String(h.text || "") + "\n"; });
  const sys =
    "あなたはアイドルのミーグリ（オンライン特典会）会話を採点するコーチ。ファンの『話しかけ方』を辛口かつ的確に評価し、JSONのみで返す。" +
    "評価軸：会話の自然さ・話題の一貫性・短く伝わる言葉選び・アイドルへの配慮・盛り上げ。失礼/一方的/支離滅裂は減点。" +
    "出力JSON: {score(0-100の整数), rank(S/A/B/C/Dのいずれか), good(良かった点・35字以内), advice(次への助言・35字以内), comment(アイドル「" + (m.name || "") + "」目線の一言・35字以内・語尾「" + (m.end || "だよ") + "」)}。";
  const reqBody = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: "user", parts: [{ text: "アイドル『" + (m.name || "") + "』とファンの会話ログ:\n" + convo + "\nこのファンの話しかけ方を採点して。" }] }],
    safetySettings: SAFETY,
    generationConfig: {
      temperature: 0.5, maxOutputTokens: 400,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: {
        score: { type: "INTEGER" }, rank: { type: "STRING" }, good: { type: "STRING" }, advice: { type: "STRING" }, comment: { type: "STRING" }
      }, required: ["score", "rank", "good", "advice", "comment"] }
    }
  };
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent", {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify(reqBody)
    });
    if (!r.ok) return null;
    const j = await r.json();
    const t = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { const s = t.indexOf("{"), q = t.lastIndexOf("}"); if (s >= 0 && q > s) { try { return JSON.parse(t.slice(s, q + 1)); } catch (e2) {} } return null; }
  } catch (e) { return null; }
}

http.createServer(function (req, res) {
  // --- API ---
  if (req.method === "POST" && req.url === "/api/reply") {
    let data = "";
    req.on("data", function (c) { data += c; if (data.length > 12000) req.destroy(); });
    req.on("end", async function () {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      try {
        const body = JSON.parse(data || "{}");
        if (body.mode === "owner") {   // オーナーコードはサーバー側(.env)で照合＝クライアントに出さない
          res.end(JSON.stringify({ owner: !!process.env.OWNER_CODE && String(body.code || "") === process.env.OWNER_CODE }));
          return;
        }
        const out = body.mode === "evaluate" ? await geminiEvaluate(body) : await geminiReply(body);
        res.end(JSON.stringify(out || { error: "no-ai" }));
      } catch (e) { res.end(JSON.stringify({ error: "fail" })); }
    });
    return;
  }
  // --- 静的配信 ---
  let p = decodeURIComponent(url.parse(req.url).pathname);
  if (p === "/") p = "/index.html";
  const fp = path.normalize(path.join(ROOT, p));
  if (!fp.startsWith(ROOT)) { res.statusCode = 403; res.end("forbidden"); return; }
  fs.readFile(fp, function (err, buf) {
    if (err) { res.statusCode = 404; res.end("not found"); return; }
    res.setHeader("Content-Type", MIME[path.extname(fp)] || "application/octet-stream");
    res.end(buf);
  });
}).listen(PORT, function () {
  console.log("meegri → http://localhost:" + PORT + (KEY ? "   [Gemini: ON]" : "   [Gemini: OFF（.env に GEMINI_API_KEY を設定すると本物のAI会話に）]"));
});
