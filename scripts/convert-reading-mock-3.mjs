/**
 * Convert LearnDash WpProQuiz .wpq (READING MOCK TEST 3) → IELTS seed JSON.
 * Passage 3 body + option boxes that are images in the WPQ are reconstructed
 * from academic-mock-3-questions.pdf / Picture5–7.png.
 *
 * Usage:
 *   node scripts/convert-reading-mock-3.mjs [path-to.wpq]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WPQ = join(homedir(), "Downloads", "WpProQuiz_export_1794973129.wpq")
const WPQ_PATH = process.argv[2] ? join(process.cwd(), process.argv[2]) : DEFAULT_WPQ
const ARCHIVE_DIR = join(__dirname, "../src/db/imports")
const ARCHIVE_PATH = join(ARCHIVE_DIR, "WpProQuiz_reading-mock-3.wpq")
const OUT_PATH = join(__dirname, "../src/db/ielts-reading-mock-3-seed.json")

/** Actions box for Q1–6 (Picture5.png). */
const ACTIONS_1_6 = `Actions to Clean up the River Thames:
A. Operating the Rubbish Muncher
B. Creating Community Strategies
C. Monitoring the Cleanliness of the River Thames
D. Monitoring Fish Levels
E. Collecting Solid Waste from the Tideway
F. Creating Enlarged Sewage Works
G. Controlling the River Thames’ Traffic
Example: The Fisheries Department → D`

/** Headings box for Q28–32 (Picture7.png). */
const HEADINGS_28_32 = `List of headings:
i. Industry Structures
ii. Disease Affects Production
iii. Trends in Production
iv. Government Assistance
v. How Deer Came to Australia
vi. Research and Development
vii. Asian Competition
viii. Industry Development`

/** Passage 3 is image/PDF-only in the WPQ — body from academic-mock-3-questions.pdf. */
const PASSAGE_3_BODY = `DEER FARMING IN AUSTRALIA

A
Deer are not indigenous to Australia. They were introduced into the country during the nineteenth century under the acclimatization programs governing the introduction of exotic species of animals and birds into Australia. Six species of deer were released at various locations. The animals dispersed and established wild populations at various locations across Australia, mostly depending upon their points of release into the wild. These animals formed the basis for the deer industry in Australia today.
Commercial deer farming in Australia commenced in Victoria in 1971 with the authorized capture of rusa deer from the Royal National Park, NSW. Until 1985, only four species of deer, two from temperate climates (red, fallow) and two tropical species (rusa, chital) were confined for commercial farming. Late in 1985, pressure from industry to increase herd numbers saw the development of import protocols. This resulted in the introduction of large numbers of red deer hybrids from New Zealand and North American elk directly from Canada. The national farmed deer herd is now distributed throughout all states although most are in New South Wales and Victoria.

B
The number of animals processed annually has continued to increase, despite the downward trend in venison prices since 1997. Of concern is the apparent increase in the number of female animals processed and the number of whole herds committed for processing. With more than 40,000 animals processed in 1998/99 and 60,000 in 1999/2000, there is justified concern that future years may see a dramatic drop in production. At least 85% of all venison produced in Australia is exported, principally to Europe. At least 90% of all velvet antler produced is exported in an unprocessed state to Asia.
Schemes to promote Australian deer products continue to have a positive effect on sales that in turn have a positive effect on prices paid to growers. The industry appears to be showing limited signs that it is emerging from a state of depression caused by both internal and external factors that include: (i) the Asian currency downturn; (ii) the industry’s lack of competitive advantage in influential markets (particularly in respect to New Zealand competition), and; (iii) within industry processing and marketing competition for limited product volumes of venison.

C
From the formation of the Australian Deer Breeders Federation in 1979, the industry representative body has evolved through the Deer Farmers Federation of Australia to the Deer Industry Association of Australia Ltd (DIAA), which was registered in 1995. The industry has established two product development and marketing companies, the Australian Deer Horn and Co-Products Pty Ltd (ADH) and the Deer Industry Projects and Development Pty Ltd, which trades as the Deer Industry Company (DIC). ADH collects and markets Australian deer horn and co-products on behalf of Australian deer farmers. It promotes the harvest of velvet antler according to the strict quality assurance program promoted by the industry. The company also plans and co-ordinates regular velvet accreditation courses for Australian deer farmers.

D
Estimates suggest that until the early 1990s the rate of the annual increase in the number of farmed deer was up to 25%, but after 1993 this rate of increase fell to probably less than 10%. The main reasons for the decline in the deer herd growth rate at such a critical time for the market were: (i) severe drought conditions up to 1998 affecting eastern Australia during 1993-96 and (ii) the consequent slaughter of large numbers of breeding females, at very low prices. These factors combined to decrease confidence within the industry. Lack of confidence saw a drop in new investment within the industry and a lack of willingness of established farmers to expand their herds. With the development of strong overseas markets for venison and velvet and the prospect of better seasons ahead in 1996, the trends described were seen to have been significantly reversed. However, the relatively small size of the Australian herd was seen to impose undesirable restraints on the rate at which herd numbers could be expanded to meet the demands for products.
Supply difficulties were exacerbated when the supply of products, particularly venison, was maintained by the slaughter of young breeding females. The net result was depletion of the industry’s female breeding herds.

E
Industry programs are funded by statutory levies on sales of animals for venison, velvet antler sales and the sale of live animals into export markets. The industry has a 1996 - 2000 five year plan including animal nutrition, pasture quality, carcass quality, antler harvesting, promotional material and technical bulletins. All projects have generated a significant volume of information, which compliments similar work undertaken in New Zealand and other deer farming countries.
Major projects funded by levy funds include the Venison Market Project from 1992 to 1996. This initiative resulted in a dramatic increase in international demand for Australian venison and an increase in the domestic consumption of venison. In an effort to maintain existing venison markets in the short term and to increase them in the long term, in 1997 the industry’s top priority became the increase in size and production capacity of the national herd.

Source: Rural Industries Research & Development Corporation`

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

/** Multi-alt blanks like {[mouth lining|1][skin|1]} → first primary + alts. */
function parseClozeBlanksWithAlts(answerHtml) {
  const text = String(answerHtml || "")
  const blanks = []
  const blankRe = /(\d+)\.\s*([\s\S]*?)(?=\n\s*\d+\.\s|$)/g
  let m
  while ((m = blankRe.exec(text))) {
    const chunk = m[2]
    const alts = []
    const altRe = /\{\[([^\]|]+)/g
    let a
    while ((a = altRe.exec(chunk))) alts.push(a[1].trim())
    // Also catch inline {[word|1]} mid-sentence (Q38–40 style)
    if (!alts.length) {
      const inline = [...chunk.matchAll(/\{\[([^\]|]+)/g)].map((x) => x[1].trim())
      alts.push(...inline)
    }
    blanks.push({ n: Number(m[1]), alts, chunk: chunk.replace(/\s+/g, " ").trim() })
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
  const matches = [...plain.matchAll(new RegExp(`${n}\\.\\s+[^\\n]+(?:\\n(?!\\d+\\.)[^\\n]+)?`, "g"))]
  if (matches.length) return matches[matches.length - 1][0].replace(/\s+/g, " ").trim()
  return `${n}. ${plain.slice(-200).replace(/\s+/g, " ").trim()}`
}

function ensurePassageBanner(text, number, questionRange, spendLine) {
  const body = String(text || "").trim()
  if (/^READING PASSAGE|^ACADEMIC READING/i.test(body)) return body
  return [`READING PASSAGE ${number} Questions ${questionRange}`, spendLine, "", body].join("\n\n")
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

const q1 = findByTitle(list, /Q1-Q6|Q1–Q6/i) || list[0]
const q15 = findByTitle(list, /Q15\b/i)

const passage1 = passageFromHtml(q1?._question, /Questions\s*1\s*[-–]\s*6/i)
const passage2 = passageFromHtml(q15?._question, /Questions\s*15\s*[-–]\s*21/i)
// Nicotine passage has no article title — leave body as-is.
const passage3 = ensurePassageBanner(
  PASSAGE_3_BODY,
  3,
  "28 - 40",
  "You should spend about 20 minutes on Questions 28 – 40 which are based on Reading Passage 3.",
)

const passage_html = [
  ensurePassageBanner(
    passage1.replace(/Cleaning up The Thames/i, "CLEANING UP THE THAMES"),
    1,
    "1 - 14",
    "You should spend about 20 minutes on Questions 1 – 14 which are based on Reading Passage 1 below.",
  ),
  ensurePassageBanner(
    passage2,
    2,
    "15 - 27",
    "You should spend about 20 minutes on Questions 15 – 27 which are based on Reading Passage 2 on the following pages.",
  ),
  passage3,
].join("\n\n\n")

const outQuestions = []

// —— Q1–6 matching agencies → actions ——
const matchInstr = `Questions 1–6 — Matching (Passage 1)
Some of the actions taken to clean up the River Thames are listed below.
The writer gives these actions as examples of things that have been done by various agencies connected with the River Thames.
Match each action with the agency responsible for doing it.
Write the appropriate letters (A–G) in boxes 1–6 on your answer sheet.
${ACTIONS_1_6}`
const agencyStems = [
  "1. The Environment Agency",
  "2. Transport for London",
  "3. The Greater London Council",
  "4. Thames Water",
  "5. Port of London",
  "6. Local Boroughs",
]
const answers16 = parseClozeTokens(q1?._answerData?.[0]?._answer || "")
if (answers16.length !== 6) throw new Error(`Q1–6 expected 6 answers, got ${answers16.length}`)
answers16.forEach((ans, i) => {
  const letter = ans.toUpperCase()
  outQuestions.push(fillBlank(`${matchInstr}\n\n${agencyStems[i]}`, letter, [letter.toLowerCase()]))
})

// —— Q7–14 Y/N/NG ——
const ynInstr = `Questions 7–14 — Yes / No / Not Given (Passage 1)
Do the following statements agree with the views of the writer of the reading passage on Cleaning up the Thames?
In Boxes 7–14 write:
YES if the statement agrees with the writer
NO if the statement doesn’t agree with the writer
NOT GIVEN if it is impossible to say what the writer thinks about this`
const ynStems = {
  7: "7. The Thames is now cleaner that it was in 1900.",
  8: "8. Swimming in the Thames now poses no health hazards.",
  9: "9. It is now mainly the responsibility of those who pollute the Thames to clean their waste up.",
  10: "10. All local London boroughs are now partly responsible for keeping the Thames clean.",
  11: "11. Transport for London now employs a type of River Police to enforce control of their regulations.",
  12: "12. Rubbish Munchers are now situated at various locations on the Thames.",
  13: "13. Previously no one department had overall responsibility or control for monitoring the cleanliness of the Thames.",
  14: "14. British Waterways will no longer have any part in keeping the Thames clean.",
}
for (let n = 7; n <= 14; n++) {
  const q = findByTitle(list, new RegExp(`Q${n}\\b`, "i"))
  const ans = singleCorrect(q).toUpperCase()
  if (!ans) throw new Error(`Missing answer for Q${n}`)
  let stem = stemFromSingle(q, n)
  if (!new RegExp(`^${n}\\.`).test(stem)) stem = ynStems[n]
  // Prefer canonical stem from paper when WPQ truncates mid-line
  if (stem.length < 40 || /regulations\.$|monitoring the$|for\s*$/i.test(stem)) {
    stem = ynStems[n]
  }
  outQuestions.push(fillBlank(`${ynInstr}\n\n${stem}`, ans, ynAlts(ans)))
}

// —— Q15–21 Y/N/NG Passage 2 ——
const yn2Instr = `Questions 15–21 — Yes / No / Not Given (Passage 2)
Do the following statements agree with the views of the writer of Reading Passage 2?
In boxes 15–21 on your answer sheet write:
YES if the statement agrees with the writer
NO if the statement doesn’t agree with the writer
NOT GIVEN if it is impossible to say what the writer thinks about this`
const yn2Stems = {
  15: "15. Although nicotine is probably the well-known chemical in cigarettes, it is not necessarily the most dangerous.",
  16: "16. In spite of the difficulties, according to the text more than thirty-five million people a year manage to give up smoking.",
  17: "17. It has been shown that nicotine in cigarettes can improve people’s abilities to perform some specific tasks.",
  18: "18. Added ammonia in cigarettes allows smokers to inhale more nicotine.",
  19: "19. Snorted substances reach the brain faster than injected substances.",
  20: "20. Nicotine dilates the blood vessels that carry it around the body.",
  21: "21. Nicotine molecules allow greater electrical charges to pass between neurones.",
}
for (let n = 15; n <= 21; n++) {
  const q = findByTitle(list, new RegExp(`Q${n}\\b`, "i"))
  const ans = singleCorrect(q).toUpperCase()
  if (!ans) throw new Error(`Missing answer for Q${n}`)
  let stem = stemFromSingle(q, n)
  if (!new RegExp(`^${n}\\.`).test(stem) || stem.length < 50) stem = yn2Stems[n]
  // Fix common WPQ typos when we have the paper stem
  if (n === 15 || n === 16 || n === 17) stem = yn2Stems[n]
  outQuestions.push(fillBlank(`${yn2Instr}\n\n${stem}`, ans, ynAlts(ans)))
}

// —— Q22–26 short answers ——
const q2226 = findByTitle(list, /Q22/i)
const blanks2226 = parseClozeBlanksWithAlts(q2226?._answerData?.[0]?._answer || "")
const saInstr = `Questions 22–26 — Short answers (Passage 2)
Using NO MORE THAN THREE WORDS OR A NUMBER from Reading Passage 2, answer the following questions.
Write your answers in boxes 22–26 on your answer sheet.`
const saStems = {
  22: "22. What is the natural colour of nicotine?",
  23: "23. By how much would cigarette companies have to cut the nicotine content in cigarettes to prevent them from being addictive?",
  24: "24. Name ONE of 2 things that first take nicotine into a smoker’s body?",
  25: "25. According to the passage, by how many beats a minute can a cigarette raise a smoker’s heart rate?",
  26: "26. What type of cell in the human body encloses neurones?",
}
if (blanks2226.length !== 5) {
  throw new Error(`Q22–26 expected 5 blanks, got ${blanks2226.length}`)
}
blanks2226.forEach((blank) => {
  const n = blank.n
  let primary = blank.alts[0]
  const alts = [...blank.alts.slice(1)]
  // WPQ key for Q26 is "None" (incomplete); passage answer is glial/ganglion cells.
  if (n === 26 && /^none$/i.test(primary)) {
    primary = "glial cells"
    alts.push("ganglion cells", "None", "none")
  }
  if (n === 23) {
    alts.push("95%", "95 per cent", "95 percent")
  }
  if (n === 25) {
    alts.push("10 to 20", "10–20")
  }
  outQuestions.push(fillBlank(`${saInstr}\n\n${saStems[n]}`, primary, alts))
})

// —— Q27 title choice ——
const q27 = findByTitle(list, /Q27\b/i)
const ans27raw = singleCorrect(q27)
const ans27 = (ans27raw.match(/^([A-E])/i)?.[1] || ans27raw).toUpperCase()
const titleInstr = `Questions 27 — Choose a title (Passage 2)
From the list below choose the most suitable title for Reading Passage 2.
Write the appropriate letter A–E in box 27 on your answer sheet.
A. How to Quit Smoking
B. The Dangers of Smoking
C. Cell Biology
D. Why Smoking is Addictive
E. Nicotine is a Poison`
outQuestions.push(
  fillBlank(`${titleInstr}\n\n27. Most suitable title`, ans27, [
    ans27.toLowerCase(),
    "Why Smoking is Addictive",
    "D. Why Smoking is Addictive",
  ]),
)

// —— Q28–32 matching headings ——
const q2832 = findByTitle(list, /Q28/i)
const answers2832 = parseClozeTokens(q2832?._answerData?.[0]?._answer || "")
const headingInstr = `Questions 28–32 — Matching headings (Passage 3)
The reading passage on Deer Farming In Australia has 5 paragraphs (A–E).
From the list of headings below choose the most suitable headings for paragraphs A–E.
Write the appropriate number (i–viii) in boxes 28–32 on your answer sheet.
There are more headings than paragraphs, so you will not use them all.
${HEADINGS_28_32}`
const headingStems = [
  "28. Paragraph A",
  "29. Paragraph B",
  "30. Paragraph C",
  "31. Paragraph D",
  "32. Paragraph E",
]
if (answers2832.length !== 5) {
  throw new Error(`Q28–32 expected 5 answers, got ${answers2832.length}`)
}
answers2832.forEach((ans, i) => {
  const roman = ans.toLowerCase()
  outQuestions.push(
    fillBlank(`${headingInstr}\n\n${headingStems[i]}`, roman, [roman.toUpperCase()]),
  )
})

// —— Q33–37 T/F/NG ——
const tfInstr = `Questions 33–37 — True / False / Not Given (Passage 3)
Read the passage about Deer Farming in Australia again and look at the statements below.
In boxes 33–37 on your answer sheet write:
TRUE if the statement is true
FALSE if the statement is false
NOT GIVEN if the information is not given in Reading Passage 3`
const tfStems = {
  33: "33. Until 1985 only 2 species of the originally released Australian deer were not used for farming.",
  34: "34. Since 1985 many imported deer have been interbred with the established herds.",
  35: "35. The drop in deer numbers since 1997 led to an increase in the price of venison.",
  36: "36. Only a small amount of Australian venison production is consumed domestically.",
  37: "37. Current economic conditions in Asian countries have had positive effect on the Australian deer industry.",
}
for (let n = 33; n <= 37; n++) {
  const q = findByTitle(list, new RegExp(`Q${n}\\b`, "i"))
  const ans = singleCorrect(q).toUpperCase()
  if (!ans) throw new Error(`Missing answer for Q${n}`)
  outQuestions.push(fillBlank(`${tfInstr}\n\n${tfStems[n]}`, ans, ynAlts(ans)))
}

// —— Q38–40 sentence completion ——
const q3840 = findByTitle(list, /Q38/i)
const blanks3840 = parseClozeBlanksWithAlts(q3840?._answerData?.[0]?._answer || "")
const sentInstr = `Questions 38–40 — Sentence completion (Passage 3)
Complete each of the following statements (Questions 38–40) with words taken from Reading Passage 3.
Write NO MORE THAN THREE WORDS for each answer.
Write your answers in boxes 38–40 on your answer sheet.`
const sentStems = {
  38: "38. A stringent __________ allows the Australian deer industry to maintain their excellence of product.",
  39: "39. Herd stock expansion was made difficult by the killing of __________ to continue product supply.",
  40: "40. Foreign and home markets for Australian venison increased due to the __________.",
}
if (blanks3840.length !== 3) {
  throw new Error(`Q38–40 expected 3 blanks, got ${blanks3840.length}`)
}
blanks3840.forEach((blank) => {
  const n = blank.n
  const primary = blank.alts[0]
  const alts = blank.alts.slice(1).concat([
    primary.replace(/\b\w/g, (c) => c.toUpperCase()),
  ])
  outQuestions.push(fillBlank(`${sentInstr}\n\n${sentStems[n]}`, primary.toLowerCase(), alts))
})

if (outQuestions.length !== 40) {
  throw new Error(`Expected 40 questions, got ${outQuestions.length}`)
}

const seed = {
  source: "WpProQuiz_export_1794973129.wpq (READING MOCK TEST 3)",
  quiz: {
    group_subject: "Reading",
    title: "IELTS Reading — Mock Test 3",
    description:
      "Full Academic Reading mock (40 questions, 3 passages: Cleaning up the Thames, Nicotine, Deer Farming in Australia).",
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
  `Wrote ${OUT_PATH} (${outQuestions.length} questions, passage ${passage_html.length} chars)`,
)
