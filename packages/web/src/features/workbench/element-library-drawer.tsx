/**
 * The element library's drawer (L3) — the panel's own collection of elements seen on **other** sites.
 *
 * Why it is inside the panel and not a screen of its own: the library is part of the UI workbench, so
 * it is reachable exactly while the workbench is (BHH, 2026-09-14: "这个元素库是跟着 UI 设计工作台的，
 * 只有打开这个工作台才可以使用"). There is no nav entry, no route and no other way in — which is also
 * why this component is mounted by `workbench-panel.tsx` and reads its own state on first open rather
 * than at app start: someone who never opens the drawer never pays for the library (the blob rides in
 * `GET /api/me/prefs`).
 *
 * The flow it implements, in one line: paste what DevTools copied → see it restored immediately
 * (`element-restore.ts`, no model in the loop) → name it → file it under a category → it is a row in
 * this list. The AI-restored variant of step two is L3.4 and is not here yet.
 *
 * Where the pixels come from: rows, chips and the address-row button are the shared components
 * (Button / GlyphIcon / Input / Modal), and the one thing that is not shared is the sandbox — an
 * `<iframe sandbox="allow-scripts">` fed by `srcdoc`, the same treatment the Workspace's own HTML
 * preview gets (`features/chat/workspace-browser.tsx`): scripts may run inside it, it can never
 * reach the app's origin, and it grows no Node.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../api/endpoints";
import { apiErrorText } from "../../lib/api-error";
import { ICON_SIZE } from "../../lib/icon-scale";
import { S } from "../../lib/strings";
import { Button } from "../../components/ui/button";
import { ConfirmModal } from "../../components/ui/confirm-modal";
import { GlyphIcon } from "../../components/ui/glyph-icon";
import { CLEAR_ICON, FOLDER_ICON } from "../../components/ui/icons";
import { Input, Textarea } from "../../components/ui/input";
import { Modal } from "../../components/ui/modal";
import { toastError, toastSuccess } from "../../components/ui/toast";
import { Tooltip } from "../../components/ui/tooltip";
import {
  addElement,
  createCategory,
  elementsOf,
  emptyLibrary,
  newLibraryId,
  normalizeLibrary,
  removeElement,
  suggestElementName,
} from "./element-library";
import type { ElementLibrary, ElementLibraryItem, LibraryRefusal } from "./element-library";
import { elementDocument, restoreFromPaste } from "./element-restore";
import type { RestoreNotice } from "./element-restore";

/** A stamp a row can show without a library: day, month and year, in the reader's own locale. */
function dayLabel(stamp: number): string {
  if (stamp <= 0) return "";
  return new Date(stamp).toLocaleDateString();
}

export interface ElementLibraryDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function ElementLibraryDrawer({ open, onClose }: ElementLibraryDrawerProps) {
  /** `null` while the stored library is unknown — including after a failed read (see `loadFailed`). */
  const [library, setLibrary] = useState<ElementLibrary | null>(null);
  const [reading, setReading] = useState(false);
  /** `null` = 全部. A category the user deletes falls back to 全部 rather than to a blank list. */
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [paste, setPaste] = useState("");
  const [itemName, setItemName] = useState("");
  /** Whether the name is the user's own: a name they typed is never overwritten by a suggestion. */
  const [namedByHand, setNamedByHand] = useState(false);
  const [itemCategoryId, setItemCategoryId] = useState("");
  const [saving, setSaving] = useState(false);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ElementLibraryItem | null>(null);

  /** The rollback value for an optimistic write: a stale closure would restore a library two edits old. */
  const libraryRef = useRef<ElementLibrary | null>(null);
  libraryRef.current = library;
  const readTried = useRef(false);

  const read = useCallback(() => {
    setReading(true);
    void api
      .getPrefs()
      .then(({ prefs }) => {
        setLibrary(normalizeLibrary(prefs.elementLibrary));
      })
      .catch((error: unknown) => {
        // Left unknown on purpose: writing an empty library here would let the next save replace
        // everything the user ever collected with the one element they are holding.
        setLibrary(null);
        toastError(`${S.workbench.library.loadFailed} ${apiErrorText(error)}`);
      })
      .finally(() => setReading(false));
  }, []);

  // Read on first open, not at app start: someone who never opens the drawer never pays for it.
  useEffect(() => {
    if (!open || readTried.current) return;
    readTried.current = true;
    read();
  }, [open, read]);

  const persist = useCallback((next: ElementLibrary) => {
    const rollback = libraryRef.current;
    setLibrary(next);
    void api.putPrefs({ elementLibrary: next }).catch((error: unknown) => {
      setLibrary(rollback);
      toastError(`${S.workbench.library.saveFailed} ${apiErrorText(error)}`);
    });
  }, []);

  const restored = useMemo(() => (adding ? restoreFromPaste(paste) : null), [adding, paste]);
  /** The suggestion follows the paste until the user types a name of their own. */
  useEffect(() => {
    if (restored === null || namedByHand) return;
    setItemName(suggestElementName(restored.html, restored.host));
  }, [restored, namedByHand]);

  const refusalText = (refusal: LibraryRefusal): string | null => {
    const copy = S.workbench.library;
    if (refusal === "duplicate-name") return copy.duplicateCategory;
    if (refusal === "too-many-categories") return copy.tooManyCategories;
    if (refusal === "too-many-items") return copy.tooManyItems;
    if (refusal === "too-large") return copy.tooLarge;
    if (refusal === "not-enough-room") return copy.notEnoughRoom;
    if (refusal === "no-markup") return copy.needPaste;
    // An empty name (or no category) is visible on the form itself: the save button is disabled.
    return null;
  };

  const createCategoryNow = () => {
    if (library === null) return;
    const result = createCategory(library, categoryDraft, newLibraryId("elc"), Date.now());
    if ("refusal" in result) {
      setCategoryError(refusalText(result.refusal));
      return;
    }
    persist(result.library);
    setActiveCategoryId(result.category.id);
    setCategoryDraft("");
    setCategoryError(null);
    setComposing(false);
  };

  const openAdd = () => {
    setPaste("");
    setItemName("");
    setNamedByHand(false);
    setItemCategoryId(activeCategoryId ?? library?.categories[0]?.id ?? "");
    setAdding(true);
  };

  const save = () => {
    if (library === null || restored === null) return;
    const draft = {
      categoryId: itemCategoryId,
      name: itemName.trim() === "" ? suggestElementName(restored.html, restored.host) : itemName,
      paste: paste.trim(),
      html: restored.html,
      css: restored.css,
      ...(restored.host === null ? {} : { host: restored.host }),
    };
    const result = addElement(library, draft, newLibraryId("eli"), Date.now());
    if ("refusal" in result) {
      toastError(refusalText(result.refusal) ?? S.workbench.library.needPaste);
      return;
    }
    setSaving(true);
    persist(result.library);
    setActiveCategoryId(result.item.categoryId);
    setAdding(false);
    setSaving(false);
    toastSuccess(S.workbench.library.saved);
  };

  if (!open) return null;

  const copy = S.workbench.library;
  const items = library === null ? [] : elementsOf(library, activeCategoryId);
  const notice = (key: RestoreNotice): string => copy.notice[key];
  const canSave =
    library !== null &&
    restored !== null &&
    restored.html !== "" &&
    itemCategoryId !== "" &&
    !saving;

  return (
    <div
      data-element-library="1"
      className="anim-drawer-right absolute inset-0 z-20 flex flex-col border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <GlyphIcon d={FOLDER_ICON} size={ICON_SIZE.compactButton} />
        <span className="text-sm font-semibold">{copy.title}</span>
        <span className="truncate text-xs text-gray-400">
          {library === null ? "" : copy.summary(library.items.length, library.categories.length)}
        </span>
        <span className="flex-1" />
        <Tooltip label={copy.close} placement="bottom" className="shrink-0">
          <Button size="iconSm" variant="ghost" aria-label={copy.close} onClick={onClose}>
            <GlyphIcon d={CLEAR_ICON} size={ICON_SIZE.compactButton} />
          </Button>
        </Tooltip>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-gray-200 px-3 pb-2 dark:border-gray-800">
        <Button
          size="sm"
          disabled={library === null || library.categories.length >= 30}
          onClick={() => {
            setComposing((was) => !was);
            setCategoryError(null);
          }}
        >
          ＋ {copy.newCategory}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={library === null || library.categories.length === 0}
          onClick={openAdd}
        >
          ＋ {copy.addElement}
        </Button>
        {library !== null && library.categories.length === 0 && (
          <span className="text-xs text-gray-400">{copy.needCategory}</span>
        )}
      </div>

      {composing && (
        <div className="flex shrink-0 items-start gap-1.5 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          <Input
            size="sm"
            autoFocus
            value={categoryDraft}
            placeholder={copy.categoryPlaceholder}
            aria-label={copy.newCategory}
            error={categoryError ?? undefined}
            className="min-w-0 flex-1"
            onChange={(e) => setCategoryDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createCategoryNow();
            }}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={categoryDraft.trim() === ""}
            onClick={createCategoryNow}
          >
            {copy.create}
          </Button>
        </div>
      )}

      {library !== null && library.categories.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          <CategoryChip
            label={copy.all}
            count={library.items.length}
            active={activeCategoryId === null}
            onClick={() => setActiveCategoryId(null)}
          />
          {library.categories.map((category) => (
            <CategoryChip
              key={category.id}
              categoryId={category.id}
              label={category.name}
              count={elementsOf(library, category.id).length}
              active={activeCategoryId === category.id}
              onClick={() => setActiveCategoryId(category.id)}
            />
          ))}
        </div>
      )}

      <div data-library-count={items.length} className="min-h-0 flex-1 overflow-y-auto">
        {library === null ? (
          <div className="px-3 py-4 text-xs text-gray-400">
            {reading ? copy.reading : copy.loadFailed}{" "}
            {!reading && (
              <button type="button" className="underline" onClick={read}>
                {copy.retry}
              </button>
            )}
          </div>
        ) : items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-gray-400">
            {library.categories.length === 0 ? copy.emptyLibrary : copy.emptyCategory}
          </p>
        ) : (
          <ul>
            {items.map((item) => (
              <li key={item.id} className="border-b border-gray-100 dark:border-gray-900">
                <div className="flex items-start gap-1 px-3 py-2">
                  <button
                    type="button"
                    data-library-item={item.id}
                    aria-expanded={expandedItemId === item.id}
                    onClick={() => setExpandedItemId(expandedItemId === item.id ? null : item.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-xs text-gray-800 dark:text-gray-200">
                      {item.name}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-gray-400">
                      {[
                        item.host === undefined ? null : copy.source(item.host),
                        item.ai === true ? copy.aiTag : null,
                        dayLabel(item.createdAt),
                      ]
                        .filter((part) => part !== null)
                        .join(" · ")}
                    </span>
                  </button>
                  <Button
                    size="iconSm"
                    variant="ghost"
                    aria-label={copy.remove(item.name)}
                    onClick={() => setPendingDelete(item)}
                  >
                    <GlyphIcon d={CLEAR_ICON} size={ICON_SIZE.compactButton} />
                  </Button>
                </div>
                {expandedItemId === item.id && (
                  <div className="px-3 pb-2">
                    <iframe
                      data-library-preview={item.id}
                      title={item.name}
                      sandbox="allow-scripts"
                      srcDoc={elementDocument(item.html, item.css)}
                      className="h-40 w-full rounded-md border border-gray-200 bg-white dark:border-gray-800"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal
        open={adding}
        title={copy.addElement}
        onClose={() => setAdding(false)}
        widthClass="sm:max-w-lg"
        footer={
          <>
            <Button size="sm" onClick={() => setAdding(false)}>
              {copy.cancel}
            </Button>
            <Button size="sm" variant="primary" disabled={!canSave} onClick={save}>
              {saving ? copy.saving : copy.save}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Textarea
            label={copy.pasteLabel}
            hint={copy.howToCopy}
            mono
            rows={6}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
          {restored !== null && restored.notices.length > 0 && (
            <ul
              data-library-notices={restored.notices.length}
              className="space-y-0.5 text-xs text-amber-600 dark:text-amber-500"
            >
              {restored.notices.map((key) => (
                <li key={key}>{notice(key)}</li>
              ))}
            </ul>
          )}
          <div>
            <div className="mb-1 text-xs text-gray-500">{copy.resultLabel}</div>
            {restored === null || restored.html === "" ? (
              <p className="text-xs text-gray-400">{copy.notice.noMarkup}</p>
            ) : (
              <iframe
                data-library-preview="draft"
                title={copy.title}
                sandbox="allow-scripts"
                srcDoc={elementDocument(restored.html, restored.css)}
                className="h-40 w-full rounded-md border border-gray-200 bg-white dark:border-gray-800"
              />
            )}
          </div>
          <Input
            label={copy.itemName}
            placeholder={copy.itemNamePlaceholder}
            value={itemName}
            onChange={(e) => {
              setNamedByHand(true);
              setItemName(e.target.value);
            }}
          />
          <div>
            <div className="mb-1 text-xs text-gray-500">{copy.itemCategory}</div>
            <div className="flex flex-wrap gap-1.5">
              {library?.categories.map((category) => (
                <CategoryChip
                  key={category.id}
                  label={category.name}
                  active={itemCategoryId === category.id}
                  onClick={() => setItemCategoryId(category.id)}
                />
              ))}
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={pendingDelete !== null}
        title={copy.title}
        tone="danger"
        confirmLabel={S.common.delete}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const item = pendingDelete;
          setPendingDelete(null);
          if (item === null || library === null) return;
          persist(removeElement(library, item.id));
        }}
      >
        <p className="text-sm">
          {pendingDelete === null ? "" : copy.removeConfirm(pendingDelete.name)}
        </p>
      </ConfirmModal>
    </div>
  );
}

/** One category, or 全部: a chip, because the panel is 384px wide and a second column is not. */
function CategoryChip({
  label,
  count,
  active,
  categoryId,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  categoryId?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      {...(categoryId === undefined ? {} : { "data-library-category": categoryId })}
      onClick={onClick}
      className={`shrink-0 rounded-full border px-2 py-0.5 text-xs transition-colors duration-150 ${
        active
          ? "border-transparent bg-[var(--accent-bg)] text-[var(--accent-fg)]"
          : "border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-800/60"
      }`}
    >
      {label}
      {count === undefined ? "" : ` ${count}`}
    </button>
  );
}
