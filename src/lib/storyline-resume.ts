/**
 * Storyline 3 resume strings (MESH package 127, player 3.20).
 * The "Enter your name" field is saved in suspend data, not as a SCORM interaction.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$";

const STRING_ESCAPES: Record<string, string> = {
  "^0": "^",
  "^1": "&",
  "^2": "'",
  "^3": "+",
  "^4": "\n",
  "^5": "\r",
  "^6": "?",
  "^7": ",",
  "^8": "%",
  "^9": "\\",
  "^A": '"',
  "^B": "‘",
  "^C": "’",
  "^D": "“",
  "^E": "”",
};

type Chunk = { value: string; rest: string };

function fromUnsigned(token: string): number | null {
  let sum = 0;
  for (let i = 0; i < token.length; i++) {
    const index = ALPHABET.indexOf(token[i] ?? "");
    if (index < 0) return null;
    sum += index << (6 * i);
  }
  return sum;
}

function readChunk(input: string): Chunk | null {
  if (!input) return null;
  let start = 0;
  let lengthDigits = 1;
  if (input.startsWith("~")) {
    lengthDigits = Number(input.charAt(1));
    if (!Number.isInteger(lengthDigits) || lengthDigits < 1) return null;
    start = 2;
  }
  const encodedLength = input.slice(start, start + lengthDigits);
  if (encodedLength.length < lengthDigits) return null;
  const strLength = fromUnsigned(encodedLength);
  if (strLength == null) return null;
  const valueStart = start + lengthDigits;
  const value = input.slice(valueStart, valueStart + strLength);
  if (value.length !== strLength) return null;
  return { value, rest: input.slice(valueStart + strLength) };
}

function unwrapPackedResume(raw: string): string | null {
  const chunk = readChunk(raw);
  if (!chunk) return null;
  const declared = fromUnsigned(chunk.value);
  if (declared == null || chunk.rest.length !== declared) return null;
  return chunk.rest;
}

function decodeStorylineString(encoded: string): string | null {
  if (encoded === "^") return null;
  let out = "";
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "^" && i + 1 < encoded.length) {
      const mapped = STRING_ESCAPES[encoded.slice(i, i + 2)];
      if (mapped != null) {
        out += mapped;
        i += 1;
        continue;
      }
    }
    out += encoded[i];
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isMeshLesson(lessonTitle: string, courseTitle: string): boolean {
  const haystack = `${lessonTitle} ${courseTitle}`;
  return /mesh/i.test(haystack) || /mandatory eight-hour safety/i.test(haystack);
}

function readStringChunks(blob: string): string[] {
  const values: string[] = [];
  let rest = blob;
  while (rest.length > 0) {
    const chunk = readChunk(rest);
    if (!chunk) break;
    values.push(chunk.value);
    rest = chunk.rest;
  }
  return values;
}

/** Name typed into the MESH print prompt, when the resume string can be decoded. */
export function meshNameFromSuspendData(
  suspendData: string | null | undefined,
  lessonTitle: string,
  courseTitle: string,
): string | null {
  if (!suspendData?.trim() || !isMeshLesson(lessonTitle, courseTitle)) return null;

  const packed = unwrapPackedResume(suspendData.trim()) ?? suspendData.trim();
  const top = readStringChunks(packed);
  // viewed slides, window history, then the variable block
  const variables = top[2];
  if (!variables) return null;

  const fields = readStringChunks(variables);
  // First field is the boolean bitset. Later fields are string variables, username last.
  const strings = fields.slice(1).map(decodeStorylineString).filter((value): value is string => Boolean(value));
  const name = [...strings].reverse().find((value) => !value.startsWith("_player."));
  return name ?? null;
}
