import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

/** One coloured piece of a line. `cls` is the class that carries its colour. */
type Token = { text: string; cls: string };

/** One search hit, as offsets into the document. */
type Hit = { start: number; end: number };

const ANCHOR = /^[&*][\w.:-]+/;
const TAG = /^!{1,2}[\w.:-]*/;
const BLOCK = /^[|>][-+]?\d*/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const FLAG = /^(?:true|false|yes|no|on|off|null|~)$/i;
const LIST_ITEM = /^-(?:\s|$)/;
const KEY = /^(?:"[^"]*"|'[^']*'|[^:#\s][^:#]*?)(?=\s*:(?:\s|$))/;

/** Colours the scalar that follows a key or a list marker: quoted strings, block
 * markers, anchors, tags, numbers and flags, with a trailing comment split off. */
function scalar(text: string, out: Token[]): void {
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  if (lead) out.push({ text: lead, cls: "" });
  const rest = text.slice(lead.length);
  if (rest === "") return;
  if (rest.startsWith("#")) {
    out.push({ text: rest, cls: "cm" });
    return;
  }
  const anchor = ANCHOR.exec(rest);
  if (anchor) {
    out.push({ text: anchor[0], cls: "an" });
    scalar(rest.slice(anchor[0].length), out);
    return;
  }
  const tag = TAG.exec(rest);
  if (tag) {
    out.push({ text: tag[0], cls: "tg" });
    scalar(rest.slice(tag[0].length), out);
    return;
  }
  const block = BLOCK.exec(rest);
  if (block) {
    out.push({ text: block[0], cls: "pn" });
    if (rest.length > block[0].length) out.push({ text: rest.slice(block[0].length), cls: "cm" });
    return;
  }
  const quote = /^["']/.exec(rest);
  if (quote) {
    const close = rest.indexOf(quote[0], 1);
    const stop = close === -1 ? rest.length : close + 1;
    out.push({ text: rest.slice(0, stop), cls: "st" });
    scalar(rest.slice(stop), out);
    return;
  }
  const comment = /\s+#/.exec(rest);
  const plain = comment ? rest.slice(0, comment.index) : rest;
  const trimmed = plain.trim();
  out.push({ text: plain, cls: NUMBER.test(trimmed) ? "nm" : FLAG.test(trimmed) ? "fl" : "va" });
  if (comment) out.push({ text: rest.slice(comment.index), cls: "cm" });
}

/** One line as coloured pieces. Line based on purpose: a quote left open on a
 * line must not recolour everything after it. */
function tokens(line: string): Token[] {
  const out: Token[] = [];
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  if (indent) out.push({ text: indent, cls: "" });
  let rest = line.slice(indent.length);
  if (rest === "" || rest.startsWith("#")) {
    if (rest) out.push({ text: rest, cls: "cm" });
    return out;
  }
  if (rest === "---" || rest === "...") {
    out.push({ text: rest, cls: "pn" });
    return out;
  }
  while (LIST_ITEM.test(rest)) {
    out.push({ text: "-", cls: "pn" });
    const space = /^\s*/.exec(rest.slice(1))?.[0] ?? "";
    if (space) out.push({ text: space, cls: "" });
    rest = rest.slice(1 + space.length);
  }
  if (rest === "" || rest.startsWith("#")) {
    if (rest) out.push({ text: rest, cls: "cm" });
    return out;
  }
  const key = KEY.exec(rest);
  if (key) {
    out.push({ text: key[0], cls: "ky" });
    rest = rest.slice(key[0].length);
    const colon = /^:\s?/.exec(rest)?.[0] ?? "";
    out.push({ text: colon, cls: "pn" });
    rest = rest.slice(colon.length);
  }
  scalar(rest, out);
  return out;
}

/** Indent width, matching the `tab-size` of the editor. */
const INDENT = "  ";

/** Where the line that holds `at` begins. */
function lineStart(value: string, at: number): number {
  return value.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
}

/** Adds or removes one indent on every line the range touches, and reports where
 * the range lands afterwards. Null when nothing changed. */
function shiftLines(value: string, from: number, to: number, add: boolean): { text: string; from: number; to: number } | null {
  const first = lineStart(value, from);
  // A range that ends at the start of a line does not touch that line.
  const tail = to > from && value[to - 1] === "\n" ? to - 1 : to;
  const last = lineStart(value, tail);
  const stop = value.indexOf("\n", tail);
  const block = value.slice(first, stop === -1 ? value.length : stop);
  const lines = block.split("\n");
  const shifted = lines.map((line) => (add ? INDENT + line : line.replace(/^ {1,2}/, "")));
  const text = shifted.join("\n");
  if (text === block) return null;
  const deltas = lines.map((line, index) => (shifted[index] ?? "").length - line.length);
  const head = deltas[0] ?? 0;
  const total = deltas.reduce((sum, delta) => sum + delta, 0);
  return {
    text: value.slice(0, first) + text + value.slice(first + block.length),
    from: from + head,
    to: from === to ? from + head : lineStart(value, from) === last ? to + head : to + total,
  };
}

/** The query as a pattern: a plain, case-insensitive substring, or a regular
 * expression when the user asks for one. Null while a regex does not parse. */
function pattern(query: string, regex: boolean): RegExp | null {
  if (query === "") return null;
  try {
    return regex ? new RegExp(query, "gim") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  } catch {
    return null;
  }
}

/** Expands a replacement template against one match: `$1`, `$&` and `$<name>`. */
function expand(match: RegExpExecArray, template: string): string {
  return template.replace(/\$(?:([$&])|(\d{1,2})|<([A-Za-z_]\w*)>)/g, (whole, simple, index, name) => {
    if (simple === "$") return "$";
    if (simple === "&") return match[0];
    if (index) return match[Number(index)] ?? "";
    if (name) return match.groups?.[name] ?? "";
    return whole;
  });
}

/** Case-insensitive hits of a compiled pattern, as offsets into the document. */
function findHits(value: string, expression: RegExp | null): Hit[] {
  if (expression == null) return [];
  const hits: Hit[] = [];
  for (const match of value.matchAll(expression)) {
    if (match.index != null && match[0].length > 0) hits.push({ start: match.index, end: match.index + match[0].length });
  }
  return hits;
}

/** Paints one line, cutting its tokens at the hit boundaries so a match can be
 * marked inside a coloured piece. */
function paint(line: string, offset: number, hits: Hit[], active: Hit | null): ReactNode[] {
  const out: ReactNode[] = [];
  let key = 0;
  const emit = (text: string, cls: string, hit: Hit | null) => {
    if (text === "") return;
    const classes = [cls, hit ? "hit" : "", hit && hit === active ? "on" : ""].filter(Boolean).join(" ");
    out.push(
      <span key={key++} className={classes}>
        {text}
      </span>,
    );
  };
  let cursor = offset;
  for (const token of tokens(line)) {
    let rest = token.text;
    let at = cursor;
    while (rest !== "") {
      const hit = hits.find((item) => item.start < at + rest.length && item.end > at) ?? null;
      if (!hit) {
        emit(rest, token.cls, null);
        break;
      }
      const stop = Math.min(rest.length, hit.end - at);
      emit(rest.slice(0, stop), token.cls, hit);
      rest = rest.slice(stop);
      at += stop;
    }
    cursor += token.text.length;
  }
  return out;
}

/** YAML document editor: a line-number gutter, syntax colouring and a Ctrl+F
 * find bar around a plain textarea. The colouring is painted in a <pre> behind a
 * transparent textarea, which keeps the document editable — and the bundle
 * small — without pulling in an editor library. */
export function YamlEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const sheet = useRef<HTMLPreElement | null>(null);
  const gutter = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  /** Caret to restore after a Tab rewrites the document. */
  const caret = useRef<[number, number] | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [regex, setRegex] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [at, setAt] = useState(0);

  const lines = useMemo(() => value.split("\n"), [value]);
  const starts = useMemo(() => {
    const out: number[] = [];
    let offset = 0;
    for (const line of lines) {
      out.push(offset);
      offset += line.length + 1;
    }
    return out;
  }, [lines]);
  const expression = useMemo(() => pattern(query, regex), [query, regex]);
  const hits = useMemo(() => findHits(value, expression), [value, expression]);
  const current = hits.length === 0 ? null : hits[Math.min(at, hits.length - 1)] ?? null;
  const broken = query !== "" && expression == null;

  /** Paints the copy and the gutter from the textarea's own scroll position. */
  const sync = () => {
    const from = area.current;
    if (!from) return;
    if (sheet.current) {
      sheet.current.scrollTop = from.scrollTop;
      sheet.current.scrollLeft = from.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = from.scrollTop;
  };

  useEffect(sync, [value, hits, current]);

  // Bring the active hit into view, leaving focus where the user is typing.
  useEffect(() => {
    const box = area.current;
    if (current == null || !box) return;
    const line = value.slice(0, current.start).split("\n").length - 1;
    const height = parseFloat(getComputedStyle(box).lineHeight) || 0;
    box.scrollTop = Math.max(0, line * height - box.clientHeight / 3);
    sync();
  }, [current, value]);

  useEffect(() => {
    if (findOpen) field.current?.focus();
  }, [findOpen]);

  // A rewritten document drops the selection, so put it back where it belongs.
  useLayoutEffect(() => {
    const box = area.current;
    const next = caret.current;
    if (!box || !next) return;
    caret.current = null;
    box.setSelectionRange(next[0], next[1]);
  });

  const onAreaKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const box = event.currentTarget;
    const from = box.selectionStart;
    const to = box.selectionEnd;
    // A bare caret takes an indent where it stands; anything else shifts lines.
    if (!event.shiftKey && from === to) {
      caret.current = [from + INDENT.length, from + INDENT.length];
      onChange(value.slice(0, from) + INDENT + value.slice(to));
      return;
    }
    const shifted = shiftLines(value, from, to, !event.shiftKey);
    if (!shifted) return;
    caret.current = [shifted.from, shifted.to];
    onChange(shifted.text);
  };

  const step = (delta: number) => {
    setAt((index) => (hits.length === 0 ? 0 : (index + delta + hits.length) % hits.length));
  };

  /** Rewrites the active match, expanding `$1` style templates in regex mode. */
  const replaceOne = () => {
    if (current == null || expression == null) return;
    let text = replacement;
    if (regex) {
      const probe = new RegExp(expression.source, expression.flags);
      probe.lastIndex = current.start;
      const match = probe.exec(value);
      if (match?.index === current.start) text = expand(match, replacement);
    }
    onChange(value.slice(0, current.start) + text + value.slice(current.end));
  };

  const replaceEvery = () => {
    if (expression == null || hits.length === 0) return;
    const fresh = new RegExp(expression.source, expression.flags);
    onChange(regex ? value.replace(fresh, replacement) : value.replace(fresh, () => replacement));
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setFindOpen(true);
    }
  };

  const onFindKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setFindOpen(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  const onReplaceKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setFindOpen(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      replaceOne();
    }
  };

  const shown =
    query === "" ? "" : broken ? "bad pattern" : hits.length === 0 ? "no matches" : `${(current ? hits.indexOf(current) : 0) + 1}/${hits.length}`;

  return (
    <div className="yaml-editor" onKeyDown={onKeyDown}>
      {findOpen ? (
        <div className="find-bar">
          <div className="find-row">
            <input
              ref={field}
              className="find-input"
              value={query}
              placeholder={regex ? "Find with a regex" : "Find in manifest"}
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
                setAt(0);
              }}
              onKeyDown={onFindKey}
            />
            <span className="find-count">{shown}</span>
            <button
              className={regex ? "icon mode on" : "icon mode"}
              title="Regular expression"
              aria-label="Regular expression"
              aria-pressed={regex}
              onClick={() => setRegex((on) => !on)}
            >
              .*
            </button>
            <button
              className={replaceOpen ? "icon on" : "icon"}
              title="Replace"
              aria-label="Replace"
              aria-pressed={replaceOpen}
              onClick={() => setReplaceOpen((on) => !on)}
            >
              <SwapIcon />
            </button>
            <button className="icon" title="Previous match" aria-label="Previous match" onClick={() => step(-1)}>
              <ChevronIcon up />
            </button>
            <button className="icon" title="Next match" aria-label="Next match" onClick={() => step(1)}>
              <ChevronIcon />
            </button>
            <button className="icon" title="Close find" aria-label="Close find" onClick={() => setFindOpen(false)}>
              ×
            </button>
          </div>
          {replaceOpen ? (
            <div className="replace-row">
              <input
                className="find-input"
                value={replacement}
                placeholder={regex ? "Replace with, $1 allowed" : "Replace with"}
                spellCheck={false}
                onChange={(event) => setReplacement(event.target.value)}
                onKeyDown={onReplaceKey}
              />
              <button
                className="icon text"
                title="Replace this match"
                aria-label="Replace this match"
                disabled={current == null}
                onClick={replaceOne}
              >
                Replace
              </button>
              <button
                className="icon text"
                title="Replace every match"
                aria-label="Replace every match"
                disabled={hits.length === 0}
                onClick={replaceEvery}
              >
                All
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="editor-body">
        <div className="gutter" ref={gutter} aria-hidden="true">
          {lines.map((_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        <div className="sheet">
          <pre className="highlight" ref={sheet} aria-hidden="true">
            {lines.map((line, index) => (
              <Fragment key={index}>
                {paint(line, starts[index] ?? 0, hits, current)}
                {index < lines.length - 1 ? "\n" : null}
              </Fragment>
            ))}
          </pre>
          <textarea
            className="yaml"
            ref={area}
            value={value}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onAreaKeyDown}
            onScroll={sync}
          />
        </div>
      </div>
    </div>
  );
}

function SwapIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M3 5.5h9M9.5 3 12 5.5 9.5 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 10.5H4M6.5 8 4 10.5 6.5 13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ up = false }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d={up ? "M4.2 9.6 8 5.8l3.8 3.8" : "M4.2 6.4 8 10.2l3.8-3.8"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
