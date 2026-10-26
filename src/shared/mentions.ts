// `@agent` and `@name` inside comment notes and thread messages. A mention is
// one word (letters, digits, `_`, `.`, `-`) after an `@` that does not follow
// a letter or digit, so an email address is not a mention.
const MENTION =
  /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)/gu;

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; name: string };

export function splitMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const start = match.index;
    if (start > last) {
      segments.push({ kind: "text", text: text.slice(last, start) });
    }
    segments.push({ kind: "mention", text: match[0], name: match[1]! });
    last = start + match[0].length;
  }
  if (last < text.length)
    segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

// Lower-cased names mentioned in the text, each once, in order.
export function parseMentions(text: string): string[] {
  const names: string[] = [];
  for (const segment of splitMentions(text)) {
    if (segment.kind !== "mention") continue;
    const name = segment.name.toLowerCase();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

// The form a filter like "@Agent" or "agent" is compared in.
export function normalizeMention(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

type MentionSource = {
  note?: unknown;
  thread?: readonly unknown[];
  reply?: { note?: unknown };
};

// Whether a comment's note or any message in its thread mentions `name`.
export function mentionsName(record: MentionSource, name: string): boolean {
  const wanted = normalizeMention(name);
  if (!wanted) return false;
  const notes: unknown[] = [record.note];
  if (Array.isArray(record.thread)) {
    for (const message of record.thread) {
      if (typeof message === "object" && message !== null) {
        notes.push((message as { note?: unknown }).note);
      }
    }
  } else if (record.reply) {
    notes.push(record.reply.note);
  }
  return notes.some(
    (note) => typeof note === "string" && parseMentions(note).includes(wanted),
  );
}
