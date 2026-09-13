/**
 * The chat dock's UI workbench panel: point it at a running dev server, pick an element in the
 * page, and hand that element to the conversation with enough for the Agent to edit it without
 * searching — the file and line it was written on, its selector and computed style, and a
 * screenshot.
 *
 * The panel is the only place in the app that embeds someone else's site: the user's dev server is
 * a plain page whose DOM we read, never a document we author. It is therefore dev-only and
 * desktop-only by design, and it says both rather than degrading silently — a production build
 * carries neither the source maps nor the positions this feature locates elements with, and a
 * browser tab has no guest element to read a page through.
 *
 * What is here now is the address, the guest and the picker: the address row remembers where you
 * pointed it, the probe offers the dev servers it found instead of making you guess a port, a dot
 * where a browser keeps its padlock and a line under the row name what went wrong in the terms that
 * suggest the next move (nothing on the port, a timeout, a page that will not be read) instead of
 * calling every failure a connection error, and the arrow at the end of the row is the switch for
 * element selection, exactly as it is in DevTools: press it and the page highlights what is under
 * the cursor and locks it on a click while that click is stopped from reaching the page; press it
 * again and the page is the user's again, with the picks still in hand.
 *
 * A picked element becomes the frozen v1 payload (§6) right here: `element-payload.ts` assembles it
 * from the element's facts, the page it was found on, and the Session's workspace — which is the
 * project being previewed, and the only thing that makes a relative source path unambiguous. The
 * panel no longer draws that payload back (L2.2b): the card that listed it field by field, and then
 * as JSON, is gone, and with it the last place a person could read what the Agent is about to be
 * told *before* sending — the payload still travels, on `加入对话`, into the composer's chip and the
 * message that chip is sent in. The source half is resolved from the page's own framework evidence
 * (`source-resolution.ts`), and when it cannot be, the four tiers it can land in are still listed
 * under the support fold (`source-tier.ts`) instead of only saying that it has nothing — a page with
 * no readable source map is a documented limit of this feature (PRD FR-07), not a bug in it.
 *
 * Several elements can be picked in one go (L2.1): multi-select is a *state inside pick mode* that
 * accumulates clicks and can drop them one by one, 多选 marks it, 清除 empties the whole batch at
 * once, and `加入对话` stages **one** chip carrying a v2 payload — one `page`, one `elements` array,
 * ordered by file — so a batch is one message rather than three. One element is still v1, unchanged:
 * the shape follows the count, so the message an Agent already knows how to read is not re-shaped for
 * the user who picked a single element.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { S } from "../../lib/strings";
import { Button } from "../../components/ui/button";
import { GlyphIcon } from "../../components/ui/glyph-icon";
import {
  ADD_TO_CHAT_ICON,
  CLEAR_ICON,
  ELEMENT_PICKER_ICON,
  ENTER_ICON,
  MULTI_PICK_ICON,
  REFRESH_ICON,
} from "../../components/ui/icons";
import { Input } from "../../components/ui/input";
import { Tooltip } from "../../components/ui/tooltip";
import { ICON_SIZE } from "../../lib/icon-scale";
import { toneDot, toneStrip } from "../../lib/tone";
import type { Tone } from "../../lib/tone";
import type { ComposerReference } from "../../lib/workspace-tree";
import { inspectPage, probeCandidatePorts } from "./dev-server-probe";
import type { PageInspection, PortProbe } from "./dev-server-probe";
import { createGuest, destroyGuest, desktopShell, guestReady } from "./preview-guest";
import type {
  GuestConsoleEvent,
  GuestElement,
  GuestFailEvent,
  GuestNavigateEvent,
} from "./preview-guest";
import {
  describeTarget,
  elementFromGuest,
  parsePickerMessage,
  pickerCommand,
  pickerFrameCount,
  pickerMulti,
  pickerResolve,
  pickerScript,
  pickerSetPicked,
} from "./element-picker";
import type { ElementFacts, PageFacts } from "./element-picker";
import { boundsNotes } from "./element-bounds";
import type { BoundsNote } from "./element-bounds";
import {
  batchRefId,
  buildBatchPayload,
  buildPayload,
  elementLabel,
  elementReferenceText,
  groupByFile,
} from "./element-payload";
import type {
  ElementPayload,
  ElementPayloadBatch,
  PayloadElement,
  PayloadInput,
  PayloadSource,
} from "./element-payload";
import { batchDecision, registerElementSource } from "./element-references";
import type { ElementGoneReason, ElementRefresh } from "./element-references";
import { createModuleReader, resolveSource } from "./source-resolution";
import type { SourceGapReason } from "./source-tier";
import {
  ADDRESS_KEY,
  currentPick,
  initialAddress,
  normalizeAddress,
  pickMode,
  reduceGuest,
  reducePick,
  selectionIdentity,
  sourceFor,
  NO_PICK,
  type GuestState,
  type LoadFailure,
  type PickEvent,
  type PickMode,
  type PickState,
  type ResolvedSources,
} from "./workbench-state";

function readStoredAddress(): string | null {
  try {
    return localStorage.getItem(ADDRESS_KEY);
  } catch {
    return null;
  }
}

function rememberAddress(url: string): void {
  try {
    localStorage.setItem(ADDRESS_KEY, url);
  } catch {
    // A refused write (private mode, quota) costs the user a retyped address, nothing more.
  }
}

function failureText(failure: LoadFailure, code: number, description: string): string {
  const named: Record<LoadFailure, string> = {
    refused: S.workbench.failure.refused,
    timeout: S.workbench.failure.timeout,
    dns: S.workbench.failure.dns,
    blocked: S.workbench.failure.blocked,
    "http-error": S.workbench.failure.httpError,
    crashed: S.workbench.failure.crashed,
    aborted: S.workbench.failure.aborted,
    other: S.workbench.failure.other,
  };
  const detail = code === 0 ? description : `${description || "?"} ${code}`;
  return `${named[failure]} · ${detail}`;
}

/** What the page on the other end can be expected to give us, said plainly. */
function tierText(result: PageInspection): string {
  if (result.sourceMap === "present") return S.workbench.tierPrecise;
  if (result.sourceMap === "none") return S.workbench.tierDegraded;
  return result.kind === "listening" ? S.workbench.tierOpaque : S.workbench.tierUnknown;
}

/**
 * The origin of an address, for asking whether two of them are the same document host. A path is not
 * part of the answer: a route change inside the page is the same page, and a chip stays true across
 * one. An unparseable address has no origin, which compares equal only to itself.
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function probeSuffix(probe: PortProbe): string {
  if (probe.kind === "vite") return "Vite";
  return probe.kind === "page" ? S.workbench.probeWeb : S.workbench.probeOpaque;
}

/** One element a chip was staged with: what to re-read it by, and what to call it if it is gone. */
interface StagedElement {
  /** The element's own half of the payload, as it was staged — `refId`, path, source site, style. */
  payload: PayloadElement;
  /** The page it was picked on: a chip is about one document, and another one invalidates it (AC-11c). */
  page: PageFacts;
  /** The facts behind the payload, so a member that cannot be re-read keeps its snapshot unchanged. */
  target: ElementFacts;
  label: string;
}

/**
 * What one chip holds (M4.1): the payload(s) to re-resolve at send time.
 *
 * A single pick and a batch are kept apart rather than folded into "a list of one", because the *shape
 * of the message* depends on which it is — one element is a v1 payload, several are a v2 batch
 * (L2.1-b) — and the chip should not have to count its way to that answer.
 */
type StagedEntry =
  { kind: "single"; element: StagedElement } | { kind: "batch"; elements: StagedElement[] };

/**
 * What one re-read of a staged element came back with (the page half of a chip, M4.1).
 *
 * `built` is the v1 payload as of now — what a single-element chip's message is composed from — and it
 * travels beside `element` rather than inside it because a batch member is not a v1 payload (L2.1-b):
 * the shared pieces are `element`'s, and the whole-payload shape belongs to whoever is composing.
 */
type StagedRead =
  | { kind: "refreshed"; element: StagedElement; built: ElementPayload; moved: boolean }
  | { kind: "gone"; reason: ElementGoneReason }
  | { kind: "unknown" };

/** Elements a send-time re-resolution lost, and which way the send went (L2.1-d). */
interface GoneReport {
  entries: { label: string; reason: ElementGoneReason }[];
  /** True when the message was **held** — every element of the chip had gone. */
  held: boolean;
}

export function WorkbenchPanel({
  workspace,
  onAddReference,
}: {
  /** The Session's workspace: the project being previewed, which is what the payload's root names. */
  workspace: string;
  /**
   * Stage the picked element in the composer. The panel builds the reference itself — the label the
   * chip wears, the `refId` that makes staging it twice an update, and the message text — because
   * everything it needs is here; the chat page only has to hand the chip to whoever is listening.
   */
  onAddReference: (reference: ComposerReference) => void;
}) {
  const inShell = desktopShell();
  const [draft, setDraft] = useState(() => initialAddress(readStoredAddress()));
  /** The address the guest is actually pointed at; null until the first load. */
  const [target, setTarget] = useState<string | null>(null);
  const [guestState, setGuestState] = useState<GuestState>({ kind: "idle" });
  const [inspection, setInspection] = useState<PageInspection | null>(null);
  const [probes, setProbes] = useState<PortProbe[] | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const guestRef = useRef<GuestElement | null>(null);
  const [pick, setPick] = useState<PickState>(NO_PICK);
  /**
   * The same state, readable from the guest's own event handlers: those are installed once per
   * address, and re-creating them on every hover would recreate the guest.
   */
  const pickRef = useRef<PickState>(NO_PICK);
  const mode = pickMode(pick);
  /**
   * The source half of the payload, resolved from the page's own framework evidence. It is state
   * rather than part of the memo below because resolving it is asynchronous: it fetches the module
   * the element was compiled from and reads the source map inside it (M3).
   *
   * It is stored *tagged* with the selection it answers for (M5.1), because the pick and the answer
   * do not change state in the same tick: untagged, the frame between a new pick and its resolution
   * showed the new element beside the previous element's file and line — which the probe caught both
   * in the DOM and in a `rAF`, so it was drawn, not merely held (see `sourceFor`).
   */
  const [resolvedSources, setResolvedSources] = useState<ResolvedSources<PayloadSource>>(new Map());
  /** The module URLs the page loaded — the fallback when a framework names no module at all. */
  const moduleUrlsRef = useRef<string[]>([]);
  /**
   * What was staged into the composer, by `refId`: the payload the chip carries, and the label it
   * wears. This is the other half a send-time re-resolution needs — the path and the anchor to look
   * the element up by — and the name to report it under when it is not found (M4.1).
   */
  const stagedPayloads = useRef<Map<string, StagedEntry>>(new Map());
  /**
   * Elements a send-time re-resolution could not find. The panel is where that gets said out loud —
   * the composer marks the chip and holds the message, and this is the line that explains why. For a
   * batch it also says which way the send went (L2.1-d): dropped, or held.
   */
  const [goneReport, setGoneReport] = useState<GoneReport>({ entries: [], held: false });
  /**
   * Frames the loaded page embeds (M4.4, PRD §9.4). Nothing inside one can be picked, and the panel
   * only knows to say so because the page counted them; `null` while nobody has asked.
   */
  const [frameCount, setFrameCount] = useState<number | null>(null);

  /**
   * Ask the page which modules it loaded. Cheap, read-only, and the only thing the React 18 route
   * needs when `_debugSource` is absent: a component's compiled text is distinctive enough to find
   * the module it came from by searching these.
   */
  const collectModuleUrls = useCallback(async () => {
    const guest = guestRef.current;
    if (guest === null) return;
    try {
      const urls = await guest.executeJavaScript(
        'performance.getEntriesByType("resource").map(function (e) { return e.name; })',
      );
      moduleUrlsRef.current = Array.isArray(urls) ? urls.filter((u) => typeof u === "string") : [];
    } catch {
      // A guest that went away mid-call: the next document collects its own list.
    }
  }, []);

  /**
   * The element the card is about — the last one picked — and what still reads "the selection":
   * the §9.4 bounds and the line in the picker row. A batch is shown beside it (a count and a list
   * of chips), not instead of it.
   */
  const selected = currentPick(pick);

  /**
   * What one element contributes to a message: its facts, the page it came from, and the source the
   * panel has resolved for it — or nothing, which is written out as `confidence: "none"` rather than
   * invented (the honest fourth level of §6 rule 2).
   *
   * Built from the picks on every render rather than cached, because `projectRoot` (the Session's
   * workspace) can change under a panel that is deliberately not keyed by Session — switching
   * conversations must not keep pointing the next payload at the previous project.
   */
  const items: PayloadInput[] = useMemo(() => {
    if (pick.page === null) return [];
    return pick.picked.map((target) => {
      const resolved = sourceFor(
        resolvedSources,
        selectionIdentity(pick.page!.url, target.cssSelector),
      );
      return {
        target,
        page: pick.page!,
        projectRoot: workspace,
        ...(resolved === null ? {} : { source: resolved }),
      };
    });
  }, [pick.picked, pick.page, workspace, resolvedSources]);

  /**
   * The payload for what is picked. **One element is v1 and several are v2** (L2.1-b) — the shape
   * follows the count, not the mode, so a single pick in multi-select is the same payload L1 sends and
   * an Agent that has only ever seen one element never meets a new shape.
   */
  const payload = useMemo<ElementPayload | ElementPayloadBatch | null>(() => {
    const first = items[0];
    if (first === undefined) return null;
    return items.length === 1 ? buildPayload(first) : buildBatchPayload(items);
  }, [items]);

  /**
   * The page the picks are about, named as a value rather than as an object.
   *
   * The effect below re-resolves when the batch changes *or* when the document does, and it must not
   * re-resolve on hover: `hover` rewrites the state (and the page facts with it) on every element the
   * cursor crosses — one fetch per picked element per hovered element is work nobody asked for. The
   * picks' own array identity already carries the first half (`reducePick` only ever replaces it for a
   * real change to the selection), and this URL carries the second.
   */
  const pickedPageUrl = pick.page === null ? null : pick.page.url;

  /**
   * Resolve where the picked elements are written, as soon as the page reports a pick. The page hands
   * over its framework's own evidence (`origin`), and this reads the module that evidence names and
   * maps the generated position back to a source location. It is deliberately *not* awaited by the
   * card: the DOM half of the payload is readable immediately, and the source row fills in when — and
   * if — the location resolves. An element with no evidence at all stays `none`, which is what an
   * element in a production build is.
   *
   * Every pick resolves again on **every change of the batch** — a new element added, one taken out, or
   * the same element picked again, which is the case M4.1 measured: after a save the element has moved,
   * and a re-pick has to be able to say so. The answers are keyed by selection identity (M5.1), and the
   * map is emptied with the batch on purpose: an answer thrown away with the batch is one that can
   * never be shown for the next one.
   *
   * The module text is read **fresh** for every pick, and that is a correction rather than a
   * preference (M4.1, measured in `实测脚本/m41-回指刷新验收/`): the reader used to cache by URL, which
   * is exactly the wrong key here. A dev server serves a module's *current* text at the same URL, so
   * after the user saved a file the cached copy was the pre-save answer — the card then showed the
   * line the element no longer was on, while the element on screen had moved. The one thing the panel
   * must never do is show a location as a fact when the file has moved on; a re-fetch on localhost is
   * the cheaper side of that trade.
   */
  useEffect(() => {
    // Read through the ref: the handler that changed the picks wrote the state there first, and the
    // page facts are the freshest ones rather than the ones this render was painted from.
    const state = pickRef.current;
    const page = state.page;
    if (state.picked.length === 0 || page === null) {
      setResolvedSources(new Map());
      return;
    }
    let cancelled = false;
    // Emptying the map is about `pending`, not about safety: the keys already keep an answer from
    // being shown for another selection. It goes away with the batch so the rows read as "resolving"
    // rather than as the previous answer for the *same* element, which may have moved on disk (M4.1).
    setResolvedSources(new Map());
    for (const target of state.picked) {
      const identity = selectionIdentity(page.url, target.cssSelector);
      const record = (resolved: PayloadSource): void => {
        if (cancelled) return;
        setResolvedSources((previous) => new Map(previous).set(identity, resolved));
      };
      void resolveSource(target.origin ?? null, {
        pageUrl: page.url,
        projectRoot: workspace,
        fetchText: createModuleReader(),
        moduleUrls: moduleUrlsRef.current,
      })
        .then(record)
        .catch(() => {
          // `resolveSource` reports its own failures as `none`; this is for the unexpected one, and it
          // must not leave the previous element's location on screen.
          record({ confidence: "none" });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [pick.picked, pickedPageUrl, workspace]);

  /**
   * The chip a payload becomes: the name a person reads, the `refId` that says which element it is,
   * and the message body the Agent receives. One function for the two moments a chip is made — staged
   * by hand, and refreshed at send time — so the two can never disagree about what a chip carries.
   */
  const referenceOf = useCallback(
    (target: ElementFacts, built: ElementPayload): ComposerReference => {
      const label = elementLabel(target);
      // The one fact the payload (§6 v1, frozen) has no field for, said in the prose instead: an
      // element the picker could not reach into is a host or a frame, not the thing under the cursor
      // (M4.4). An Agent reading only the JSON would style the host and wonder why nothing moved.
      const note =
        target.domContext === undefined
          ? undefined
          : S.workbench.domContextMessage[target.domContext];
      return {
        kind: "element",
        label,
        refId: built.target.refId,
        text: elementReferenceText(S.workbench.elementLead(label, built.page.url, note), built),
      };
    },
    [],
  );

  /**
   * The line above a batch in the message: what the batch is, then the elements **by file** (L2.1-c).
   *
   * It is built from the same `groupByFile` that orders the payload's `elements`, so the sentence and
   * the JSON can never disagree about which edits belong together, and it names each element the way
   * the chip does (`span.badge "hello"`) with the line the panel resolved for it — the location is in
   * the prose as well as in the JSON because a person reads the message too, and the file's own line
   * is the first thing they check.
   */
  const batchLead = useCallback((inputs: readonly PayloadInput[]): string => {
    const groups = groupByFile(inputs);
    const lines = groups.map((group) =>
      S.workbench.batchLine(
        group.file ?? S.workbench.batchNoFile,
        group.members
          .map((member) =>
            S.workbench.batchItem(elementLabel(member.target), member.source?.line ?? null),
          )
          .join("、"),
      ),
    );
    return [S.workbench.batchLead(inputs.length, groups.length), ...lines].join("\n");
  }, []);

  /**
   * The chip a batch becomes: one chip for one message (L2.1-b), named by how many elements and files
   * it carries, and keyed by the set of elements it holds — so staging the same batch twice is an
   * update rather than a second copy, exactly as re-staging one element is.
   */
  const batchReferenceOf = useCallback(
    (inputs: readonly PayloadInput[], built: ElementPayloadBatch): ComposerReference => {
      const files = groupByFile(inputs).length;
      return {
        kind: "element",
        label: S.workbench.batchChip(inputs.length, files),
        refId: batchRefId(built.elements.map((element) => element.target.refId)),
        text: elementReferenceText(batchLead(inputs), built),
      };
    },
    [batchLead],
  );

  /**
   * Hand the payload to the conversation: a chip in the composer, and — on send — the payload as a
   * fenced JSON block behind a line of prose. Nothing is sent and the draft is untouched: what the
   * workbench contributes is a thing the message is about, not words in the user's sentence.
   *
   * The payload is also *kept*, by `refId`: at send time the composer asks this panel to re-resolve
   * every element chip, and this is what it answers from (M4.1).
   */
  const addToConversation = useCallback(() => {
    if (payload === null) return;
    const reference =
      payload.schemaVersion === 2
        ? batchReferenceOf(items, payload)
        : referenceOf(items[0]!.target, payload);
    const entry: StagedEntry =
      payload.schemaVersion === 2
        ? {
            kind: "batch",
            elements: items.map((item, index) => ({
              payload: payload.elements[index]!,
              page: item.page,
              target: item.target,
              label: elementLabel(item.target),
            })),
          }
        : {
            kind: "single",
            element: {
              payload,
              page: items[0]!.page,
              target: items[0]!.target,
              label: elementLabel(items[0]!.target),
            },
          };
    if (reference.refId === undefined) return;
    stagedPayloads.current.set(reference.refId, entry);
    setGoneReport({ entries: [], held: false });
    onAddReference(reference);
  }, [payload, items, onAddReference, referenceOf, batchReferenceOf]);

  /**
   * Re-read **one** staged element from the page as it is now (M4.1 / AC-8) — the page half of both
   * the single chip and the batch, which is why it is a function of its own.
   *
   * Three honest ways out, and no fourth:
   *
   * - **fresh** — the element is there (same tag, same `data-testid` when it had one), and here it is,
   *   as of now. `moved` says the source site is not the one it was staged with.
   * - **gone** — the page does not have it (`missing`), something else is at that path (`replaced`),
   *   or the preview is on another page altogether (`page-changed`, AC-11c).
   * - **unknown** — we cannot check at all (no page loaded, no picker in it, or a guest that went away
   *   mid-call). The element keeps its snapshot, and nothing claims to have verified it.
   */
  const readStaged = useCallback(
    async (staged: StagedElement, pageUrl: string | null): Promise<StagedRead> => {
      const guest = guestRef.current;
      if (guest === null || pageUrl === null || !pickRef.current.live) return { kind: "unknown" };
      // The chip names a page; if the panel has been pointed somewhere else since, the chip is about a
      // document that is no longer on screen — and looking for its element in the new one is precisely
      // the mistake AC-11c names.
      if (originOf(staged.page.url) !== originOf(pageUrl)) {
        return { kind: "gone", reason: "page-changed" };
      }
      let answer: unknown = null;
      try {
        answer = await guest.executeJavaScript(
          pickerResolve(staged.payload.target.cssSelector, staged.payload.target.testId),
        );
      } catch {
        return { kind: "unknown" };
      }
      const found = elementFromGuest(answer);
      if (found === null) return { kind: "gone", reason: "missing" };
      // The path still matches something, but a same-shaped node is not the same element: the tag
      // (and, inside the picker, the testid) is what keeps "it moved" from being reported as "it is
      // still there" when the page was rewritten underneath the chip.
      if (found.target.tagName !== staged.payload.target.tagName) {
        return { kind: "gone", reason: "replaced" };
      }
      const source = await resolveSource(found.target.origin ?? null, {
        pageUrl: found.page.url,
        projectRoot: workspace,
        // A **fresh** reader on purpose: the module this element was compiled from is the file the
        // user just saved, and the cached copy of it is the stale answer this path exists to avoid.
        fetchText: createModuleReader(),
        moduleUrls: moduleUrlsRef.current,
      });
      const built = buildPayload({
        target: found.target,
        page: found.page,
        projectRoot: workspace,
        source,
      });
      const before = staged.payload.source;
      const moved =
        before.file !== built.source.file ||
        before.line !== built.source.line ||
        before.column !== built.source.column;
      return {
        kind: "refreshed",
        element: {
          payload: built,
          page: found.page,
          target: found.target,
          label: elementLabel(found.target),
        },
        built,
        moved,
      };
    },
    [workspace],
  );

  /**
   * Re-read a staged chip before the composer sends (M4.1 / AC-8, M4.5's AC-11c, L2.1-d).
   *
   * The composer calls this for every element chip immediately before a message is composed, so what
   * the message carries is the page's current answer rather than the snapshot taken when the chip was
   * staged. A single chip is L1's rule unchanged: gone holds the send, unknown keeps the snapshot.
   *
   * A batch re-reads **every** element and then asks `batchDecision`: all gone holds the message (there
   * is nothing left to edit), some gone sends it with the rest — minus the elements that vanished,
   * which the panel names and the chip counts. Rebuilding the chip from what survived is also what
   * makes the message itself smaller: the JSON the user reads in the panel is the JSON that goes out.
   */
  const refreshStaged = useCallback(
    async (refId: string): Promise<ElementRefresh> => {
      const staged = stagedPayloads.current.get(refId);
      if (staged === undefined || guestRef.current === null || target === null) {
        return { kind: "unknown" };
      }
      const reportGone = (
        entries: { label: string; reason: ElementGoneReason }[],
        held: boolean,
      ) => {
        setGoneReport({ entries, held });
      };
      if (staged.kind === "single") {
        const read = await readStaged(staged.element, target);
        if (read.kind === "unknown") return { kind: "unknown" };
        if (read.kind === "gone") {
          reportGone([{ label: staged.element.label, reason: read.reason }], true);
          return { kind: "gone", reason: read.reason };
        }
        const reference = referenceOf(read.element.target, read.built);
        // Re-keyed rather than updated in place: the id is derived from the site, so an element that
        // moved *has* a new one, and the old key would otherwise linger for every edit of the session.
        stagedPayloads.current.delete(refId);
        if (reference.refId !== undefined) {
          stagedPayloads.current.set(reference.refId, { kind: "single", element: read.element });
        }
        reportGone([], false);
        return { kind: "refreshed", reference, moved: read.moved };
      }

      // Every element is re-read before the decision is made, because the decision is about the batch
      // as a whole: which of them are gone is only known once they all have been asked.
      const reads: StagedRead[] = [];
      for (const element of staged.elements) {
        reads.push(await readStaged(element, target));
      }
      if (batchDecision(reads) === "hold") {
        const entries = reads.map((read, index) => {
          const element = staged.elements[index]!;
          return {
            label: element.label,
            reason: read.kind === "gone" ? read.reason : ("missing" as ElementGoneReason),
          };
        });
        reportGone(entries, true);
        // A single `gone` is what the composer acts on — it holds the message and names the chip; the
        // panel above is where each element's own reason is spelled out.
        return { kind: "gone", reason: entries[0]?.reason ?? "missing" };
      }
      const goneEntries: { label: string; reason: ElementGoneReason }[] = [];
      const kept: PayloadInput[] = [];
      let moved = false;
      reads.forEach((read, index) => {
        const element = staged.elements[index]!;
        if (read.kind === "gone") {
          goneEntries.push({ label: element.label, reason: read.reason });
          return;
        }
        // `unknown` keeps its snapshot: the page could not be asked, which is not the same answer as
        // "the page does not have it" (L1's rule, kept).
        const survivor = read.kind === "refreshed" ? read.element : element;
        if (read.kind === "refreshed" && read.moved) moved = true;
        kept.push({
          target: survivor.target,
          page: survivor.page,
          projectRoot: workspace,
          source: survivor.payload.source,
        });
      });
      const first = kept[0];
      if (first === undefined) return { kind: "gone", reason: "missing" };
      const rebuilt = kept.length === 1 ? buildPayload(first) : buildBatchPayload(kept);
      const reference: ComposerReference =
        rebuilt.schemaVersion === 2
          ? {
              ...batchReferenceOf(kept, rebuilt),
              ...(goneEntries.length === 0 ? {} : { dropped: goneEntries.length }),
            }
          : referenceOf(kept[0]!.target, rebuilt);
      stagedPayloads.current.delete(refId);
      const entries: StagedEntry =
        rebuilt.schemaVersion === 2
          ? {
              kind: "batch",
              elements: kept.map((item, index) => ({
                payload: rebuilt.elements[index]!,
                page: item.page,
                target: item.target,
                label: elementLabel(item.target),
              })),
            }
          : {
              kind: "single",
              element: {
                payload: rebuilt,
                page: first.page,
                target: first.target,
                label: elementLabel(first.target),
              },
            };
      if (reference.refId !== undefined) stagedPayloads.current.set(reference.refId, entries);
      reportGone(goneEntries, false);
      return { kind: "refreshed", reference, moved };
    },
    [target, workspace, referenceOf, batchReferenceOf, readStaged],
  );

  // The composer asks this panel — the only thing in the app that owns a guest — before it sends.
  // Registered once per mount, through a ref so the registration does not churn with every pick.
  const refreshRef = useRef(refreshStaged);
  refreshRef.current = refreshStaged;
  useEffect(() => registerElementSource({ refresh: (refId) => refreshRef.current(refId) }), []);

  /**
   * Tell the page what the panel holds: the mode, whether clicks accumulate, and the picks themselves.
   *
   * One function for all three because they are one state — the page is not allowed to have a pick the
   * panel has dropped, or to be following the cursor in single-select — and because the page both *is*
   * the thing that draws the highlights and *is not* the thing that decides what a click means
   * (L2.1-a). `missing` is a normal answer: a guest on its way out, whose next document installs its
   * own picker and is synced by `dom-ready`.
   */
  const syncGuest = useCallback(async (state: PickState) => {
    const guest = guestRef.current;
    if (guest === null) return;
    const commands = [
      pickerCommand(pickMode(state)),
      pickerMulti(state.multi),
      pickerSetPicked(state.picked.map((entry) => entry.cssSelector)),
    ];
    for (const command of commands) {
      try {
        await guest.executeJavaScript(command);
      } catch {
        // The guest can go away between a click and this call — a reload, a closed panel. The next
        // dom-ready installs the picker again and syncs whatever the state is by then.
        return;
      }
    }
  }, []);

  /**
   * The panel's one way to change picker state: the reducer decides, and the ref makes the decision
   * readable from the guest's event handlers (which are installed once per address).
   */
  const dispatchPick = useCallback((event: PickEvent) => {
    const next = reducePick(pickRef.current, event);
    pickRef.current = next;
    setPick(next);
  }, []);

  /**
   * Push that state to the page whenever one of the three things the page acts on changes.
   *
   * Deliberately not keyed on the state object: hover rewrites it on every element the cursor crosses,
   * and three IPC calls per hover would be work the page has no use for — and work m56's click-to-card
   * timings would pay for. `pickRef` rather than `pick` so the effect sends the state the reducer just
   * produced, not the one this render was painted from.
   */
  useEffect(() => {
    void syncGuest(pickRef.current);
  }, [pick.wanted, pick.multi, pick.picked, syncGuest]);

  /**
   * Esc in the panel itself. The page's Esc arrives over the console channel instead — whichever of
   * the two has focus sees the key, never both.
   */
  useEffect(() => {
    if (mode === "off") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      dispatchPick({ kind: "escape" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, dispatchPick]);

  /**
   * How many frames the page embeds, asked while the user is picking (M4.4, PRD §9.4).
   *
   * A frame's interior is another document, and nothing about the page on screen says so — the user
   * would just find that the card they want cannot be picked. The question is answered by the page
   * itself, re-asked whenever the document changes, and cleared the moment picking stops: a count
   * belongs to the document it was measured on.
   */
  useEffect(() => {
    if (mode !== "picking" || guestState.kind !== "ready") {
      setFrameCount(null);
      return;
    }
    const guest = guestRef.current;
    if (guest === null) return;
    let cancelled = false;
    void guest
      .executeJavaScript(pickerFrameCount())
      .then((value) => {
        if (!cancelled) setFrameCount(typeof value === "number" && value >= 0 ? value : null);
      })
      .catch(() => {
        // A guest that went away mid-call: the next document counts its own frames.
        if (!cancelled) setFrameCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, guestState]);

  // Find the dev servers before asking the user to type a port. The ports are on this machine
  // either way, so this runs in a browser tab too — that is where it is most useful, since a
  // browser tab cannot preview anything and the answer is still worth knowing.
  useEffect(() => {
    let cancelled = false;
    void probeCandidatePorts().then((found) => {
      if (!cancelled) setProbes(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback((raw: string) => {
    const url = normalizeAddress(raw);
    if (url === null) {
      setGuestState((state) =>
        reduceGuest(state, {
          kind: "failed",
          code: 0,
          description: S.workbench.badAddress,
        }),
      );
      return;
    }
    setDraft(url);
    rememberAddress(url);
    setTarget(url);
    setInspection(null);
    void inspectPage(url).then((result) => setInspection(result));
  }, []);

  // One guest per address. A new address is a new page, and everything derived from the old one —
  // including any element picked out of it — stops being true at that moment, not later.
  useEffect(() => {
    const container = containerRef.current;
    if (!inShell || target === null || container === null) return;
    const guest = createGuest(container, target);
    guestRef.current = guest;
    setGuestState((state) => reduceGuest(state, { kind: "navigating", url: target }));

    // Every signal below goes through `reduceGuest`: the order Electron delivers them in is not the
    // order of their meaning (a failed load still raises `dom-ready` for its error page), and that
    // rule is a tested one rather than a property of this effect's listener bodies.
    const onStarted = (event: Event) => {
      const { isMainFrame, url } = event as GuestNavigateEvent;
      if (isMainFrame === false) return;
      setGuestState((state) => reduceGuest(state, { kind: "navigating", url: url || target }));
    };
    const onReady = () => {
      setGuestState((state) =>
        reduceGuest(state, { kind: "ready", url: guest.getURL() || target }),
      );
      // The picker lives in the page's own JavaScript context, so it is gone after every navigation
      // (a Vite full reload included) and has to be put back. Installing and then applying the current
      // mode is one sequence on purpose: an installed picker that never got started would swallow
      // clicks without ever highlighting anything.
      void guest
        .executeJavaScript(pickerScript())
        .then((result) => {
          if (result !== "installed") return;
          dispatchPick({ kind: "installed" });
          void collectModuleUrls();
          return syncGuest(pickRef.current);
        })
        .catch(() => {
          // A guest that went away while we were talking to it: the next one installs its own picker.
        });
    };
    const onFailed = (event: Event) => {
      const { errorCode, errorDescription, isMainFrame } = event as GuestFailEvent;
      if (isMainFrame === false) return;
      setGuestState((state) =>
        reduceGuest(state, { kind: "failed", code: errorCode, description: errorDescription }),
      );
    };
    // The page's console is a shared channel: the picker reports over it (the one channel M1/E4a
    // measured to work without a host preload), and everything without our prefix is the page's own
    // logging — never mistaken for ours.
    const onConsole = (event: Event) => {
      const { message } = event as GuestConsoleEvent;
      const parsed = parsePickerMessage(typeof message === "string" ? message : "");
      if (parsed === null) return;
      switch (parsed.kind) {
        case "hover":
          dispatchPick({ kind: "hover", target: parsed.target, page: parsed.page });
          return;
        case "selected":
          dispatchPick({ kind: "selected", target: parsed.target, page: parsed.page });
          return;
        case "cleared":
          dispatchPick({ kind: "cleared" });
          return;
        case "exited":
          dispatchPick({ kind: "exited" });
          return;
        default:
          // installed / active / stopped are the picker acknowledging a command we sent; the panel
          // already knows, and reacting again would fight the user's switch.
          return;
      }
    };
    guest.addEventListener("did-start-navigation", onStarted);
    guest.addEventListener("dom-ready", onReady);
    guest.addEventListener("did-fail-load", onFailed);
    guest.addEventListener("console-message", onConsole);

    // Electron installs the guest's API when the element enters the document, so the check is a
    // frame late on purpose: asking synchronously reports "no such API" on a shell that works.
    const raf = requestAnimationFrame(() => {
      if (!guestReady(guest)) setGuestState((state) => reduceGuest(state, { kind: "unsupported" }));
    });

    return () => {
      cancelAnimationFrame(raf);
      guest.removeEventListener("did-start-navigation", onStarted);
      guest.removeEventListener("dom-ready", onReady);
      guest.removeEventListener("did-fail-load", onFailed);
      guest.removeEventListener("console-message", onConsole);
      destroyGuest(guest);
      guestRef.current = null;
      // Nothing is being picked any more — and what was selected belonged to the page that just went
      // away, so it is not carried over (the switch itself is: see `reducePick`).
      dispatchPick({ kind: "guest-gone" });
    };
  }, [inShell, target, dispatchPick, syncGuest]);

  if (!inShell) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {S.workbench.desktopOnly}
        </p>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {S.workbench.desktopOnlyDetail}
        </p>
        {probes !== null && probes.length > 0 && (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {S.workbench.foundPorts}{" "}
            {probes.map((probe) => `${probe.port}（${probeSuffix(probe)}）`).join("、")}
          </p>
        )}
      </div>
    );
  }

  /**
   * What the panel says about the page it is showing, in the two shapes a browser uses (L2.2b): a
   * state dot beside the address, and a line only when there is something to do about it.
   *
   * The dot carries FR-01's four states — 未连接 / 已连接 / 不支持 / 加载失败 — without a strip of
   * its own: the tone is what a glance reads, and the sentence (still naming the URL and this page's
   * own tier) is the dot's accessible name and its hover text. A healthy page therefore shows **no**
   * line at all, which is the point: the rows that used to sit under the address bar were paid for
   * out of the preview's height, and this panel is a browser.
   */
  const connection = ((): { tone: Tone; sentence: string } => {
    switch (guestState.kind) {
      case "ready": {
        const tier = inspection === null ? null : tierText(inspection);
        return {
          tone: inspection !== null && inspection.sourceMap === "present" ? "success" : "attention",
          sentence: [S.workbench.connected, guestState.url, tier]
            .filter((part): part is string => part !== null)
            .join(" · "),
        };
      }
      case "loading":
        return { tone: "busy", sentence: `${S.workbench.loading} ${guestState.url}` };
      case "unsupported-guest":
        return { tone: "danger", sentence: S.workbench.guestUnavailable };
      case "failed":
        return {
          tone: "danger",
          sentence: failureText(guestState.failure, guestState.code, guestState.description),
        };
      case "idle":
        return { tone: "muted", sentence: S.workbench.notConnected };
    }
  })();

  /**
   * The one line a page may still cost (L2.2b): a failure, and the two "there is no page yet" cases
   * that have a next move to offer. A page that loaded **with** source maps says nothing — the dot's
   * colour is the whole message. A page that loaded without them still says so, because which of the
   * four tiers a location lands in is a documented limit of this feature (FR-07), not connection
   * chatter, and it is the difference between a source line and none.
   */
  const notice = (() => {
    switch (guestState.kind) {
      case "unsupported-guest":
        return <p className={strip("danger")}>{S.workbench.guestUnavailable}</p>;
      case "loading":
        return null;
      case "ready":
        return inspection !== null && inspection.sourceMap !== "present" ? (
          <p className={strip("attention")}>{tierText(inspection)}</p>
        ) : null;
      case "failed":
        return (
          <p className={strip("danger")}>
            {failureText(guestState.failure, guestState.code, guestState.description)}
          </p>
        );
      case "idle":
        // Nothing found and nothing loaded yet: the first thing to say is where to get a server.
        return probes !== null && probes.length === 0 ? (
          <p className={strip("attention")}>{S.workbench.noDevServer}</p>
        ) : null;
    }
  })();

  /**
   * §9.4's matrix applied to what is on screen (M4.4): the two structures the picker cannot reach
   * into, an element that cannot be seen, and the frames the page embeds. Reasons here, sentences
   * below — the copy is bilingual and lives in the strings tables.
   */
  const bounds = boundsNotes({
    target: selected,
    picking: mode === "picking",
    frameCount,
  });
  const boundsHost = selected === null ? "" : describeTarget(selected);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* —— The browser's own row (L2.2b) —— a state dot where a browser keeps its padlock, the
          address, and the two things one does with a page: load it again, or start inspecting it.
          The pick control lives *here* rather than on a row of its own because this panel is a
          browser: the arrow beside the address is how element selection is entered, exactly as it
          is in DevTools, and with nothing being picked there is no second row to show. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <Tooltip label={connection.sentence} placement="bottom" className="shrink-0">
          <span
            data-workbench-connection={guestState.kind}
            role="img"
            aria-label={connection.sentence}
            className={`block size-2 rounded-full ${toneDot[connection.tone]}`}
          />
        </Tooltip>
        <Input
          size="sm"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-label={S.workbench.addressLabel}
          placeholder={S.workbench.addressPlaceholder}
          className="min-w-0 flex-1 font-mono"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") load(draft);
          }}
        />
        {/* The address's own "go": a browser has no load button, it has the key. Same action, same
            accessible name as the button it replaced (`载入`), so nothing that asks for it by name
            has to know it became a mark. */}
        <Tooltip label={S.workbench.load} placement="bottom" className="shrink-0">
          <Button
            size="icon"
            variant="primary"
            aria-label={S.workbench.load}
            onClick={() => load(draft)}
          >
            <GlyphIcon d={ENTER_ICON} size={ICON_SIZE.iconButton} />
          </Button>
        </Tooltip>
        {target !== null && (
          <Tooltip label={S.workbench.reload} placement="bottom" className="shrink-0">
            <Button
              size="icon"
              variant="ghost"
              aria-label={S.workbench.reload}
              onClick={() => {
                guestRef.current?.reload();
                if (target !== null) {
                  setGuestState((state) => reduceGuest(state, { kind: "navigating", url: target }));
                }
              }}
            >
              <GlyphIcon d={REFRESH_ICON} size={ICON_SIZE.iconButton} />
            </Button>
          </Tooltip>
        )}
        {guestState.kind === "ready" && (
          <Tooltip label={S.workbench.pickTitle} placement="bottom" className="shrink-0">
            {/* One name, two states: the button does not rename itself, it *looks* pressed — the
                same shape as the DevTools arrow it copies, and the reason `pickStart`/`pickStop`
                are gone. `aria-pressed` is what says the state to a screen reader. */}
            <Button
              size="icon"
              variant={mode === "off" ? "ghost" : "primary"}
              aria-label={S.workbench.pickTitle}
              aria-pressed={mode !== "off"}
              onClick={() => dispatchPick({ kind: "toggle" })}
            >
              <GlyphIcon d={ELEMENT_PICKER_ICON} size={ICON_SIZE.iconButton} />
            </Button>
          </Tooltip>
        )}
      </div>

      {/* Before anything is loaded this row *is* the empty state (FR-08/FR-11): the dev servers this
          panel can see, one click each, instead of making the user guess a port. Once a page is up it
          is gone — it answered its question, and every row here is taken from the preview. */}
      {guestState.kind !== "ready" && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-gray-200 px-3 py-1.5 dark:border-gray-800">
          <span className="mr-1 text-xs text-gray-400">{S.workbench.foundPorts}</span>
          {probes === null ? (
            <span className="text-xs text-gray-400">{S.workbench.probing}</span>
          ) : probes.length === 0 ? (
            <span className="text-xs text-gray-400">{S.workbench.noneFound}</span>
          ) : (
            probes.map((probe) => (
              <button
                key={probe.port}
                type="button"
                title={probe.title ?? probe.url}
                onClick={() => load(probe.url)}
                className="rounded-md border border-gray-200 px-2 py-0.5 font-mono text-xs text-gray-500 transition-colors duration-150 hover:bg-gray-100 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-800/60"
              >
                {probe.port}
                <span className="ml-1 font-sans text-gray-400">{probeSuffix(probe)}</span>
              </button>
            ))
          )}
        </div>
      )}

      {notice}

      {/* —— The selection interface (L2.2b) —— one row, and only what picking needs: its two states
          (多选, 暂离) as marks, what is picked as chips, and the one thing to do with what is
          picked. 加入对话 lives at the end of *this* row rather than on the payload card below: the
          card is a description of that action, not a second place to take it — one action, one
          entrance.

          The row outlives the picker itself (`mode` off with elements already picked), because
          those elements are still what 加入对话 is for. With neither, the panel is a browser, and
          that is the state it opens in. */}
      {guestState.kind === "ready" && (mode !== "off" || pick.picked.length > 0) && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-gray-200 px-3 py-1.5 dark:border-gray-800">
          {mode !== "off" && (
            <>
              {/* 多选 (L2.1-a) is a state *inside* pick mode, so its mark is offered only while
                  there is picking to be in, and `aria-pressed` carries which of the two it is —
                  the same shape as the arrow that got us here. */}
              <Tooltip label={S.workbench.multiStart} placement="bottom" className="shrink-0">
                <Button
                  size="icon"
                  variant={pick.multi ? "primary" : "ghost"}
                  aria-label={S.workbench.multiStart}
                  aria-pressed={pick.multi}
                  onClick={() => dispatchPick({ kind: "multi-toggle" })}
                >
                  <GlyphIcon d={MULTI_PICK_ICON} size={ICON_SIZE.iconButton} />
                </Button>
              </Tooltip>
              {/* (暂离 used to sit here — see the note on 清除 below.) */}
            </>
          )}
          {/* 清除 — the chips' own ×s raised to all of them at once, for a batch that got away from
              you. It stands where 暂离 used to, and 暂离 is gone (L2.2b): standing down only ever
              meant "the page is mine again, and my picks are still here", which the address bar's
              arrow does — it is that feature's switch, and it does not touch `picked` either. Unlike
              the two marks inside the picking group, this one lives *outside* it: it is about what is
              already picked, so it must still be reachable after the picker is switched off. */}
          {pick.picked.length > 0 && (
            <Tooltip label={S.workbench.clearPicks} placement="bottom" className="shrink-0">
              <Button
                size="icon"
                variant="ghost"
                aria-label={S.workbench.clearPicks}
                onClick={() => dispatchPick({ kind: "cleared" })}
              >
                <GlyphIcon d={CLEAR_ICON} size={ICON_SIZE.iconButton} />
              </Button>
            </Tooltip>
          )}
          {/* What is picked — or, before the first pick, what is under the cursor. One slot for
              both, because they are the same question at different moments, and because a count
              printed beside the list of the things counted says it twice (L2.2b). The count is not
              lost: it is the slot's accessible name, and `data-workbench-count` for the scripts. */}
          <div
            data-workbench-count={pick.picked.length}
            role="group"
            aria-label={
              pick.picked.length > 0 ? S.workbench.multiCount(pick.picked.length) : undefined
            }
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
          >
            {pick.picked.length === 0 ? (
              <span className="truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                {pick.hovered !== null && mode === "picking"
                  ? `${S.workbench.candidate} ${describeTarget(pick.hovered)}`
                  : ""}
              </span>
            ) : (
              pick.picked.map((entry) => (
                <span
                  key={entry.cssSelector}
                  data-workbench-pick={entry.cssSelector}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-gray-100 py-0.5 pl-2 pr-1 font-mono text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200"
                >
                  <span className="max-w-32 truncate">{describeTarget(entry)}</span>
                  <button
                    type="button"
                    aria-label={S.workbench.multiRemove(describeTarget(entry))}
                    onClick={() => dispatchPick({ kind: "unpick", cssSelector: entry.cssSelector })}
                    className="rounded p-0.5 text-gray-400 transition-colors duration-150 hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
          <Tooltip label={S.workbench.addToChat} placement="bottom" className="shrink-0">
            <Button
              size="icon"
              variant="primary"
              aria-label={S.workbench.addToChat}
              disabled={payload === null}
              onClick={addToConversation}
            >
              <GlyphIcon d={ADD_TO_CHAT_ICON} size={ICON_SIZE.iconButton} />
            </Button>
          </Tooltip>
        </div>
      )}

      {/* §9.4's bounds, said where they bite (M4.4): the structures the picker cannot enter, an element
          that cannot be seen, and the frames the page embeds. §2.3 requires saying it rather than
          quietly handing over a neighbour — so it sits directly under the row it qualifies. */}
      {bounds.length > 0 && (
        <div
          data-workbench-bounds="1"
          className={`shrink-0 border-b border-gray-200 px-3 py-1.5 dark:border-gray-800 ${strip("attention")}`}
        >
          <ul className="space-y-0.5 text-xs">
            {bounds.map((note) => (
              <li key={boundsKey(note)}>{boundsText(note, boundsHost)}</li>
            ))}
          </ul>
          {bounds.some((note) => note.kind === "not-visible") && (
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {S.workbench.notVisibleDetail}
            </p>
          )}
        </div>
      )}

      {/* What a send-time re-resolution found (AC-8, L2.1-d): elements the page no longer has, said
          here as well as on the chip, because this panel is the thing that asked the page the
          question. A batch that lost some of its elements was still **sent** — so the line under it
          says which of the two happened rather than assuming the message was held. */}
      {goneReport.entries.length > 0 && (
        <div
          data-workbench-gone={goneReport.held ? "held" : "dropped"}
          className={`shrink-0 border-b border-gray-200 px-3 py-1.5 dark:border-gray-800 ${strip("attention")}`}
        >
          <p className="text-xs">
            {goneReport.entries
              .map((entry) => S.workbench.goneElement(entry.label, entry.reason))
              .join(" ")}
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {goneReport.held ? S.workbench.goneElementDetail : S.workbench.goneElementDetailPartial}
          </p>
        </div>
      )}

      {/* The payload card used to sit here — every field of the frozen schema, then the JSON itself.
          It is gone (L2.2b): the panel is a browser, and a browser does not print the request body.
          What the card asserted — that nothing reaches the conversation the user could not have read
          first — now rests on the composer's chip alone, which names the element and its `refId` and
          whose message carries the payload. See `决策日志` D33 for what that costs. */}

      {/* §9.4's support matrix (5.4), as a fold — not a "?" (the frontend rule: a circled question
          mark may only sit beside a title, and this has none). It is shown exactly while no page is
          loaded, which is when the question it answers ("can this work on my project at all") is
          asked; once a page is up the tier line above says that page's own answer instead, and the
          preview keeps its height (the m25 pitfall: an expanded block left the preview 91px tall).
          Under the matrix sit the four limits a location comes with (5.4, D30) — the JSX-not-CSS
          distinction, the stylesheet short-circuit, the wrapping element behind `ambiguous`, and the
          unauthenticated return channel — because they are read at the same moment, before the panel
          is trusted with anything. */}
      {guestState.kind !== "ready" && (
        <details
          data-workbench-support="1"
          className="shrink-0 border-b border-gray-200 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400"
        >
          <summary className="cursor-pointer">{S.workbench.support.title}</summary>
          <p className="mt-1">{S.workbench.support.line}</p>
          <ul className="mt-1 space-y-0.5">
            <li>{S.workbench.support.exact}</li>
            <li>{S.workbench.support.fileOnly}</li>
            <li>{S.workbench.support.degraded}</li>
            <li>{S.workbench.support.unreachable}</li>
            <li>{S.workbench.support.thirdParty}</li>
          </ul>
          <p className="mt-1">{S.workbench.support.boundaries.lead}</p>
          <ul className="mt-0.5 space-y-0.5">
            <li>{S.workbench.support.boundaries.rows.jsx}</li>
            <li>{S.workbench.support.boundaries.rows.styles}</li>
            <li>{S.workbench.support.boundaries.rows.ambiguous}</li>
            <li>{S.workbench.support.boundaries.rows.channel}</li>
          </ul>
        </details>
      )}

      <div ref={containerRef} className="min-h-0 flex-1 bg-white dark:bg-gray-950" />

      {guestState.kind === "ready" && (
        <p className={strip("muted")}>
          {selected !== null
            ? pick.picked.length > 1
              ? S.workbench.pickedNextBatch(pick.picked.length)
              : S.workbench.pickedNext
            : pick.multi
              ? S.workbench.multiHint
              : mode === "off"
                ? S.workbench.pickOffHint
                : S.workbench.pickHint}
        </p>
      )}
    </div>
  );

  /** A status strip: one line, its own colour, never a bare line of body text. */
  function strip(tone: "busy" | "attention" | "success" | "danger" | "muted"): string {
    return `shrink-0 px-3 py-1.5 text-xs ${toneStrip[tone]}`;
  }
}

/** One §9.4 note as a sentence; `host` names the element when the note is about one (M4.4). */
function boundsText(note: BoundsNote, host: string): string {
  switch (note.kind) {
    case "shadow":
      return S.workbench.domContext.shadow(host);
    case "frame":
      return S.workbench.domContext.frame;
    case "not-visible":
      return S.workbench.notVisible[note.reason];
    case "frames-in-page":
      return S.workbench.framesInPage(note.count);
  }
}

/** A stable key for the list above: the kind, plus the reason when there is one. */
function boundsKey(note: BoundsNote): string {
  return note.kind === "not-visible" ? `${note.kind}:${note.reason}` : note.kind;
}
