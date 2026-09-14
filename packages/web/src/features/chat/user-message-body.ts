/**
 * Shared "what did the user actually write" extraction for a user_text item, mirroring
 * MessageItem's parse chain (handoff / model-switch → scheduled → skills → element references →
 * attachment lines) without any rendering. Harness-injected inputs never reach this parse: both
 * callers skip them on the item's `sender` stamp. Input history and the conversation outline both
 * need this reduction, and each re-implementing the chain would drift from the renderer the
 * moment a new protocol block is added — this module is the single non-rendering copy.
 *
 * An element reference belongs here for the same reason a `[use_skills]` block does: the payload is
 * machine text the panel wrote (see element-reference.ts), and a history entry that reads as a page
 * of JSON is not the thing the user typed.
 */
import {
  parseBackgroundTaskDoneMessage,
  parseHandoffMessage,
  parseModelSwitchMessage,
  parseScheduledMessage,
} from "./agent-handoff";
import { parseSkillsMessage } from "./skill-use";
import { parseElementReferences } from "./element-reference";
import { splitAttachments } from "../../lib/attachments";

export interface UserMessageBody {
  /** What remains once protocol blocks and attachment lines are stripped: the text the user wrote (trimmed; may be empty for e.g. an image-only message). */
  body: string;
  /** True when the message was injected by a scheduled-task trigger rather than typed into the composer. */
  scheduled: boolean;
  /**
   * True when the message is a background completion notice ([background_task_done] block);
   * `body` is then the harness-written report text after the block — a readable outline
   * title for the notice's turn, but never something the user typed (input history skips it).
   */
  backgroundDone?: boolean;
}

/**
 * Parses a user_text item's raw text down to the user-authored body. Returns null for
 * machine-only source blocks ([handoff_from] / [model_switch_from]) — those render as
 * banners and carry no user prose at all.
 */
export function parseUserMessageBody(raw: string): UserMessageBody | null {
  if (parseHandoffMessage(raw) || parseModelSwitchMessage(raw)) return null;
  // Same position as MessageItem's chain: a completion notice renders as a banner and
  // carries no goal/scheduled/skills blocks — the report text is all there is.
  const backgroundDone = parseBackgroundTaskDoneMessage(raw);
  if (backgroundDone) {
    return { body: backgroundDone.rest.trim(), scheduled: false, backgroundDone: true };
  }
  const scheduled = parseScheduledMessage(raw);
  const afterScheduled = scheduled ? scheduled.rest : raw;
  const skills = parseSkillsMessage(afterScheduled);
  const references = parseElementReferences(skills ? skills.rest : afterScheduled);
  const { text } = splitAttachments(references.body);
  return {
    body: text.trim(),
    scheduled: scheduled !== null,
  };
}
