"""
Extract CSE quiz questions from the CSC Professional/Sub-Professional PDF.
- Correct answers: red text
- Target words (synonym/antonym/etc.): bold+italic → [[EMPH]]…[[/EMPH]]
- Options only match at line starts (avoids splitting words like "nila.")
"""
from __future__ import annotations

import json
import re
import unicodedata
from collections import OrderedDict
from pathlib import Path

import fitz

PDF_PATH = Path(r"c:\Users\delar\Downloads\PETROSPHERE_PROJECT\SphereX-LMS\csc-reviewer.pdf")
OUT_PATH = Path(
    r"c:\Users\delar\Downloads\PETROSPHERE_PROJECT\SphereX-LMS\lms-server\src\db\cse-quiz-seed.json"
)

SECTION_HINTS = [
    ("Mathematics - Word Problems and Operations", re.compile(r"Word Problems and Operations", re.I)),
    ("Mathematics - Data Sufficiency", re.compile(r"Data Sufficiency", re.I)),
    ("English - Alphabetizing", re.compile(r"Alphabetizing", re.I)),
    ("English - Synonyms", re.compile(r"(?m)^Synonyms\b", re.I)),
    ("English - Antonyms", re.compile(r"(?m)^Antonyms\b", re.I)),
    ("English - Single-Word Analogy", re.compile(r"Single[- ]Word Analogy", re.I)),
    ("English - Double-Word Analogy", re.compile(r"Double[- ]Word Analogy", re.I)),
    ("English - Identifying Errors", re.compile(r"Identifying Errors", re.I)),
    ("English - Paragraph Development", re.compile(r"Paragraph Development", re.I)),
    ("English - Correct Usage", re.compile(r"Correct Usage", re.I)),
    ("English - Reading Comprehension", re.compile(r"Reading Comprehension", re.I)),
    ("Filipino - Kasingkahulugan", re.compile(r"Kasingkahulugan", re.I)),
    ("Filipino - Kasalungat", re.compile(r"Kasalungat", re.I)),
    ("Filipino - Mga Kawikaan", re.compile(r"Mga Kawikaan", re.I)),
    ("Filipino - Wastong Gamit", re.compile(r"Wastong Gamit", re.I)),
    ("Filipino - Pagkilala sa Mali", re.compile(r"Pagkilala sa Mali", re.I)),
    ("Filipino - Pag-unawa sa Binasa", re.compile(r"Pag-unawa sa Binasa", re.I)),
    ("Filipino - Pagtatalata", re.compile(r"Pagtatalata", re.I)),
    ("Philippine Constitution", re.compile(r"Philippine Constitution", re.I)),
    ("Inductive Reasoning", re.compile(r"Inductive Reasoning", re.I)),
    ("Abstract Reasoning", re.compile(r"Abstract Reasoning", re.I)),
]

# Sections where options are letter markers under words (not readable MCQ text)
LETTER_ONLY_SECTIONS = {
    "English - Identifying Errors",
    "Filipino - Pagkilala sa Mali",
}

CHUNK = 25

# Private-use Symbol font leftovers → approximate ASCII
PUA_MAP = {
    "\uf07b": "{",
    "\uf07d": "}",
    "\uf02d": "-",
    "\uf02b": "+",
    "\uf02a": "×",
    "\uf0f7": "÷",
    "\uf03d": "=",
    "\uf03c": "<",
    "\uf03e": ">",
}


def is_red_color(color: int) -> bool:
    r = (color >> 16) & 255
    g = (color >> 8) & 255
    b = color & 255
    return r > 200 and g < 80 and b < 80


def is_emphasis(flags: int, font: str) -> bool:
    if flags & 2:
        return True
    # Some PDFs encode italic only in the font name
    fname = (font or "").lower()
    return "italic" in fname or "oblique" in fname


def normalize_text(s: str) -> str:
    for src, dst in PUA_MAP.items():
        s = s.replace(src, dst)
    # Drop remaining private-use junk
    s = "".join(ch for ch in s if not (0xE000 <= ord(ch) <= 0xF8FF))
    s = unicodedata.normalize("NFC", s)
    # Keep curly quotes from PDF; normalize odd spaces
    s = s.replace("\u00a0", " ")
    return s


def page_lines(page) -> list[str]:
    d = page.get_text("dict")
    lines: list[str] = []
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            bits: list[str] = []
            for span in line.get("spans", []):
                text = normalize_text(span.get("text", ""))
                if not text:
                    continue
                color = span.get("color", 0)
                flags = span.get("flags", 0)
                font = span.get("font", "")
                if is_red_color(color):
                    bits.append(f"[[RED]]{text}[[/RED]]")
                elif is_emphasis(flags, font):
                    bits.append(f"[[EMPH]]{text}[[/EMPH]]")
                else:
                    bits.append(text)
            lines.append("".join(bits))
    return lines


def strip_markers(s: str) -> str:
    s = re.sub(r"\[\[/?RED\]\]", "", s)
    s = re.sub(r"\[\[/?EMPH\]\]", "", s)
    return s


def clean_option_text(s: str) -> str:
    s = strip_markers(s)
    s = re.sub(r"P\s*a\s*g\s*e\s*\|\s*\d+", " ", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def clean_prompt(s: str) -> str:
    s = re.sub(r"\[\[/?RED\]\]", "", s)
    s = re.sub(r"P\s*a\s*g\s*e\s*\|\s*\d+", " ", s, flags=re.I)
    # Merge adjacent EMPH tags: [[EMPH]]foo[[/EMPH]][[EMPH]]bar[[/EMPH]] → one
    s = re.sub(r"\[\[/EMPH\]\]\s*\[\[EMPH\]\]", "", s)
    parts = re.split(r"(\[\[EMPH\]\][\s\S]*?\[\[/EMPH\]\])", s)
    cleaned: list[str] = []
    for part in parts:
        if part.startswith("[[EMPH]]"):
            inner = part[len("[[EMPH]]") : -len("[[/EMPH]]")]
            inner = re.sub(r"\s+", " ", inner).strip()
            if inner:
                cleaned.append(f"[[EMPH]]{inner}[[/EMPH]]")
        else:
            cleaned.append(re.sub(r"\s+", " ", part))
    return "".join(cleaned).strip()


def detect_section(plain: str, current: str) -> str:
    for name, pat in SECTION_HINTS:
        if pat.search(plain):
            return name
    return current


OPTION_LINE = re.compile(
    r"^(?:\[\[RED\]\])?\s*([a-eA-E])\.\s*(.*?)\s*(?:\[\[/RED\]\])?\s*$"
)
# Multiple letter options on one line (Identifying Errors layout)
MULTI_OPT = re.compile(r"(?:\[\[RED\]\])?\s*([a-eA-E])\.(?:\[\[/RED\]\])?")


def parse_letter_only_question(raw: str, section: str) -> dict | None:
    """Identifying Errors: sentence + a–e markers; red letter is correct."""
    m = re.match(r"(\d+)\.\s*(.*)", raw, re.S)
    if not m:
        return None
    rest = m.group(2)
    lines = [ln.strip() for ln in rest.splitlines() if ln.strip()]
    if not lines:
        return None

    prompt_parts: list[str] = []
    option_blob = ""
    for ln in lines:
        plain = strip_markers(ln)
        # A line that is mostly a/b/c/d/e markers
        letters = MULTI_OPT.findall(ln)
        if len(letters) >= 2 and len(re.sub(r"[a-eA-E\.\[\]RED/\s]", "", plain)) < 8:
            option_blob += " " + ln
        elif OPTION_LINE.match(ln) and not clean_option_text(
            OPTION_LINE.match(ln).group(2) if OPTION_LINE.match(ln) else ""
        ):
            option_blob += " " + ln
        else:
            if option_blob:
                # trailing sentence fragment after options started (rare)
                prompt_parts.append(ln)
            else:
                prompt_parts.append(ln)

    prompt = clean_prompt(" ".join(prompt_parts))
    if len(strip_markers(prompt)) < 5:
        return None

    found = []
    correct = None
    for match in re.finditer(
        r"(?:\[\[RED\]\])?\s*([a-eA-E])\.(?:\[\[/RED\]\])?",
        option_blob or rest,
    ):
        # Check if this match is inside RED by looking at nearby context
        label = match.group(1).lower()
        start = max(0, match.start() - 10)
        chunk = (option_blob or rest)[start : match.end() + 10]
        if label not in found:
            found.append(label)
        if "[[RED]]" in chunk[0 : chunk.find(match.group(0)) + len(match.group(0)) + 5] or (
            "[[RED]]" in (option_blob or rest)[
                max(0, match.start() - 8) : match.end() + 8
            ]
        ):
            correct = label

    # More reliable: find [[RED]]…letter…
    red_letters = re.findall(
        r"\[\[RED\]\]\s*([a-eA-E])\.|([a-eA-E])\.\s*\[\[/RED\]\]|\[\[RED\]\]([a-eA-E])\.",
        option_blob or rest,
    )
    for trip in red_letters:
        correct = next(x for x in trip if x).lower()
        break
    # Also: [[RED]]b.[[/RED]] or [[RED]]b. text
    mred = re.search(r"\[\[RED\]\]\s*([a-eA-E])\.", option_blob or rest)
    if mred:
        correct = mred.group(1).lower()

    if not found:
        found = ["a", "b", "c", "d", "e"]
    if correct is None or correct not in found:
        return None

    options = []
    for lab in ["a", "b", "c", "d", "e"]:
        if lab in found or lab == "e":
            text = "No error" if lab == "e" else f"Choice {lab}"
            options.append({"id": lab, "text": text})
    # unique preserve order
    seen = set()
    uniq = []
    for o in options:
        if o["id"] in seen:
            continue
        seen.add(o["id"])
        uniq.append(o)
    if correct not in seen:
        return None

    return {
        "section": section,
        "prompt": prompt,
        "options": uniq,
        "correct_option_id": correct,
        "question_type": "multiple_choice",
    }


def parse_standard_question(raw: str, section: str) -> dict | None:
    m = re.match(r"(\d+)\.\s*(.*)", raw, re.S)
    if not m:
        return None
    rest = m.group(2)
    lines = rest.splitlines()

    prompt_lines: list[str] = []
    option_lines: list[str] = []
    in_options = False

    for ln in lines:
        stripped = ln.strip()
        if not stripped:
            continue
        if re.match(r"P\s*a\s*g\s*e\s*\|", strip_markers(stripped), re.I):
            continue
        opt_m = OPTION_LINE.match(stripped)
        if opt_m:
            in_options = True
            option_lines.append(stripped)
        elif in_options:
            # Continuation of previous option text (wrapped line)
            if option_lines:
                option_lines[-1] = option_lines[-1] + " " + stripped
            else:
                prompt_lines.append(stripped)
        else:
            prompt_lines.append(stripped)

    prompt = clean_prompt(" ".join(prompt_lines))
    if len(strip_markers(prompt)) < 3:
        return None

    options: list[dict] = []
    correct: str | None = None
    seen: set[str] = set()

    for ln in option_lines:
        is_correct = "[[RED]]" in ln
        om = OPTION_LINE.match(ln)
        if not om:
            continue
        label = om.group(1).lower()
        if label in seen:
            continue
        text = clean_option_text(om.group(2))
        if not text:
            continue
        seen.add(label)
        options.append({"id": label, "text": text})
        if is_correct:
            correct = label

    if len(options) < 2 or correct is None:
        return None
    if correct not in {o["id"] for o in options}:
        return None

    # Drop prompts that are mostly private-use garbage leftovers
    plain = strip_markers(prompt)
    if sum(1 for ch in plain if ch.isalnum()) < 3:
        return None

    return {
        "section": section,
        "prompt": prompt,
        "options": options,
        "correct_option_id": correct,
        "question_type": "multiple_choice",
    }


def parse_question(raw: str, section: str) -> dict | None:
    if section in LETTER_ONLY_SECTIONS:
        return parse_letter_only_question(raw, section)
    return parse_standard_question(raw, section)


def _page_spans(page) -> list[dict]:
    spans: list[dict] = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span.get("text") or ""
                # Drop Symbol-font bracket/operator pieces (private-use)
                text = "".join(ch for ch in text if not (0xF000 <= ord(ch) <= 0xF0FF))
                if not text.strip():
                    continue
                x0, y0, x1, y1 = span["bbox"]
                spans.append(
                    {
                        "t": text,
                        "x0": x0,
                        "y0": y0,
                        "x1": x1,
                        "y1": y1,
                        "size": span.get("size", 12),
                        "cx": (x0 + x1) / 2,
                        "font": span.get("font") or "",
                    }
                )
    return spans


def _page_fraction_bars(page) -> list[tuple[float, float, float, float]]:
    bars: list[tuple[float, float, float, float]] = []
    for drawing in page.get_drawings():
        rect = drawing.get("rect")
        if not rect:
            continue
        # Include short single-digit fraction bars (≈6px) and longer ones
        if abs(rect.y1 - rect.y0) < 1.5 and (rect.x1 - rect.x0) > 4:
            bars.append((rect.x0, rect.y0, rect.x1, rect.y1))
    return bars


def _build_math_expr(items: list[dict]) -> str:
    items = sorted(items, key=lambda s: s["x0"])
    bases = [
        (i, s)
        for i, s in enumerate(items)
        if not (s["size"] < 9 and s["t"].strip().isdigit())
    ]
    supers = [
        (i, s)
        for i, s in enumerate(items)
        if s["size"] < 9 and s["t"].strip().isdigit()
    ]
    attached: dict[int, list[str]] = {i: [] for i, _ in bases}
    for _, super_span in supers:
        best = None
        best_score = 1e9
        for bi, base in bases:
            if super_span["x0"] < base["x0"] - 2:
                continue
            if super_span["x0"] > base["x1"] + 16:
                continue
            if abs(super_span["y0"] - base["y0"]) > 14:
                continue
            score = abs(super_span["x0"] - base["x1"])
            if not any(ch.isalnum() for ch in base["t"]):
                score += 100
            if score < best_score:
                best_score = score
                best = bi
        if best is not None:
            attached[best].append(super_span["t"])
    parts: list[str] = []
    for bi, base in bases:
        text = base["t"]
        if attached[bi]:
            text += "".join(f"^{digit}" for digit in attached[bi])
        parts.append(text)
    return "".join(parts)


def _fraction_from_bar(spans: list[dict], bar: tuple[float, float, float, float]) -> str | None:
    bx0, by, bx1, _ = bar
    num: list[dict] = []
    den: list[dict] = []
    for span in spans:
        if span["cx"] < bx0 - 5 or span["cx"] > bx1 + 5:
            continue
        if span["y1"] <= by + 1 and span["y0"] >= by - 30:
            num.append(span)
        elif span["y0"] >= by - 1 and span["y0"] <= by + 25:
            den.append(span)
    if not num or not den:
        return None
    return f"{_build_math_expr(num)} / {_build_math_expr(den)}"


def looks_garbled_math(text: str) -> bool:
    """True when linear text extract scrambled a stacked fraction."""
    t = text.strip()
    if not t:
        return True
    if t.startswith(")") or t.startswith("(") and " / " not in t:
        return True
    # Digits/parens with almost no readable words and no slash fraction form
    if re.fullmatch(r"[\d\s()^./×+\-]+", t) and " / " not in t and t.count(")") >= 2:
        return True
    return False


def extract_page_fraction_options(page) -> dict[str, dict[str, str]]:
    """
    Map question prompt → {a: '8 / (6^2)(8^2)', ...} using fraction bars + layout.
    """
    spans = _page_spans(page)
    bars = _page_fraction_bars(page)
    if not bars:
        return {}

    questions: list[tuple[float, str]] = []
    options: list[tuple[float, str]] = []
    for span in spans:
        text = span["t"].strip()
        qm = re.match(r"^(\d+)\.\s+(.*\S)\s*$", text)
        if qm and len(qm.group(2)) > 8:
            questions.append((span["y0"], qm.group(2).strip()))
            continue
        om = re.match(r"^([a-dA-D])\.\s*$", text)
        if om:
            options.append((span["y0"], om.group(1).lower()))

    if not questions or not options:
        return {}

    result: dict[str, dict[str, str]] = {}
    for bar in bars:
        by = bar[1]
        # Option label at or slightly above the fraction
        opt_candidates = [(abs(oy - by), lab, oy) for oy, lab in options if -5 <= by - oy <= 45]
        if not opt_candidates:
            continue
        opt_candidates.sort()
        _, label, oy = opt_candidates[0]
        q_candidates = [(oy - qy, prompt) for qy, prompt in questions if qy < oy + 2]
        if not q_candidates:
            continue
        q_candidates.sort()
        prompt = q_candidates[0][1]
        expr = _fraction_from_bar(spans, bar)
        if not expr:
            continue
        result.setdefault(prompt, {})[label] = expr
    return result


def apply_fraction_fixes(doc: fitz.Document, questions: list[dict]) -> int:
    """Replace scrambled math option text with reconstructed fractions."""
    by_prompt: dict[str, dict[str, str]] = {}
    for page_index in range(doc.page_count):
        page_map = extract_page_fraction_options(doc[page_index])
        for prompt, opts in page_map.items():
            by_prompt.setdefault(prompt, {}).update(opts)

    fixed = 0
    for question in questions:
        prompt = strip_markers(question["prompt"])
        frac_opts = by_prompt.get(prompt)
        if not frac_opts:
            for key, opts in by_prompt.items():
                if prompt.startswith(key[:40]) or key.startswith(prompt[:40]):
                    frac_opts = opts
                    break
        if not frac_opts or len(frac_opts) < 2:
            continue

        # Rebuild options from fractions when present; keep answer key
        correct = question["correct_option_id"]
        existing = {o["id"]: o for o in question["options"]}
        new_options: list[dict] = []
        for label in sorted(frac_opts.keys()):
            latex = plain_fraction_to_latex(frac_opts[label])
            new_options.append({"id": label, "text": f"[[MATH]]{latex}[[/MATH]]"})
        for opt in question["options"]:
            if opt["id"] not in frac_opts:
                new_options.append(opt)
        new_options.sort(key=lambda o: o["id"])

        if correct not in {o["id"] for o in new_options} and correct in existing:
            for option in question["options"]:
                rebuilt = frac_opts.get(option["id"])
                if rebuilt:
                    option["text"] = f"[[MATH]]{plain_fraction_to_latex(rebuilt)}[[/MATH]]"
            fixed += 1
            continue

        question["options"] = new_options
        if correct not in {o["id"] for o in new_options}:
            question["correct_option_id"] = (
                correct if correct in frac_opts else next(iter(sorted(frac_opts)))
            )
        fixed += 1
    return fixed


def plain_fraction_to_latex(expr: str) -> str:
    """8 / (6^2)(8^2) → \\dfrac{8}{(6^{2})(8^{2})}"""
    s = expr.strip()
    s = re.sub(r"\^(\d+)", r"^{\1}", s)
    m = re.match(r"^(.+?)\s*/\s*(.+)$", s)
    if m:
        return rf"\dfrac{{{m.group(1).strip()}}}{{{m.group(2).strip()}}}"
    return s


def reconstruct_inline_prompt_math(page) -> dict[str, str]:
    """
    Rebuild prompt formulas that use stacked fractions + tall brackets,
    e.g. x: [ (3/8)(72) + (5/7)(35) ]
    Returns { question_stem: full_prompt_with_[[MATH]] }
    """
    spans = _page_spans(page)
    bars = _page_fraction_bars(page)

    stems: list[tuple[float, float, str]] = []
    for span in spans:
        text = span["t"].strip()
        m = re.match(r"^(\d+)\.\s+(Find the value of x:?)\s*$", text, re.I)
        if m:
            stems.append((span["y0"], span["x1"], "Find the value of x:"))

    if not stems:
        return {}

    results: dict[str, str] = {}
    for stem_y, stem_x1, stem_text in stems:
        local_bars = [b for b in bars if abs(b[1] - (stem_y + 8)) < 30 and b[0] > stem_x1 - 10]
        # Prefer short formula bars near the stem (not full-page rules)
        local_bars = [b for b in local_bars if (b[2] - b[0]) < 80]
        if len(local_bars) < 1:
            continue
        local_bars.sort(key=lambda b: b[0])

        terms: list[str] = []
        for idx, bar in enumerate(local_bars):
            frac = _fraction_from_bar(spans, bar)
            if not frac:
                continue
            latex_frac = plain_fraction_to_latex(frac)

            # Collect (72) style groups immediately to the right of this fraction
            next_x = local_bars[idx + 1][0] - 5 if idx + 1 < len(local_bars) else bar[2] + 80
            pieces: list[tuple[float, str]] = []
            for span in spans:
                if span["x0"] < bar[2] - 1 or span["x0"] >= next_x:
                    continue
                if abs(span["y0"] - stem_y) > 20 and abs(span["y0"] - bar[1]) > 20:
                    continue
                t = span["t"].strip()
                if t in {"(", ")", "+", "−", "-"} or re.fullmatch(r"\d+", t):
                    pieces.append((span["x0"], t))
            pieces.sort()
            trailer = "".join(t for _, t in pieces if t != "+")
            # Keep a plus if Symbol plus sits between this term and the next
            terms.append(latex_frac + trailer)

        if not terms:
            continue

        # Join with + when a plus glyph exists between first and second bar
        has_plus = any(
            (s["t"] in {"+", "\uf02b"} or "\uf02b" in s["t"])
            and stem_y - 10 <= s["y0"] <= stem_y + 25
            for s in spans
        )
        inner = ("+".join(terms)) if has_plus or len(terms) > 1 else "".join(terms)
        # Clean doubled ops
        inner = re.sub(r"\++", "+", inner)
        latex = rf"x:\left[{inner}\right]"
        rebuilt = f"Find the value of x: [[MATH]]{latex}[[/MATH]]"
        results["Find the value of x:"] = rebuilt
        results["Find the value of x"] = rebuilt
        results[stem_text] = rebuilt

    return results


def apply_prompt_math_fixes(doc: fitz.Document, questions: list[dict]) -> int:
    prompt_map: dict[str, str] = {}
    for i in range(doc.page_count):
        prompt_map.update(reconstruct_inline_prompt_math(doc[i]))

    fixed = 0
    for question in questions:
        if "[[MATH]]" in question["prompt"]:
            continue
        prompt = strip_markers(question["prompt"])
        if not prompt.startswith("Find the value of x"):
            continue
        rebuilt = prompt_map.get("Find the value of x:") or prompt_map.get("Find the value of x")
        if not rebuilt:
            continue
        # Replace garbled / incomplete formula prompts
        tail = prompt.split(":", 1)[-1].strip() if ":" in prompt else ""
        if (
            looks_garbled_math(tail)
            or not tail
            or re.search(r"[)]\s*\d|[+]\s*[)]", prompt)
            or any(0xF000 <= ord(ch) <= 0xF0FF for ch in prompt)
            or prompt.count(")") >= 2
            or len(tail) < 8
        ):
            question["prompt"] = rebuilt
            fixed += 1
    return fixed


def main(
    pdf_path: Path = PDF_PATH,
    out_path: Path | None = OUT_PATH,
    stdout_mode: bool = False,
    skip_asserts: bool = False,
) -> dict:
    doc = fitz.open(pdf_path)
    section = "Introduction"
    all_lines: list[tuple[str, str]] = []

    for i in range(doc.page_count):
        lines = page_lines(doc[i])
        plain = "\n".join(strip_markers(x) for x in lines)
        section = detect_section(plain, section)
        for line in lines:
            all_lines.append((section, line))

    blob_parts: list[str] = []
    section_ranges: list[tuple[int, int, str]] = []
    for sec, line in all_lines:
        start = sum(len(p) + 1 for p in blob_parts)
        blob_parts.append(line)
        section_ranges.append((start, start + len(line) + 1, sec))

    blob = "\n".join(blob_parts) + "\n"

    def section_at(pos: int) -> str:
        for a, b, s in section_ranges:
            if a <= pos < b:
                return s
        return "Other"

    starts = list(re.finditer(r"(?m)^(\d+)\.\s+", blob))
    questions: list[dict] = []
    for i, match in enumerate(starts):
        start = match.start()
        end = starts[i + 1].start() if i + 1 < len(starts) else len(blob)
        q = parse_question(blob[start:end], section_at(start))
        if q and q["section"] != "Introduction":
            questions.append(q)

    fixed_math = apply_fraction_fixes(doc, questions)
    fixed_prompts = apply_prompt_math_fixes(doc, questions)

    by_sec: OrderedDict[str, list[dict]] = OrderedDict()
    for q in questions:
        by_sec.setdefault(q["section"], []).append(q)

    quizzes: list[dict] = []
    for sec, qs in by_sec.items():
        if len(qs) <= CHUNK:
            chunks = [qs]
        else:
            chunks = [qs[i : i + CHUNK] for i in range(0, len(qs), CHUNK)]
        parts = len(chunks)
        for i, chunk in enumerate(chunks):
            title = f"CSE Reviewer — {sec}"
            if parts > 1:
                title = f"{title} (Part {i + 1}/{parts})"
            quizzes.append(
                {
                    "title": title,
                    "description": (
                        "Practice questions from CSC Professional & Sub-Professional "
                        f"reviewer: {sec}."
                    ),
                    "exam_type": "CSE",
                    "category": sec,
                    "passing_score": 70,
                    "questions": [
                        {
                            "prompt": q["prompt"],
                            "question_type": "multiple_choice",
                            "options": q["options"],
                            "correct_option_id": q["correct_option_id"],
                            "sort_order": j,
                        }
                        for j, q in enumerate(chunk)
                    ],
                }
            )

    payload = {
        "source": str(pdf_path.name),
        "quizzes": quizzes,
        "stats": {
            "questions": len(questions),
            "quizzes": len(quizzes),
            "math_fixed": fixed_math,
            "prompt_math": fixed_prompts,
        },
    }

    if out_path is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    if stdout_mode:
        print(json.dumps(payload, ensure_ascii=False))

    if not skip_asserts and quizzes:
        first = quizzes[0]["questions"][0]
        assert first["correct_option_id"] == "b", first

        antonym = next((qz for qz in quizzes if "Antonyms (Part 1" in qz["title"]), None)
        if antonym:
            a1 = antonym["questions"][0]
            assert "[[EMPH]]accompanied[[/EMPH]]" in a1["prompt"], a1["prompt"]

        math_qz = next(
            (qz for qz in quizzes if "Word Problems" in qz["title"] and "Part 1" in qz["title"]),
            None,
        )
        if math_qz:
            greatest = next(
                (q for q in math_qz["questions"] if "greatest value" in q["prompt"].lower()),
                None,
            )
            if greatest:
                assert "dfrac" in greatest["options"][0]["text"], greatest["options"]

    return payload


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Extract CSE reviewer quizzes from PDF")
    parser.add_argument("--pdf", type=Path, default=PDF_PATH, help="Path to reviewer PDF")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write JSON seed file (default: cse-quiz-seed.json when not using --stdout)",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print JSON to stdout (for server import)",
    )
    parser.add_argument(
        "--skip-asserts",
        action="store_true",
        help="Skip CSC-specific validation asserts (use for new/updated PDFs)",
    )
    args = parser.parse_args()

    out = args.out
    if out is None and not args.stdout:
        out = OUT_PATH

    main(pdf_path=args.pdf, out_path=out, stdout_mode=args.stdout, skip_asserts=args.skip_asserts)
