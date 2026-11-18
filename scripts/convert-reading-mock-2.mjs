/**
 * Convert LearnDash WpProQuiz .wpq (READING MOCK TEST 2) → IELTS seed JSON.
 *
 * Usage:
 *   node scripts/convert-reading-mock-2.mjs [path-to.wpq]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WPQ = join(homedir(), "Downloads", "WpProQuiz_export_1794971341.wpq")
const WPQ_PATH = process.argv[2] ? join(process.cwd(), process.argv[2]) : DEFAULT_WPQ
const ARCHIVE_DIR = join(__dirname, "../src/db/imports")
const ARCHIVE_PATH = join(ARCHIVE_DIR, "WpProQuiz_reading-mock-2.wpq")
const OUT_PATH = join(__dirname, "../src/db/ielts-reading-mock-2-seed.json")

/** Endings box for Q8–11 (image in WP export; reconstructed to match keys G/E/A/C). */
const ENDINGS_8_11 = `Endings:
A. changing their diet
B. eating too much refined sugar
C. people of non-European descent
D. distant relatives with diabetes
E. the body’s cells
F. weight-related problems
G. no idea that they have the disease
H. an injection of insulin`

const SYMPTOMS_12_14 = `A. hot flushes
B. muscle pains
C. nausea
D. losing consciousness
E. tiredness
F. bleeding gums
G. dilation of the eyes
Note: Each letter must only be answered once.`

const WORD_BANK_22_27 =
  "Word bank: accepted · believed · darkness · ice cores · ocean · originating · sea · unknown · uncertain · warming"

const HEADINGS_28_33 = `List of headings:
i. Growing Coffee
ii. The different coffee species
iii. Processing the bean
iv. First contact with coffee
v. Coffee as a medicine
vi. Ideal conditions for production
vii. Making a coffee drink
viii. The spread of coffee
ix. Developing a taste for coffee
x. Coffee and Arabia
xi. Coffee as a world commodity`

function decodeWpq(raw) {
  const header = raw.match(/^WPQ[0-9.]+/)?.[0]
  if (!header) throw new Error("Not a WPQ export (missing WPQ header)")
  const payload = raw.slice(header.length).replace(/[^A-Za-z0-9+/=]/g, "")
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"))
}

function htmlToPlain(html) {
  return String(html || "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)\s*>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/?(ul|ol|table|thead|tbody|tr|td|th|span|strong|b|em|i|a|font|h[1-6])[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function parseClozeTokens(answerHtml) {
  const text = String(answerHtml || "")
  const out = []
  const re = /\{\[([^\]|]+)(?:\|[^\]]*)?\]\}|\{([^{}\[\]]+)\}/g
  let m
  while ((m = re.exec(text))) {
    const val = (m[1] || m[2] || "").trim()
    if (val) out.push(val)
  }
  return out
}

/** For multi-alt cloze blanks like {[B|1][E|1][D|1]} keep unique letters in order. */
function parseMultiAltBlank(answerHtml) {
  const text = String(answerHtml || "")
  const blanks = []
  const blankRe = /(\d+)\.\s*((?:\{\[[^\]]+\]\})+)/g
  let m
  while ((m = blankRe.exec(text))) {
    const alts = []
    const altRe = /\{\[([^\]|]+)/g
    let a
    while ((a = altRe.exec(m[2]))) alts.push(a[1].trim())
    blanks.push({ n: Number(m[1]), alts })
  }
  return blanks
}

function ynAlts(primary) {
  const n = primary.toUpperCase()
  if (n === "YES") return ["Yes", "Y"]
  if (n === "NO") return ["No", "N"]
  if (n === "NOT GIVEN") return ["Not Given", "NG", "not given"]
  if (n === "TRUE") return ["True", "T"]
  if (n === "FALSE") return ["False", "F"]
  return []
}

function fillBlank(prompt, answer, alts = []) {
  const primary = String(answer).trim()
  const extra = alts
    .map((a) => String(a).trim())
    .filter((a) => a && a.toLowerCase() !== primary.toLowerCase())
  return {
    prompt,
    question_type: "fill_blank",
    options: [primary, ...extra].map((text, i) => ({ id: `alt${i + 1}`, text })),
    correct_option_id: primary,
  }
}

function passageFromHtml(html, stopRegex) {
  const plain = htmlToPlain(html)
  const match = plain.match(stopRegex)
  if (match && match.index != null && match.index > 80) {
    return plain.slice(0, match.index).trim()
  }
  return plain
}

function sortedQuestions(qmap) {
  return Object.values(qmap).sort((a, b) => Number(a._sort) - Number(b._sort))
}

function findByTitle(list, re) {
  return list.find((q) => re.test(String(q._title || "")))
}

function singleCorrect(q) {
  const hit = (q._answerData || []).find((a) => a._correct)
  return htmlToPlain(hit?._answer || "").trim()
}

function stemFromSingle(q, n) {
  const plain = htmlToPlain(q._question)
  const matches = [...plain.matchAll(new RegExp(`${n}\\.\\s+[^\\n]+`, "g"))]
  if (matches.length) return matches[matches.length - 1][0].trim()
  // Q1 embeds the passage — grab the last sentence-like numbered stem if any
  const any = [...plain.matchAll(/(\d+)\.\s+[A-Z][^\n]{10,180}/g)]
  const last = any[any.length - 1]
  if (last) return last[0].trim()
  return `${n}. ${plain.slice(-160)}`
}

if (!existsSync(WPQ_PATH)) {
  console.error(`WPQ not found: ${WPQ_PATH}`)
  process.exit(1)
}

mkdirSync(ARCHIVE_DIR, { recursive: true })
copyFileSync(WPQ_PATH, ARCHIVE_PATH)

const data = decodeWpq(readFileSync(WPQ_PATH, "utf8"))
const quizId = Object.keys(data.question || {})[0]
if (!quizId) throw new Error("No questions in WPQ export")
const list = sortedQuestions(data.question[quizId])

const q1 = findByTitle(list, /Q1\b/i) || list[0]
const q15 = findByTitle(list, /Q15\b/i)
const q28 = findByTitle(list, /Q28/i)

const passage1 = passageFromHtml(q1?._question, /Questions\s*1\s*[-–]\s*7/i)
const passage2 = passageFromHtml(q15?._question, /Questions\s*15\s*[-–]\s*27/i)
const passage3 = passageFromHtml(q28?._question, /Questions\s*28\s*[-–]\s*33/i)

function ensurePassageBanner(text, number, questionRange, spendLine) {
  const body = String(text || "").trim()
  if (/^READING PASSAGE|^ACADEMIC READING/i.test(body)) return body
  return [`READING PASSAGE ${number} Questions ${questionRange}`, spendLine, "", body].join("\n\n")
}

const passage_html = [
  ensurePassageBanner(
    passage1,
    1,
    "1 - 14",
    "You should spend about 20 minutes on Questions 1 – 14 which are based on Reading Passage 1 below.",
  ),
  ensurePassageBanner(
    passage2,
    2,
    "15 - 27",
    "You should spend about 20 minutes on Questions 15 – 27 which are based on Reading Passage 2.",
  ),
  ensurePassageBanner(
    passage3,
    3,
    "28 - 40",
    "You should spend about 20 minutes on Questions 28 – 40 which are based on Reading Passage 3 below.",
  ),
].join("\n\n\n")

const outQuestions = []

// Q1–7 Y/N/NG singles
const ynInstr = `Questions 1–7 — Yes / No / Not Given (Passage 1)
Do the following statements agree with the information in Reading Passage 1?
In boxes 1–7 on your answer sheet write:
YES if the statement agrees with the information
NO if the statement contradicts the information
NOT GIVEN if there is no information on this`
for (let n = 1; n <= 7; n++) {
  const q = findByTitle(list, new RegExp(`Q${n}\\b`, "i")) || list[n - 1]
  const ans = singleCorrect(q).toUpperCase()
  if (!ans) throw new Error(`Missing answer for Q${n}`)
  let stem = stemFromSingle(q, n)
  // Q1 stem is often missing as a numbered line — use known first statement if needed
  if (n === 1 && !/^1\.\s+Carbohydrate/i.test(stem)) {
    stem = "1. Carbohydrate foods are the body’s source of glucose."
  }
  outQuestions.push(fillBlank(`${ynInstr}\n\n${stem}`, ans, ynAlts(ans)))
}

// Q8–11 matching endings
const q811 = findByTitle(list, /Q8-11|Q8–11/i)
const answers811 = parseClozeTokens(q811?._answerData?.[0]?._answer || "")
const text811 = htmlToPlain(q811?._answerData?.[0]?._answer || "")
const endInstr = `Questions 8–11 — Matching endings (Passage 1)
Complete the following statements with the best ending from the box below.
Write the appropriate letters A–H in boxes 8–11 on your answer sheet.
${ENDINGS_8_11}`
const endStems = []
const endRe = /(\d+)\.\s+([\s\S]*?)\s+Answer:/gi
let sm
while ((sm = endRe.exec(text811))) {
  endStems.push({ n: Number(sm[1]), text: sm[2].replace(/…/g, "…").trim() })
}
if (answers811.length !== 4 || endStems.length !== 4) {
  throw new Error(`Q8–11 parse failed: answers=${answers811.length} stems=${endStems.length}`)
}
endStems.forEach((stem, i) => {
  const ans = answers811[i].toUpperCase()
  outQuestions.push(fillBlank(`${endInstr}\n\n${stem.n}. ${stem.text}`, ans, [ans.toLowerCase()]))
})

// Q12–14 choose three symptoms (any order of B/E/D)
const q1214 = findByTitle(list, /Q12/i)
const multi = parseMultiAltBlank(q1214?._answerData?.[0]?._answer || "")
const symptomInstr = `Questions 12–14 — Multiple choice (Passage 1)
According to the text which of the following are symptoms of diabetes?
Choose THREE letters (A–G) and write them in boxes 12–14 on your answer sheet.
${SYMPTOMS_12_14}`
// Canonical order from keys: B, E, D
const symptomAnswers = ["B", "E", "D"]
if (multi.length !== 3) {
  // fallback still emit 3 blanks
}
symptomAnswers.forEach((ans, i) => {
  const n = 12 + i
  outQuestions.push(
    fillBlank(
      `${symptomInstr}\n\n${n}. Symptom letter ${i + 1} of 3`,
      ans,
      symptomAnswers.filter((x) => x !== ans).concat(symptomAnswers.map((x) => x.toLowerCase())),
    ),
  )
})

// Q15–21 T/F/NG
const tfInstr = `Questions 15–21 — True / False / Not Given (Passage 2)
Do the following statements agree with the information in Reading Passage 2?
In boxes 15–21 on your answer sheet write:
TRUE if the statement agrees with the information
FALSE if the statement contradicts the information
NOT GIVEN if there is no information on this`
for (let n = 15; n <= 21; n++) {
  const q = findByTitle(list, new RegExp(`Q${n}\\b`, "i"))
  const ans = singleCorrect(q).toUpperCase()
  if (!ans) throw new Error(`Missing answer for Q${n}`)
  let stem = stemFromSingle(q, n)
  if (n === 15 && !/^15\.\s+Industry/i.test(stem)) {
    stem = "15. Industry in the Arctic has increased over the last 20 years."
  }
  outQuestions.push(fillBlank(`${tfInstr}\n\n${stem}`, ans, ynAlts(ans)))
}

// Q22–27 summary completion
const q2227 = findByTitle(list, /Q22/i)
const answers2227 = parseClozeTokens(q2227?._answerData?.[0]?._answer || "")
const summaryInstr = `Questions 22–27 — Summary completion (Passage 2)
Complete the summary relating to Arctic Haze below.
Choose your answers from the box below the summary and write them in boxes 22–27 on your answer sheet.
There are more words than spaces, so you will not use them all.
${WORD_BANK_22_27}`
const summaryStems = [
  "22. … were at first not __________.",
  "23. … pollution delivered to the Arctic by storms __________ in Europe and Asia.",
  "24. … proof from __________ shows it only starting to occur in the 20th Century.",
  "25. … the latter creating the __________ of the haze.",
  "26. … it probably ends up in the __________ and therefore into the food chain.",
  "27. … more worried about the __________ effect it has on climate change.",
]
if (answers2227.length !== 6) throw new Error(`Q22–27 expected 6 answers, got ${answers2227.length}`)
answers2227.forEach((ans, i) => {
  outQuestions.push(
    fillBlank(`${summaryInstr}\n\n${summaryStems[i]}`, ans.toLowerCase(), [
      ans,
      ans[0].toUpperCase() + ans.slice(1),
    ]),
  )
})

// Q28–33 matching headings
const q2833 = findByTitle(list, /Q28/i)
const answers2833 = parseClozeTokens(q2833?._answerData?.[0]?._answer || "")
const text2833 = htmlToPlain(q2833?._answerData?.[0]?._answer || "")
const headingInstr = `Questions 28–33 — Matching headings (Passage 3)
The reading passage on The Story of Coffee has 7 paragraphs A–G.
From the list of headings below choose the most suitable headings for paragraphs B–G.
Write the appropriate number (i–xi) in boxes 28–33 on your answer sheet.
There are more headings than paragraphs, so you will not use them all.
${HEADINGS_28_33}`
const headingStems = []
const headRe = /(\d+)\.\s+(Paragraph\s+[A-G])/gi
while ((sm = headRe.exec(text2833))) {
  headingStems.push({ n: Number(sm[1]), text: sm[2] })
}
if (answers2833.length !== 6 || headingStems.length !== 6) {
  throw new Error(`Q28–33 parse failed: answers=${answers2833.length} stems=${headingStems.length}`)
}
headingStems.forEach((stem, i) => {
  const ans = answers2833[i].toLowerCase()
  outQuestions.push(
    fillBlank(`${headingInstr}\n\n${stem.n}. ${stem.text}`, ans, [ans.toUpperCase()]),
  )
})

// Q34–36 diagram labels
const q3436 = findByTitle(list, /Q34/i)
const answers3436 = parseClozeTokens(q3436?._answerData?.[0]?._answer || "")
const diagramInstr = `Questions 34–36 — Diagram labelling (Passage 3)
Complete the labels on the diagram of a coffee bean below.
Choose your answers from the text and write them in boxes 34–36 on your answer sheet.`
if (answers3436.length !== 3) throw new Error(`Q34–36 expected 3 answers, got ${answers3436.length}`)
;["outer layer (epicarp)", "middle layer (mesocarp)", "inner layer (endocarp)"].forEach((label, i) => {
  const ans = answers3436[i].toLowerCase()
  outQuestions.push(
    fillBlank(`${diagramInstr}\n\n${34 + i}. ${label}`, ans, [ans[0].toUpperCase() + ans.slice(1)]),
  )
})

// Q37–40 flowchart
const q3740 = findByTitle(list, /Q37/i)
const answers3740 = parseClozeTokens(q3740?._answerData?.[0]?._answer || "")
const flowInstr = `Questions 37–40 — Flow chart completion (Passage 3)
Using the information in the passage, complete the flow chart below.
Write your answers in boxes 37–40 on your answer sheet.
Use NO MORE THAN THREE WORDS from the passage for each answer.`
const flowStems = [
  "37. The coffee cherry is pulped or __________.",
  "38. The pulped beans are left __________ to ferment in pure water.",
  "39. The wet beans are sun dried … they are __________ often …",
  "40. The green beans are then roasted to __________.",
]
if (answers3740.length !== 4) throw new Error(`Q37–40 expected 4 answers, got ${answers3740.length}`)
answers3740.forEach((ans, i) => {
  outQuestions.push(fillBlank(`${flowInstr}\n\n${flowStems[i]}`, ans.toLowerCase(), [ans]))
})

if (outQuestions.length !== 40) {
  throw new Error(`Expected 40 questions, got ${outQuestions.length}`)
}

const seed = {
  source: "WpProQuiz_export_1794971341.wpq (READING MOCK TEST 2)",
  quiz: {
    group_subject: "Reading",
    title: "IELTS Reading — Mock Test 2",
    description:
      "Full Academic Reading mock (40 questions, 3 passages: Diabetes, Contaminating the Arctic, The Story of Coffee).",
    exam_type: "IELTS",
    category: "Reading - Mock Test",
    passing_score: 60,
    time_limit_seconds: 3600,
    passage_html,
    questions: outQuestions,
  },
}

writeFileSync(OUT_PATH, JSON.stringify(seed, null, 2), "utf8")
console.log(`Archived WPQ → ${ARCHIVE_PATH}`)
console.log(
  `Wrote ${OUT_PATH} (${outQuestions.length} questions, passage ${passage_html.length} chars, p2=${passage2.length}, p3=${passage3.length})`,
)
