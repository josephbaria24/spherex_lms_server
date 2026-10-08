type LangMap = Record<string, string>;

type XapiChoice = {
  id?: string;
  description?: LangMap | string;
};

type XapiStatement = {
  verb?: { id?: string };
  object?: {
    id?: string;
    definition?: {
      type?: string;
      name?: LangMap | string;
      description?: LangMap | string;
      interactionType?: string;
      choices?: XapiChoice[];
      correctResponsesPattern?: string[];
    };
  };
  result?: {
    response?: string;
    success?: boolean;
    score?: { raw?: number | string; scaled?: number | string };
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function langText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = plainText(value);
    return text.length > 0 ? text.slice(0, 800) : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const preferred = record.und ?? record["en-US"] ?? record.en ?? Object.values(record)[0];
  return typeof preferred === "string" ? langText(preferred) : null;
}

function statementsFromBody(body: unknown): XapiStatement[] {
  if (Array.isArray(body)) return body.filter((item) => asRecord(item)) as XapiStatement[];
  const record = asRecord(body);
  if (!record) return [];
  if (Array.isArray(record.statements)) {
    return record.statements.filter((item) => asRecord(item)) as XapiStatement[];
  }
  return [record as XapiStatement];
}

function verbName(statement: XapiStatement): string {
  const id = statement.verb?.id ?? "";
  const slash = id.lastIndexOf("/");
  return (slash >= 0 ? id.slice(slash + 1) : id).toLowerCase();
}

function isInteraction(statement: XapiStatement): boolean {
  const verb = verbName(statement);
  if (verb === "answered" || verb === "responded") return true;
  const definition = statement.object?.definition;
  const type = definition?.type ?? "";
  return Boolean(definition?.interactionType) || type.includes("cmi.interaction");
}

function formatToken(token: string): string {
  const trimmed = token.trim();
  if (/^(t|true)$/i.test(trimmed)) return "True";
  if (/^(f|false)$/i.test(trimmed)) return "False";
  return trimmed;
}

/** iSpring matching ids look like `0_Sudden_cardiac_arrest__SCA_`. */
export function humanizeIspringId(token: string): string {
  let text = token.trim().replace(/^\d+_/, "");
  text = text.replace(/__([A-Za-z0-9]+)_(?=$|_)/g, " ($1)");
  text = text.replace(/__/g, ", ");
  text = text.replace(/_/g, " ");
  return text.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
}

function choiceLabel(choices: XapiChoice[] | undefined, token: string): string {
  const match = choices?.find((choice) => choice.id === token);
  const label = langText(match?.description) ?? formatToken(token);
  if (/^\d+_/.test(label) || (label.includes("_") && !label.includes(" "))) return humanizeIspringId(label);
  return label;
}

function matchingLines(raw: string, choices: XapiChoice[] | undefined): string[] {
  const pairs = raw.includes("[,]") ? raw.split("[,]") : raw.split(/,\s+(?=\d+_)/);
  return pairs
    .map((pair) => {
      const [left, right] = pair.split("[.]");
      const source = choiceLabel(choices, left ?? "");
      const target = right ? choiceLabel(choices, right) : "";
      return target ? `${source} → ${target}` : source;
    })
    .filter((line) => line.length > 0);
}

function formatResponse(statement: XapiStatement): string | null {
  const raw = statement.result?.response;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const choices = statement.object?.definition?.choices;
  if (raw.includes("[.]")) return matchingLines(raw, choices).join("\n").slice(0, 2000);
  const parts = raw.split("[,]").map((part) => choiceLabel(choices, part)).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  return parts.join(", ").slice(0, 800);
}

function interactionIndexes(cmi: Record<string, string>): number[] {
  const found = new Set<number>();
  for (const key of Object.keys(cmi)) {
    const match = key.match(/^cmi\.interactions\.(\d+)\./);
    if (match) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

function indexForInteraction(cmi: Record<string, string>, id: string): number {
  if (id) {
    for (const index of interactionIndexes(cmi)) {
      if (cmi[`cmi.interactions.${index}.id`] === id) return index;
    }
  }
  const indexes = interactionIndexes(cmi);
  return indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
}

function lessonStatusFromStatement(statement: XapiStatement): string | null {
  if (isInteraction(statement)) return null;
  const verb = verbName(statement);
  if (verb === "passed") return "passed";
  if (verb === "failed") return "failed";
  if (verb === "completed") return "completed";
  return null;
}

function scoreFromStatement(statement: XapiStatement): string | null {
  if (isInteraction(statement)) return null;
  const raw = statement.result?.score?.raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const scaled = statement.result?.score?.scaled;
  if (typeof scaled === "number" && Number.isFinite(scaled)) return String(Math.round(scaled * 100));
  return null;
}

export function cmiUpdatesFromXapiStatements(
  existing: Record<string, string>,
  body: unknown,
): Record<string, string> {
  const cmi = { ...existing };
  const updates: Record<string, string> = {};

  for (const statement of statementsFromBody(body)) {
    const status = lessonStatusFromStatement(statement);
    if (status) updates["cmi.core.lesson_status"] = status;

    const score = scoreFromStatement(statement);
    if (score) updates["cmi.core.score.raw"] = score;

    if (!isInteraction(statement)) continue;

    const response = formatResponse(statement);
    const description =
      langText(statement.object?.definition?.description) ??
      langText(statement.object?.definition?.name);
    const id = typeof statement.object?.id === "string" ? statement.object.id : "";
    if (!response && !description && !id) continue;

    const index = indexForInteraction(cmi, id);
    const prefix = `cmi.interactions.${index}`;
    const result =
      statement.result?.success === true
        ? "correct"
        : statement.result?.success === false
          ? "incorrect"
          : "";

    const fields: Record<string, string> = {
      [`${prefix}.id`]: id,
      [`${prefix}.description`]: description ?? "",
      [`${prefix}.type`]: statement.object?.definition?.interactionType ?? "",
      [`${prefix}.student_response`]: response ?? "",
      [`${prefix}.result`]: result,
    };
    Object.assign(cmi, fields);
    Object.assign(updates, fields);
  }

  if (Object.keys(updates).some((key) => key.startsWith("cmi.interactions."))) {
    updates["cmi.interactions._count"] = String(interactionIndexes(cmi).length);
  }

  return updates;
}
