/**
 * Build IELTS Listening Mock Test 1 seed from Academic Test 1 paper + answer key.
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

const formIntro = `SECTION 1 · Questions 1–5
Complete the form below.
Write NO MORE THAN ONE WORD OR A NUMBER for each answer.

PAN ASIAN AIRWAYS — LOST PROPERTY REPORT FORM
Example — First Name: Kirsty
Surname: Allen`;

const questions = [
  fb(
    `${formIntro}\n\n(1) Address: __________ Windham Road, Richmond`,
    "48",
    ["forty eight", "forty-eight"],
  ),
  fb(
    `${formIntro}\n\n(2) Postcode: __________\nNote: answer with no space`,
    "R16 GH7",
    ["R16GH7", "r16 gh7", "r16gh7"],
  ),
  fb(
    `${formIntro}\nHome tel: 020 8927 7651\n\n(3) Mobile tel: __________\nNote: answer with no space`,
    "07754 897 432",
    ["07754897432", "07754 897432"],
  ),
  fb(
    `${formIntro}\n\n(4) Flight number: __________\nNote: capital letters and no space`,
    "PA 365",
    ["PA365", "pa 365", "pa365"],
  ),
  fb(
    `${formIntro}\nFrom: New York · To: London Heathrow\n\n(5) Seat number: __________`,
    "E6",
    ["e6"],
  ),
  ms(
    `Questions 6–8\nWhat items did Kirsty’s bag contain?\nSelect THREE items.`,
    ["17 pounds", "pens", "her passport", "a book", "200 dollars", "her house keys"],
    "b,d,e",
  ),
  mc(
    `Question 9\nWhat has Kirsty done regarding the loss of her credit card?`,
    [
      "Informed the police but not the credit card company.",
      "Informed the credit card company but not the police.",
      "Informed both the police and the credit card company.",
      "Informed neither the police nor the credit card company.",
    ],
    "c",
  ),
  mc(
    `Question 10\nWhat must Kirsty do after the call regarding her lost handbag?`,
    [
      "Call back after 1½ hours.",
      "Just wait for a call back.",
      "Call back after 1½ hours if she has heard nothing.",
      "Call back the next day if she has heard nothing.",
    ],
    "c",
  ),
  fb(
    `SECTION 2 · Questions 11–14 — Map labels
Label the locations on the campus map (from the recording).
Write NO MORE THAN THREE WORDS.

(11) Location near the Car Park: __________`,
    "Student’s Union",
    ["Students Union", "Students' Union", "Student Union"],
  ),
  fb(
    `SECTION 2 · Map labels\n(12) Location near Hall of Residence / Refectory: __________`,
    "University Library",
    ["Uni Library", "the University Library", "library"],
  ),
  fb(
    `SECTION 2 · Map labels\n(13) Location near Hall of Residence: __________`,
    "Hall of Residence",
    ["Halls of Residence", "hall of residence"],
  ),
  fb(
    `SECTION 2 · Map labels\n(14) Location near Main Lecture Hall: __________`,
    "Sports Hall",
    ["Sport Hall", "the Sports Hall", "sports hall"],
  ),
  fb(
    `SECTION 2 · Questions 15–20 — Student facilities notes
Write NO MORE THAN THREE WORDS OR A NUMBER.

Library — Tours every (15) __________ for 2 weeks.`,
    "2 hours",
    ["two hours", "2hrs", "2 hrs"],
  ),
  fb(
    `SECTION 2 notes\nLibrary open 9am–9pm (later during (16) __________)`,
    "Final exams",
    ["final exam", "exams", "Final Exams"],
  ),
  fb(
    `SECTION 2 notes\nRefectory dinner (17) __________ – 8.30pm`,
    "6pm",
    ["6 pm", "6.00pm", "18:00", "6 o'clock"],
  ),
  fb(
    `SECTION 2 notes\nTypes of food — favourites, healthy, ethnic, (18) __________, vegan`,
    "Vegetarian",
    ["vegetarian"],
  ),
  fb(
    `SECTION 2 notes\nAthletic Union — lets me use facilities, play for teams, (19) __________ me all year`,
    "(Fully) insures",
    ["Fully insures", "insures", "fully insure", "Fully insured", "insures"],
  ),
  fb(
    `SECTION 2 notes\nDiscount Card costs (20) £__________`,
    "50",
    ["£50", "50 pounds"],
  ),
  fb(
    `SECTION 3 · Questions 21–25 — Complete the table
Write NO MORE THAN THREE WORDS.

Jane — Day of Arrival: (21) __________`,
    "Tuesday",
    ["Tues"],
  ),
  fb(
    `SECTION 3 table\nJane — Subjects Studying: (22) __________ (with history, music)`,
    "Economics",
    ["economics"],
  ),
  fb(
    `SECTION 3 table\nJane — Monday’s 2pm lecture: (23) __________`,
    "free/nothing",
    ["free", "nothing", "Free", "Nothing", "free / nothing"],
  ),
  fb(
    `SECTION 3 table\nJane — Wednesday afternoon sport: (24) __________`,
    "Squash",
    ["squash"],
  ),
  fb(
    `SECTION 3 table\nJane — Location of Sport: (25) __________`,
    "Main sports hall",
    ["main sports hall", "Main Sports Hall", "sports hall"],
  ),
  fb(
    `SECTION 3 · Questions 26–29
Write NO MORE THAN THREE WORDS OR A NUMBER.

26. Students can choose from how many essay titles for their first assignment?`,
    "About 10",
    ["10", "about 10", "approx 10", "approximately 10"],
  ),
  fb(
    `SECTION 3\n27. Where did John travel during the summer?`,
    "Africa and Asia",
    ["Asia and Africa", "Africa & Asia"],
  ),
  fb(
    `SECTION 3\n28. What is the word limit for the essays?`,
    "4000 words",
    ["4000", "4,000 words", "4,000"],
  ),
  fb(
    `SECTION 3\n29. When must the first essay be handed in by?`,
    "30th October",
    ["30 October", "October 30", "30th of October", "Oct 30"],
  ),
  mc(
    `Question 30\nWhere will John and Jane meet up later that day?`,
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
    `SECTION 4\n32. Professor Wilson says that oil tankers are...`,
    ["very safe.", "quite safe.", "quite unsafe."],
    "b",
  ),
  mc(
    `SECTION 4\n33. According to Professor Wilson, the main cause of oil slicks is...`,
    [
      "accidents while loading and unloading oil.",
      "collisions.",
      "deliberate releases of oil.",
    ],
    "b",
  ),
  mc(
    `SECTION 4\n34. According to Professor Wilson, slicks are rarely burned off nowadays because...`,
    [
      "the oil is refined.",
      "it usually doesn’t work.",
      "it creates too much air pollution.",
    ],
    "b",
  ),
  fb(
    `SECTION 4 · Questions 35–39 — Oil clean-up techniques
Write NO MORE THAN THREE WORDS.

Containment Boom — Only good when there are (35) __________`,
    "Very calm seas",
    ["calm seas", "very calm sea", "Very calm sea"],
  ),
  fb(
    `SECTION 4 techniques\nChemical Detergents — Good for treating (36) __________`,
    "Larger slicks",
    ["larger slick", "large slicks"],
  ),
  fb(
    `SECTION 4 techniques\nThe Sponge — The sponge mats turn into (37) __________`,
    "Toxic waste",
    ["toxic wastes"],
  ),
  fb(
    `SECTION 4 techniques\nBacteria — Totally (38) __________`,
    "Eco-friendly",
    ["eco friendly", "eco-friendly", "environmentally friendly"],
  ),
  fb(
    `SECTION 4 techniques\nBacteria — Drawbacks: (39) __________`,
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
Optional essay question — faculty notice boards include reading lists, essay questions, and (40) __________
Write NO MORE THAN THREE WORDS.`,
    "Deadline for submission",
    ["deadlines for submission", "submission deadline", "the deadline for submission"],
  ),
];

// multi_select counts as 1 question in our DB but represents 6-8 (3 marks in real IELTS).
// Keep paper numbering notes in prompts; total interactive items = questions.length

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
