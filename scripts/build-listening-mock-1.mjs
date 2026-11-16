/**
 * Build IELTS Listening Mock Test 1 seed from Academic Test 1 paper + answer key.
 * Prompt convention: text before [[blank]] = instructions; text after = suffix after the input.
 * Usage: node scripts/build-listening-mock-1.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "../src/db/ielts-listening-mock-1-seed.json");

function fb(prompt, answer, alts = []) {
  return {
    prompt,
    question_type: "fill_blank",
    options: alts.map((text, i) => ({ id: `a${i + 1}`, text })),
    correct_option_id: answer,
  };
}

function mc(prompt, options, correct) {
  return {
    prompt,
    question_type: "multiple_choice",
    options: options.map((text, i) => ({
      id: String.fromCharCode(97 + i),
      text,
    })),
    correct_option_id: correct,
  };
}

function ms(prompt, options, correctIds) {
  return {
    prompt,
    question_type: "multi_select",
    options: options.map((text, i) => ({
      id: String.fromCharCode(97 + i),
      text,
    })),
    correct_option_id: correctIds,
  };
}

const oneWord = "Write **NO MORE THAN ONE WORD OR A NUMBER** for each answer.";
const threeWords = "Write **NO MORE THAN THREE WORDS** for each answer.";
const threeWordsOrNumber = "Write **NO MORE THAN THREE WORDS OR A NUMBER** for each answer.";

const formExample = `Example:
First Name: **Kirsty** (answer)
Surname: Allen`;

const questions = [
  fb(
    `${oneWord}

${formExample}

[[blank]] Windham Road Richmond`,
    "48",
    ["forty eight", "forty-eight"],
  ),
  fb(
    `${oneWord}

Postcode

Note: answer with no space.

[[blank]]`,
    "R16 GH7",
    ["R16GH7", "r16 gh7", "r16gh7"],
  ),
  fb(
    `${oneWord}

Home tel: 020 8927 7651
Mobile tel

Note: answer with no space.

[[blank]]`,
    "07754 897 432",
    ["07754897432", "07754 897432"],
  ),
  fb(
    `${oneWord}

Flight number

Note: Answer capital letter and no space.

[[blank]]`,
    "PA 365",
    ["PA365", "pa 365", "pa365"],
  ),
  fb(
    `${oneWord}

Seat number
From: New York
To: London Heathrow

[[blank]]`,
    "E6",
    ["e6"],
  ),
  ms(
    `Questions 6–8
What items did Kirsty’s bag contain?
**Select THREE items.**`,
    ["17 pounds", "pens", "her passport", "a book", "200 dollars", "her house keys"],
    "b,d,e",
  ),
  mc(
    `Question 9
What has Kirsty done regarding the loss of her credit card?`,
    [
      "Informed the police but not the credit card company.",
      "Informed the credit card company but not the police.",
      "Informed both the police and the credit card company.",
      "Informed neither the police nor the credit card company.",
    ],
    "c",
  ),
  mc(
    `Question 10
What must Kirsty do after the call regarding her lost handbag?`,
    [
      "Call back after 1½ hours.",
      "Just wait for a call back.",
      "Call back after 1½ hours if she has heard nothing.",
      "Call back the next day if she has heard nothing.",
    ],
    "c",
  ),
  fb(
    `SECTION 2 · Questions 11–14
Label the locations on the map below.
${threeWords}

Near the Car Park

[[blank]]`,
    "Student’s Union",
    ["Students Union", "Students' Union", "Student Union"],
  ),
  fb(
    `SECTION 2 · Map labels
${threeWords}

Near Hall of Residence / Refectory

[[blank]]`,
    "University Library",
    ["Uni Library", "the University Library", "library"],
  ),
  fb(
    `SECTION 2 · Map labels
${threeWords}

Near Hall of Residence

[[blank]]`,
    "Hall of Residence",
    ["Halls of Residence", "hall of residence"],
  ),
  fb(
    `SECTION 2 · Map labels
${threeWords}

Near Main Lecture Hall

[[blank]]`,
    "Sports Hall",
    ["Sport Hall", "the Sports Hall", "sports hall"],
  ),
  fb(
    `SECTION 2 · Questions 15–20
Notes on Student Facilities
${threeWordsOrNumber}

Library — Tours every [[blank]] for 2 weeks.`,
    "2 hours",
    ["two hours", "2hrs", "2 hrs"],
  ),
  fb(
    `${threeWordsOrNumber}

Library open 9am – 9pm (later during [[blank]])`,
    "Final exams",
    ["final exam", "exams", "Final Exams"],
  ),
  fb(
    `${threeWordsOrNumber}

Refectory dinner [[blank]] – 8.30pm`,
    "6pm",
    ["6 pm", "6.00pm", "18:00", "6 o'clock"],
  ),
  fb(
    `${threeWordsOrNumber}

Types of food — favourites, healthy, ethnic, [[blank]], vegan`,
    "Vegetarian",
    ["vegetarian"],
  ),
  fb(
    `${threeWordsOrNumber}

Athletic Union — lets me use facilities, play for teams, [[blank]] me all year`,
    "(Fully) insures",
    ["Fully insures", "insures", "fully insure", "Fully insured"],
  ),
  fb(
    `${threeWordsOrNumber}

Discount Card costs £[[blank]]`,
    "50",
    ["£50", "50 pounds"],
  ),
  fb(
    `SECTION 3 · Questions 21–25
Complete the table below.
${threeWords}

Jane — Day of Arrival

[[blank]]`,
    "Tuesday",
    ["Tues"],
  ),
  fb(
    `${threeWords}

Jane — Subjects Studying (with history, music)

[[blank]]`,
    "Economics",
    ["economics"],
  ),
  fb(
    `${threeWords}

Jane — Monday’s 2pm lecture

[[blank]]`,
    "free/nothing",
    ["free", "nothing", "Free", "Nothing", "free / nothing"],
  ),
  fb(
    `${threeWords}

Jane — Wednesday afternoon sport

[[blank]]`,
    "Squash",
    ["squash"],
  ),
  fb(
    `${threeWords}

Jane — Location of Sport

[[blank]]`,
    "Main sports hall",
    ["main sports hall", "Main Sports Hall", "sports hall"],
  ),
  fb(
    `SECTION 3 · Questions 26–29
${threeWordsOrNumber}

Students can choose from how many essay titles for their first assignment?

[[blank]]`,
    "About 10",
    ["10", "about 10", "approx 10", "approximately 10"],
  ),
  fb(
    `${threeWordsOrNumber}

Where did John travel during the summer?

[[blank]]`,
    "Africa and Asia",
    ["Asia and Africa", "Africa & Asia"],
  ),
  fb(
    `${threeWordsOrNumber}

What is the word limit for the essays?

[[blank]]`,
    "4000 words",
    ["4000", "4,000 words", "4,000"],
  ),
  fb(
    `${threeWordsOrNumber}

When must the first essay be handed in by?

[[blank]]`,
    "30th October",
    ["30 October", "October 30", "30th of October", "Oct 30"],
  ),
  mc(
    `Question 30
Where will John and Jane meet up later that day?`,
    [
      "the economics course office",
      "the economics common room",
      "the campus cafeteria",
    ],
    "b",
  ),
  mc(
    `SECTION 4 · Questions 31–34
31. Japan relies on oil tankers because...`,
    [
      "the country consists of islands.",
      "the country has no pipeline network.",
      "the country has no natural oil resources.",
    ],
    "c",
  ),
  mc(
    `32. Professor Wilson says that oil tankers are...`,
    ["very safe.", "quite safe.", "quite unsafe."],
    "b",
  ),
  mc(
    `33. According to Professor Wilson, the main cause of oil slicks is...`,
    [
      "accidents while loading and unloading oil.",
      "collisions.",
      "deliberate releases of oil.",
    ],
    "b",
  ),
  mc(
    `34. According to Professor Wilson, slicks are rarely burned off nowadays because...`,
    [
      "the oil is refined.",
      "it usually doesn’t work.",
      "it creates too much air pollution.",
    ],
    "b",
  ),
  fb(
    `SECTION 4 · Questions 35–39
Oil exploration clean-up techniques
${threeWords}

Containment Boom — Only good when there are

[[blank]]`,
    "Very calm seas",
    ["calm seas", "very calm sea", "Very calm sea"],
  ),
  fb(
    `${threeWords}

Chemical Detergents — Good for treating

[[blank]]`,
    "Larger slicks",
    ["larger slick", "large slicks"],
  ),
  fb(
    `${threeWords}

The Sponge — The sponge mats turn into

[[blank]]`,
    "Toxic waste",
    ["toxic wastes"],
  ),
  fb(
    `${threeWords}

Bacteria — Totally

[[blank]]`,
    "Eco-friendly",
    ["eco friendly", "eco-friendly", "environmentally friendly"],
  ),
  fb(
    `${threeWords}

Bacteria — Drawbacks

[[blank]]`,
    "No (discernable) drawbacks/none",
    [
      "none",
      "None",
      "no drawbacks",
      "No drawbacks",
      "no discernable drawbacks",
      "No discernable drawbacks",
      "no discernible drawbacks",
    ],
  ),
  fb(
    `Question 40
${threeWords}

Faculty notice boards include reading lists, essay questions, and

[[blank]]`,
    "Deadline for submission",
    ["deadlines for submission", "submission deadline", "the deadline for submission"],
  ),
];

const seed = {
  source: "Academic Listening Practice Test 1 (question paper + answer key)",
  quiz: {
    group_subject: "Listening",
    title: "IELTS Listening — Mock Test 1",
    description:
      "Full Academic Listening mock (Sections 1–4). Audio stays at the top — type or select your answers as you listen.",
    exam_type: "IELTS",
    category: "Listening - Mock Test",
    passing_score: 60,
    time_limit_seconds: 2400,
    audio_url: "/ielts-academic/academic-mock-1-listening.mp3",
    questions,
  },
};

writeFileSync(OUT, JSON.stringify(seed, null, 2), "utf8");
console.log(`Wrote ${OUT} (${questions.length} items)`);
