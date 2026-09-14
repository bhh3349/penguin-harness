/**
 * One element reference in the transcript: a single collapsed row — the element's name and where it
 * was written — that expands to exactly what the panel put into the message (its line of prose, then
 * the payload JSON).
 *
 * Why collapsed: the payload is the Agent's channel, not reading material. It is kilobytes of
 * `parentChain`, computed styles and a source snippet, and in the bubble it arrived in it was printed
 * verbatim — the user had to scroll past a wall of JSON to find their own sentence. Collapsed keeps
 * it out of the way; expanding keeps it *available*, which is what `D30`'s mitigation ("the payload
 * is shown before it goes") rests on now that the panel no longer renders a payload card (`D33`).
 *
 * The transcript already collapses protocol blocks this way (`skills-banner.tsx`, the handoff and
 * scheduled notices); this row differs in one thing only — it opens, because unlike a `[use_skills]`
 * list a payload is something a user can be owed a look at.
 */
import { useState } from "react";
import { Chevron } from "../../components/ui/chevron";
import { GlyphIcon } from "../../components/ui/glyph-icon";
import { ELEMENT_PICKER_ICON } from "../../components/ui/icons";
import { S } from "../../lib/strings";
import type { ParsedElementReference } from "./element-reference";

export function ElementReferenceChip({ reference }: { reference: ParsedElementReference }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex w-full flex-col items-end">
      <button
        type="button"
        aria-expanded={open}
        title={S.chat.elementReferenceTitle}
        onClick={() => setOpen((expanded) => !expanded)}
        className="anim-pop flex w-fit max-w-full items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-left text-xs text-gray-600 transition-colors duration-150 hover:bg-gray-100 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        <GlyphIcon
          d={ELEMENT_PICKER_ICON}
          size={13}
          className="shrink-0 text-gray-400 dark:text-gray-500"
        />
        <span className="min-w-0 truncate">{reference.label}</span>
        <Chevron open={open} size={12} className="text-gray-400 dark:text-gray-500" />
      </button>
      {/* The message's own bytes, unedited: the prose the panel wrote and the payload as it was sent.
          Selectable, so the block can be copied out without going to the Trace page. */}
      {open && (
        <pre className="wrap-anywhere mt-1.5 max-h-72 max-w-[88%] overflow-auto rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-gray-700 md:max-w-[75%] dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
          {reference.raw}
        </pre>
      )}
    </div>
  );
}
