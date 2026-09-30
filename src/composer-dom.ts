/**
 * Small presentation adapter for the stock DSH 0.1.7 composer. The public
 * inputActions own edits; this adapter only borrows its placeholder and key
 * event surface. All selectors remain inside the slot's own composer card.
 */
export interface ComposerDomOptions {
  canAccept(): boolean;
  insertSuggestion(text: string): boolean;
  onManualInput(): void;
  onCompositionChange(composing: boolean): void;
}

export interface ComposerDomBinding {
  setSuggestion(text: string | null): void;
  dispose(): void;
}

/** Tab retains its native behavior unless an empty, unmodified input can accept. */
export function isCompletionTab(event: KeyboardEvent): boolean {
  return event.key === 'Tab' && !event.defaultPrevented && !event.repeat
    && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
    && !event.isComposing && event.keyCode !== 229;
}

export function bindComposerDom(marker: HTMLElement, options: ComposerDomOptions): ComposerDomBinding {
  const card = marker.closest<HTMLElement>('[data-composer-card]');
  if (!card) return { setSuggestion() {}, dispose() {} };
  const MutationObserverType = card.ownerDocument.defaultView?.MutationObserver;
  let suggestion: string | null = null;
  let disposed = false;
  let composing = false;
  let compositionEditor: HTMLElement | null = null;
  let paintedEditor: HTMLElement | null = null;
  let paintedPlaceholder: HTMLElement | null = null;
  let paintedText: string | null = null;
  let defaultText = '';
  let defaultAttribute: string | null = null;
  let defaultLabel: string | null = null;

  const editorOf = () => card.querySelector<HTMLElement>('[data-composer-input]');
  const textNodeOf = (element: HTMLElement | null): ChildNode | null =>
    element?.childNodes.length === 1 && element.firstChild?.nodeType === 3 ? element.firstChild : null;
  const restoreAttribute = (element: HTMLElement, name: string, value: string | null) => {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  };
  const restore = () => {
    if (paintedText !== null) {
      const textNode = textNodeOf(paintedPlaceholder);
      if (textNode?.nodeValue === paintedText) textNode.nodeValue = defaultText;
      if (paintedEditor?.getAttribute('data-placeholder') === paintedText) restoreAttribute(paintedEditor, 'data-placeholder', defaultAttribute);
      if (paintedEditor?.getAttribute('aria-label') === paintedText) restoreAttribute(paintedEditor, 'aria-label', defaultLabel);
    }
    paintedEditor = null;
    paintedPlaceholder = null;
    paintedText = null;
  };
  const isEmpty = (editor: HTMLElement) => (editor.textContent ?? '') === '';
  const paint = () => {
    if (disposed) return;
    const editor = editorOf();
    if (compositionEditor && editor !== compositionEditor) {
      compositionEditor = null;
      composing = false;
      suggestion = null;
      restore();
      options.onManualInput();
      options.onCompositionChange(false);
    }
    const placeholder = card.querySelector<HTMLElement>('[data-composer-placeholder]');
    const textNode = textNodeOf(placeholder);
    const canShow = suggestion !== null && editor !== null && placeholder !== null && textNode !== null
      && editor.getAttribute('contenteditable') === 'true' && isEmpty(editor)
      && !composing && !editor.hasAttribute('data-composer-composing') && options.canAccept();
    if (!canShow) { restore(); return; }
    if (paintedEditor !== editor || paintedPlaceholder !== placeholder) restore();
    // React may replace the default copy while a suggestion is visible. Capture
    // its latest value, so cleanup never puts an earlier mode's copy back.
    if (textNode.nodeValue !== paintedText) defaultText = textNode.nodeValue ?? '';
    if (editor.getAttribute('data-placeholder') !== paintedText) defaultAttribute = editor.getAttribute('data-placeholder');
    if (editor.getAttribute('aria-label') !== paintedText) defaultLabel = editor.getAttribute('aria-label');
    paintedEditor = editor;
    paintedPlaceholder = placeholder;
    paintedText = suggestion;
    if (textNode.nodeValue !== suggestion) textNode.nodeValue = suggestion;
    if (editor.getAttribute('data-placeholder') !== suggestion) editor.setAttribute('data-placeholder', suggestion!);
    if (editor.getAttribute('aria-label') !== suggestion) editor.setAttribute('aria-label', suggestion!);
  };
  const insideEditor = (target: EventTarget | null, editor: HTMLElement) =>
    target === editor || target !== null && editor.contains(target as Node);
  const keydown = (event: KeyboardEvent) => {
    const editor = editorOf();
    const text = suggestion;
    if (!editor || !insideEditor(event.target, editor) || !text || paintedText !== text || paintedEditor !== editor
      || textNodeOf(paintedPlaceholder)?.nodeValue !== text || !isCompletionTab(event)
      || composing || editor.hasAttribute('data-composer-composing')
      || editor.getAttribute('contenteditable') !== 'true' || !isEmpty(editor) || !options.canAccept()) return;
    // A rejected public revision CAS leaves Tab and the draft untouched.
    if (!options.insertSuggestion(text)) return;
    suggestion = null;
    restore();
    event.preventDefault();
    event.stopPropagation();
  };
  const manualInput = (event: Event) => {
    const editor = editorOf();
    if (!editor || !insideEditor(event.target, editor)) return;
    suggestion = null;
    restore();
    options.onManualInput();
  };
  const compositionStart = (event: Event) => {
    const editor = editorOf();
    if (!editor || !insideEditor(event.target, editor)) return;
    composing = true;
    compositionEditor = editor;
    restore();
    options.onCompositionChange(true);
  };
  const compositionEnd = (event: Event) => {
    const editor = editorOf();
    if (!editor || !insideEditor(event.target, editor)) return;
    composing = false;
    compositionEditor = null;
    // A composition remains manual input even if its final characters have
    // not reached the observable editor projection yet.
    manualInput(event);
    options.onCompositionChange(false);
  };

  card.addEventListener('keydown', keydown, true);
  card.addEventListener('beforeinput', manualInput, true);
  card.addEventListener('input', manualInput, true);
  card.addEventListener('paste', manualInput, true);
  card.addEventListener('drop', manualInput, true);
  card.addEventListener('compositionstart', compositionStart, true);
  card.addEventListener('compositionend', compositionEnd, true);
  const observer = MutationObserverType ? new MutationObserverType(paint) : undefined;
  observer?.observe(card, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-placeholder', 'aria-label', 'contenteditable', 'data-composer-composing'],
  });

  return {
    setSuggestion(text) { if (!disposed) { suggestion = text; paint(); } },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      card.removeEventListener('keydown', keydown, true);
      card.removeEventListener('beforeinput', manualInput, true);
      card.removeEventListener('input', manualInput, true);
      card.removeEventListener('paste', manualInput, true);
      card.removeEventListener('drop', manualInput, true);
      card.removeEventListener('compositionstart', compositionStart, true);
      card.removeEventListener('compositionend', compositionEnd, true);
      restore();
    },
  };
}
