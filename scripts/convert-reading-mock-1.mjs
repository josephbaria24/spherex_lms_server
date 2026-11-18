/**
 * Convert LearnDash WpProQuiz .wpq (READING MOCK TEST 1) → IELTS seed JSON.
 *
 * Usage:
 *   node scripts/convert-reading-mock-1.mjs [path-to.wpq]
 *
 * Default source: Downloads/WpProQuiz_export_1794969915.wpq
 */
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WPQ = join(homedir(), "Downloads", "WpProQuiz_export_1794969915.wpq")
const WPQ_PATH = process.argv[2] ? join(process.cwd(), process.argv[2]) : DEFAULT_WPQ
const ARCHIVE_DIR = join(__dirname, "../src/db/imports")
const ARCHIVE_PATH = join(ARCHIVE_DIR, "WpProQuiz_reading-mock-1.wpq")
const OUT_PATH = join(__dirname, "../src/db/ielts-reading-mock-1-seed.json")

const HEADINGS_TEXT = `List of headings:
i. The Role of Sleep
ii. Insomnia Medication
iii. Habits to Promote a Good Night’s Sleep
iv. What is Insomnia
v. Complications for Insomniacs
vi. Government Action
vii. Available Treatment for Insomnia
viii. The Causes of Insomnia
ix. Therapy Solutions
x. Types of Insomnia
xi. Current Research`

const PEOPLE_TEXT = `People:
TB — Tony Brown
PL — Patrick Leahy
BB — Bill Bowler
PJ — Paul Jepson
AP — Art Pimms
SB — Steve Black
RH — Rick Hilton
Answer with the abbreviation only (e.g. AP).`

const WORD_BANK_TEXT =
  "Word bank: behaviour · diversity · expanding · mammals · reptiles · research · success · treatment"

const ANIMAL_OPTIONS = `A. If the statement refers to cheetahs at the Breeding
B. If the statement refers to leopards at the Breeding
C. If the statement refers to both cheetahs and leopards at the Breeding
D. If the statement refers to neither cheetahs nor leopards at the Breeding`

function decodeWpq(raw) {
  const header = raw.match(/^WPQ[0-9.]+/)?.[0]
  if (!header) throw new Error("Not a WPQ export (missing WPQ header)")
  const payload = raw.slice(header.length).replace(/[^A-Za-z0-9+/=]/g, "")
  const json = Buffer.from(payload, "base64").toString("utf8")
  return JSON.parse(json)
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
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/\\u2019/g, "’")
    .replace(/\\u2013/g, "–")
    .replace(/\\u2014/g, "—")
    .replace(/\\u201c/g, "“")
    .replace(/\\u201d/g, "”")
    .replace(/\\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

/** Parse LearnDash cloze tokens: {A} or {[reptiles|1]} or {[NOT GIVEN|1]} */
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
  // Strip tags first so markers like "Questions 14 – 19" survive WordPress spans.
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

function stripLeadingNumber(text) {
  return String(text || "")
    .replace(/^\d+\.\s*/, "")
    .replace(/\u00a0/g, " ")
    .trim()
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
const q14 = findByTitle(list, /Q14\b/i)
const q28 = findByTitle(list, /Q28/i)

// Stop at the question-block heading (not the passage title that also says "Questions …").
const passage1 = passageFromHtml(q1?._question, /Questions\s*1\s*[-–]\s*8/i)
const passage2 = passageFromHtml(q14?._question, /Questions\s*14\s*[-–]\s*19/i)
const passage3 = passageFromHtml(q28?._question, /Questions\s*28\s*[-–]\s*35/i)

function ensurePassageBanner(text, number, questionRange, spendLine) {
  const body = String(text || "").trim()
  if (/^READING PASSAGE/i.test(body)) return body
  return [
    `READING PASSAGE ${number} Questions ${questionRange}`,
    spendLine,
    "",
    body,
  ].join("\n\n")
}

const passage_html = [
  ensurePassageBanner(
    passage1,
    1,
    "1 - 13",
    "You should spend about 20 minutes on Questions 1 – 13 which are based on Reading Passage 1 below",
  ),
  ensurePassageBanner(
    passage2,
    2,
    "14 - 27",
    "You should spend about 20 minutes on Questions 14 – 27 which are based on Reading Passage 2.",
  ),
  ensurePassageBanner(
    passage3,
    3,
    "28 - 40",
    "You should spend about 20 minutes on Questions 28 – 40 which are based on Reading Passage 3 below.",
  ),
].join("\n\n\n")

const outQuestions = []

// Q1–8 matching animals (individual WP questions)
const animalInstr = `Questions 1–8 — Matching
Use the information in the text to match the statements (1–8) with the animals (A–D).
Select the appropriate letter (A–D) in boxes 1–8 on the space provided.
${ANIMAL_OPTIONS}`

for (let i = 0; i < 8; i++) {
  const q = list[i]
  const ans = parseClozeTokens(q?._answerData?.[0]?._answer || "")[0]
  if (!ans) throw new Error(`Missing answer for Q${i + 1}`)
  const statement = htmlToPlain(q._question).replace(/^Questions[\s\S]*?(?=\d+\.)/i, "").trim()
  const line = /^\d+\./.test(statement) ? statement : `${i + 1}. ${stripLeadingNumber(statement)}`
  outQuestions.push(fillBlank(`${animalInstr}\n\n${line}`, ans.toUpperCase(), [ans.toLowerCase()]))
}

// Q9–13 summary (one WP cloze with 5 blanks)
const q913 = findByTitle(list, /Q9-Q13|Q9–Q13/i)
const answers913 = parseClozeTokens(q913?._answerData?.[0]?._answer || "")
if (answers913.length !== 5) throw new Error(`Expected 5 answers for Q9–13, got ${answers913.length}`)
const summaryInstr = `Questions 9–13 — Summary completion
Complete the summary below. Choose your answers from the box below the summary and write them in boxes 9–13.
There are more words than spaces, so you will not use them all.
${WORD_BANK_TEXT}`
const summaryStems = [
  "9. … birds, mammals, and __________.",
  "10. … breeding and __________ the numbers of the species …",
  "11. … maintaining the __________ of bloodlines …",
  "12. … complex __________ of the animals …",
  "13. … a fair amount of __________ has been achieved …",
]
answers913.forEach((ans, i) => {
  const primary = ans.toLowerCase() === "behavior" ? "behaviour" : ans.toLowerCase()
  const alts =
    primary === "behaviour"
      ? ["behavior", "Behaviour", "Behavior", ans]
      : [ans, ans[0].toUpperCase() + ans.slice(1)]
  outQuestions.push(fillBlank(`${summaryInstr}\n\n${summaryStems[i]}`, primary, alts))
})

// Q14–19 headings
const headingInstr = `Questions 14–19 — Matching headings (Passage 2)
The reading passage on Insomnia has 7 paragraphs (A–G).
From the list of headings below choose the most suitable headings for paragraphs B–G.
Write the appropriate number (i–xi) in spaces 14–19.
There are more headings than paragraphs, so you will not use them all.
${HEADINGS_TEXT}`
for (let n = 14; n <= 19; n++) {
  const q = findByTitle(list, new RegExp(`Q${n}\\b`, "i"))
  const ans = parseClozeTokens(q?._answerData?.[0]?._answer || "")[0]
  if (!ans) throw new Error(`Missing answer for Q${n}`)
  const statement = htmlToPlain(q._question)
  // Q14 HTML includes the full passage — keep only the paragraph stem.
  const para = [...statement.matchAll(new RegExp(`${n}\\.\\s*Paragraph\\s+[A-G]`, "gi"))].pop()
  const line = para?.[0] ?? `${n}. Paragraph ${String.fromCharCode(65 + (n - 13))}`
  const roman = ans.toLowerCase()
  outQuestions.push(fillBlank(`${headingInstr}\n\n${line}`, roman, [roman.toUpperCase()]))
}

// Q20–27 Y/N/NG multi-cloze
const q2027 = findByTitle(list, /Q20-Q27|Q20–Q27/i)
const answers2027 = parseClozeTokens(q2027?._answerData?.[0]?._answer || "")
const text2027 = htmlToPlain(q2027?._answerData?.[0]?._answer || "")
const ynInstr = `Questions 20–27 — Yes / No / Not Given (Passage 2)
Do the following statements agree with the views of the writer of the reading passage on Insomnia?
In Boxes 20–27 write:
YES if the statement agrees with the writer
NO if the statement doesn’t agree with the writer
NOT GIVEN if it is impossible to say what the writer thinks about this`
const ynStems = []
const stemRe = /(\d+)\.\s+([\s\S]*?)\s+Answer:/g
let sm
while ((sm = stemRe.exec(text2027))) {
  ynStems.push({ n: Number(sm[1]), text: sm[2].trim() })
}
if (answers2027.length !== 8 || ynStems.length !== 8) {
  throw new Error(`Q20–27 parse failed: answers=${answers2027.length} stems=${ynStems.length}`)
}
ynStems.forEach((stem, i) => {
  const ans = answers2027[i].toUpperCase()
  outQuestions.push(
    fillBlank(`${ynInstr}\n\n${stem.n}. ${stem.text}`, ans, ynAlts(ans)),
  )
})

// Q28–35 people matching multi-cloze
const q2835 = findByTitle(list, /Q28-Q35|Q28–Q35/i)
const answers2835 = parseClozeTokens(q2835?._answerData?.[0]?._answer || "")
const text2835 = htmlToPlain(q2835?._answerData?.[0]?._answer || "")
const peopleInstr = `Questions 28–35 — Matching views (Passage 3)
Match the views (28–35) with the people listed below.
${PEOPLE_TEXT}`
const peopleStems = []
const peopleRe = /(\d+)\.\s+([\s\S]*?)\s+Answer:/g
while ((sm = peopleRe.exec(text2835))) {
  peopleStems.push({ n: Number(sm[1]), text: sm[2].trim() })
}
if (answers2835.length !== 8 || peopleStems.length !== 8) {
  throw new Error(`Q28–35 parse failed: answers=${answers2835.length} stems=${peopleStems.length}`)
}
peopleStems.forEach((stem, i) => {
  const ans = answers2835[i].toUpperCase()
  outQuestions.push(fillBlank(`${peopleInstr}\n\n${stem.n}. ${stem.text}`, ans, [ans.toLowerCase()]))
})

// Q36–40 T/F/NG multi-cloze
const q3640 = findByTitle(list, /Q36-Q40|Q36–Q40/i)
const answers3640 = parseClozeTokens(q3640?._answerData?.[0]?._answer || "")
const text3640 = htmlToPlain(q3640?._answerData?.[0]?._answer || "")
const tfInstr = `Questions 36–40 — True / False / Not Given (Passage 3)
Read the passage about alternative farming methods in Oregon again and look at the statements below.
In boxes 36–40 on your answer sheet write:
TRUE if the statement is true
FALSE if the statement is false
NOT GIVEN if the information is not given in the advertisement`
const tfStems = []
const tfRe = /(\d+)\.\s+([\s\S]*?)\s+Answer:/g
while ((sm = tfRe.exec(text3640))) {
  tfStems.push({ n: Number(sm[1]), text: sm[2].trim() })
}
if (answers3640.length !== 5 || tfStems.length !== 5) {
  throw new Error(`Q36–40 parse failed: answers=${answers3640.length} stems=${tfStems.length}`)
}
tfStems.forEach((stem, i) => {
  const ans = answers3640[i].toUpperCase()
  outQuestions.push(fillBlank(`${tfInstr}\n\n${stem.n}. ${stem.text}`, ans, ynAlts(ans)))
})

if (outQuestions.length !== 40) {
  throw new Error(`Expected 40 questions, got ${outQuestions.length}`)
}

const seed = {
  source: `WpProQuiz_export_1794969915.wpq (READING MOCK TEST 1)`,
  quiz: {
    group_subject: "Reading",
    title: "IELTS Reading — Mock Test 1",
    description:
      "Full Academic Reading mock (40 questions, 3 passages). Fill in answers as on the paper: letters, words, YES/NO/NOT GIVEN, or TRUE/FALSE/NOT GIVEN.",
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
  `Wrote ${OUT_PATH} (${outQuestions.length} questions, passage ${passage_html.length} chars, p2=${passage2.length})`,
)
