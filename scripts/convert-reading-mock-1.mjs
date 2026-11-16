/**
 * Convert WpProQuiz READING MOCK TEST 1 XML → IELTS seed JSON (fill_blank × 40).
 * Usage: node scripts/convert-reading-mock-1.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const XML_PATH = join(
  __dirname,
  "../../lms-client/public/downloads/WpProQuiz_export_1794810031.xml",
);
const OUT_PATH = join(__dirname, "../src/db/ielts-reading-mock-1-seed.json");

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
xi. Current Research`;

const PEOPLE_TEXT = `People:
TB — Tony Brown
PL — Patrick Leahy
BB — Bill Bowler
PJ — Paul Jepson
AP — Art Pimms
SB — Steve Black
RH — Rick Hilton
Answer with the abbreviation only (e.g. AP).`;

const WORD_BANK_TEXT =
  "Word bank: behaviour · diversity · expanding · mammals · reptiles · research · success · treatment";

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractCdataBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function extractQuestions(xml) {
  const chunks = xml.split(/<question\b/).slice(1);
  return chunks.map((chunk) => {
    const body = chunk.split(/<\/question>/)[0] ?? chunk;
    const type = (body.match(/answerType="([^"]+)"/) || [])[1] || "";
    const title = (body.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || [])[1] || "";
    const points = Number((body.match(/<points>(\d+)<\/points>/) || [])[1] || 1);
    const questionText =
      (body.match(/<questionText><!\[CDATA\[([\s\S]*?)\]\]><\/questionText>/) || [])[1] || "";
    const answerText =
      (body.match(/<answerText[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/answerText>/) || [])[1] || "";
    return { type, title, points, questionText, answerText };
  });
}

function parseClozeAnswers(answerText) {
  const answers = [];
  const pipeRe = /\{\[([^\]|]+)(?:\|[^\]]*)?\]\}/g;
  let m;
  while ((m = pipeRe.exec(answerText))) answers.push(m[1].trim());
  if (answers.length) return answers;

  const braceRe = /\{([^}]+)\}/g;
  while ((m = braceRe.exec(answerText))) {
    const val = m[1].trim();
    if (!val || val.includes("[")) continue;
    answers.push(val);
  }
  if (answers.length) return answers;

  const plain = stripTags(answerText).replace(/^Answer:\s*/i, "").trim();
  if (plain) answers.push(plain);
  return answers;
}

function fillBlank(prompt, answer, alts = []) {
  return {
    prompt,
    question_type: "fill_blank",
    options: alts.map((text, i) => ({ id: `alt${i + 1}`, text })),
    correct_option_id: answer,
  };
}

function ynAlts(primary) {
  const n = primary.toUpperCase();
  if (n === "YES") return ["Yes", "Y"];
  if (n === "NO") return ["No", "N"];
  if (n === "NOT GIVEN") return ["Not Given", "NG", "not given"];
  if (n === "TRUE") return ["True", "T"];
  if (n === "FALSE") return ["False", "F"];
  return [];
}

const xml = readFileSync(XML_PATH, "utf8");
const questions = extractQuestions(xml);

const q1 = questions.find((q) => /Q1\b/i.test(q.title)) || questions[0];
const q14 = questions.find((q) => /Q14\b/i.test(q.title));
const q28 = questions.find((q) => /Q28/i.test(q.title));

function htmlToPlain(html) {
  return html
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)\s*>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/?(ul|ol|table|thead|tbody|tr|td|th|span|strong|b|em|i|a|font)[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function passageFromQuestion(q, stopMarker) {
  if (!q) return "";
  let html = q.questionText;
  const idx = html.toLowerCase().indexOf(stopMarker.toLowerCase());
  if (idx > 0) html = html.slice(0, idx);
  return htmlToPlain(html);
}

const passage1 = passageFromQuestion(q1, "Questions 1- 8");
const passage2 = passageFromQuestion(q14, "Questions 14 -");
const passage3 = passageFromQuestion(q28, "Questions 28 - 35");

const passage_html = [
  "READING PASSAGE 1",
  passage1,
  "",
  "READING PASSAGE 2",
  passage2,
  "",
  "READING PASSAGE 3",
  passage3,
].join("\n\n");

const outQuestions = [];

// Q1–8 matching animals
const animalInstr = `Questions 1–8 — Matching
Use the information in Passage 1. Choose:
A = cheetahs · B = leopards · C = both · D = neither
Answer with A, B, C, or D.`;

const q1to8 = [
  ["1. These animals were smuggled into the UAE.", "A"],
  ["2. At first these animals did not adapt to life at the Sharjah Breeding Centre.", "D"],
  ["3. These animals are regarded as the most important animal at the Centre.", "B"],
  ["4. Half of these animals were born at the Breeding centre.", "D"],
  ["5. These animals can be dangerous to one another.", "B"],
  ["6. The role of the keeper is vital in the breeding programme of these animals.", "C"],
  ["7. The first of these animals at the Breeding Centre were relatively young.", "A"],
  ["8. It is normally difficult for humans to approach these animals.", "B"],
];
for (const [prompt, ans] of q1to8) {
  outQuestions.push(
    fillBlank(`${animalInstr}\n\n${prompt}`, ans, [ans.toLowerCase()]),
  );
}

// Q9–13 summary completion
const summaryInstr = `Questions 9–13 — Summary completion
Complete the summary of Passage 1 using words from the bank (one word each).
${WORD_BANK_TEXT}`;
const q9to13 = [
  ["9. … birds, mammals, and __________.", "reptiles", ["Reptiles"]],
  ["10. … breeding and __________ the numbers of the species …", "expanding", ["Expanding"]],
  ["11. … maintaining the __________ of bloodlines …", "diversity", ["Diversity"]],
  ["12. … complex __________ of the animals …", "behaviour", ["behavior", "Behaviour", "Behavior"]],
  ["13. … a fair amount of __________ has been achieved …", "success", ["Success"]],
];
for (const [prompt, ans, alts] of q9to13) {
  outQuestions.push(fillBlank(`${summaryInstr}\n\n${prompt}`, ans, alts));
}

// Q14–19 headings
const headingInstr = `Questions 14–19 — Matching headings (Passage 2)
Choose the most suitable heading for each paragraph. Write the roman numeral only (e.g. viii).
${HEADINGS_TEXT}`;
const q14to19 = [
  ["14. Paragraph B", "viii", ["VIII", "8"]],
  ["15. Paragraph C", "i", ["I", "1"]],
  ["16. Paragraph D", "x", ["X", "10"]],
  ["17. Paragraph E", "vii", ["VII", "7"]],
  ["18. Paragraph F", "v", ["V", "5"]],
  ["19. Paragraph G", "iii", ["III", "3"]],
];
for (const [prompt, ans, alts] of q14to19) {
  outQuestions.push(fillBlank(`${headingInstr}\n\n${prompt}`, ans, alts));
}

// Q20–27 Y/N/NG
const ynInstr = `Questions 20–27 — Yes / No / Not Given (Passage 2)
YES = agrees with the writer · NO = disagrees · NOT GIVEN = cannot say`;
const q20to27 = [
  ["20. Someone who only gets four hours of sleep a night must be suffering from insomnia.", "NO"],
  ["21. Travelling can cause insomnia.", "YES"],
  ["22. REM sleep is felt to be the most important for the body’s rest.", "NO"],
  ["23. Secondary insomnia is far more common than primary insomnia.", "NOT GIVEN"],
  ["24. Sufferers of insomnia can attend specialist sleep clinics.", "NOT GIVEN"],
  ["25. Many people suffering from insomnia don’t realize that they suffer from it.", "NOT GIVEN"],
  ["26. There is no actual correlation linking insomnia and depression.", "NO"],
  ["27. Sleeping during the day can make insomnia worse.", "YES"],
];
for (const [prompt, ans] of q20to27) {
  outQuestions.push(fillBlank(`${ynInstr}\n\n${prompt}`, ans, ynAlts(ans)));
}

// Q28–35 matching people
const peopleInstr = `Questions 28–35 — Matching views (Passage 3)
Match each view with the person. Answer with the abbreviation only.
${PEOPLE_TEXT}`;
const q28to35 = [
  ["28. There is a double advantage to the new techniques.", "AP"],
  ["29. Expectations of end users of agricultural products affect the products.", "RH"],
  ["30. The work on developing these alternative techniques is not finished.", "PJ"],
  ["31. Eating food that has had chemicals used in its production is dangerous to our health.", "BB"],
  ["32. Changing current farming methods is not a cheap process.", "TB"],
  ["33. Results have exceeded anticipations.", "SB"],
  ["34. The research done should be translated into practical projects.", "PJ"],
  ["35. The U.S. produces the best food in the world.", "PL"],
];
for (const [prompt, ans] of q28to35) {
  outQuestions.push(fillBlank(`${peopleInstr}\n\n${prompt}`, ans, [ans.toLowerCase()]));
}

// Q36–40 T/F/NG
const tfInstr = `Questions 36–40 — True / False / Not Given (Passage 3)
TRUE · FALSE · NOT GIVEN`;
const q36to40 = [
  ["36. Integrated Pest Management has generally been regarded as a success in the US.", "FALSE"],
  [
    "37. Oregon farmers of apples and pears have been promoted as successful examples of Integrated Pest Management.",
    "TRUE",
  ],
  ["38. The IPPC uses scientists from different organizations.", "TRUE"],
  ["39. Straw mulch experiments produced unplanned benefits.", "FALSE"],
  ["40. The apple industry is now facing a lot of competition from abroad.", "NOT GIVEN"],
];
for (const [prompt, ans] of q36to40) {
  outQuestions.push(fillBlank(`${tfInstr}\n\n${prompt}`, ans, ynAlts(ans)));
}

if (outQuestions.length !== 40) {
  throw new Error(`Expected 40 questions, got ${outQuestions.length}`);
}

const seed = {
  source: "WpProQuiz_export_1794810031.xml (READING MOCK TEST 1)",
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
};

writeFileSync(OUT_PATH, JSON.stringify(seed, null, 2), "utf8");
console.log(`Wrote ${OUT_PATH} (${outQuestions.length} questions, passage ${passage_html.length} chars)`);
