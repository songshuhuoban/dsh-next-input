import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { bindComposerDom } from '../src/composer-dom.js';

function fixture() {
  const window = new Window();
  window.document.body.innerHTML = `<div data-composer-card>
    <div><span data-marker></span></div><div>
      <div data-composer-input contenteditable="true" data-placeholder="Default" aria-label="Default"></div>
      <div data-composer-placeholder>Default</div>
    </div></div><div data-composer-card><div data-composer-input contenteditable="true"></div>
      <div data-composer-placeholder>Other default</div></div>`;
  const marker = window.document.querySelector('[data-marker]')!;
  const editor = window.document.querySelector('[data-composer-input]')!;
  const placeholder = window.document.querySelector('[data-composer-placeholder]')!;
  let eligible = true;
  let accepted = true;
  let manualInputs = 0;
  const inserted: string[] = [];
  const composition: boolean[] = [];
  const binding = bindComposerDom(marker as unknown as HTMLElement, {
    canAccept: () => eligible,
    insertSuggestion: (text) => { if (accepted) inserted.push(text); return accepted; },
    onManualInput: () => { manualInputs++; },
    onCompositionChange: (value) => { composition.push(value); },
  });
  const tab = (options: Record<string, unknown> = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...options });
    editor.dispatchEvent(event);
    return event;
  };
  return { window, marker, editor, placeholder, inserted, composition, binding, tab,
    setEligible(value: boolean) { eligible = value; }, setAccepted(value: boolean) { accepted = value; },
    get manualInputs() { return manualInputs; } };
}

test('borrows placeholder without replacing the React-owned text node and restores it', () => {
  const f = fixture();
  const textNode = f.placeholder.firstChild;
  f.binding.setSuggestion('Continue with the implementation.');
  assert.equal(f.placeholder.firstChild, textNode);
  assert.equal(f.placeholder.textContent, 'Continue with the implementation.');
  assert.equal(f.editor.getAttribute('data-placeholder'), 'Continue with the implementation.');
  f.binding.setSuggestion(null);
  assert.equal(f.placeholder.firstChild, textNode);
  assert.equal(f.placeholder.textContent, 'Default');
  assert.equal(f.editor.getAttribute('aria-label'), 'Default');
  assert.equal(f.window.document.querySelectorAll('[data-composer-placeholder]')[1].textContent, 'Other default');
  f.binding.dispose();
});

test('captures an updated stock placeholder and restores the latest default', async () => {
  const f = fixture();
  const textNode = f.placeholder.firstChild!;
  f.binding.setSuggestion('A suggestion');
  // React updates its existing text node and attributes when a composer mode changes.
  textNode.nodeValue = 'New default';
  f.editor.setAttribute('data-placeholder', 'New default');
  f.editor.setAttribute('aria-label', 'New default');
  await f.window.happyDOM.waitUntilComplete();
  assert.equal(f.placeholder.firstChild, textNode);
  assert.equal(textNode.nodeValue, 'A suggestion');
  f.binding.dispose();
  assert.equal(textNode.nodeValue, 'New default');
  assert.equal(f.editor.getAttribute('data-placeholder'), 'New default');
});

test('only consumes plain Tab after successful insertion', () => {
  const f = fixture();
  f.binding.setSuggestion('Suggested reply');
  for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'isComposing', 'repeat']) {
    assert.equal(f.tab({ [modifier]: true }).defaultPrevented, false);
  }
  f.setAccepted(false);
  assert.equal(f.tab().defaultPrevented, false);
  assert.equal(f.placeholder.textContent, 'Suggested reply');
  f.setAccepted(true);
  assert.equal(f.tab().defaultPrevented, true);
  assert.deepEqual(f.inserted, ['Suggested reply']);
  assert.equal(f.placeholder.textContent, 'Default');
  assert.equal(f.tab().defaultPrevented, false);
  f.binding.dispose();
});

test('manual characters, including whitespace, and unavailable guards leave Tab native', () => {
  const f = fixture();
  f.binding.setSuggestion('Suggested reply');
  for (const draft of ['typed', ' ', '\n']) {
    f.editor.textContent = draft;
    assert.equal(f.tab().defaultPrevented, false);
  }
  f.editor.textContent = '';
  f.setEligible(false);
  assert.equal(f.tab().defaultPrevented, false);
  assert.deepEqual(f.inserted, []);
  f.binding.setSuggestion(null);
  assert.equal(f.placeholder.textContent, 'Default');
  f.binding.dispose();
});

test('manual input hides suggestions synchronously, and composition blocks Tab', () => {
  const f = fixture();
  f.binding.setSuggestion('Suggested reply');
  f.editor.dispatchEvent(new f.window.Event('beforeinput', { bubbles: true }));
  assert.equal(f.manualInputs, 1);
  assert.equal(f.placeholder.textContent, 'Default');
  assert.equal(f.tab().defaultPrevented, false);
  f.binding.setSuggestion('Second suggestion');
  f.editor.dispatchEvent(new f.window.Event('compositionstart', { bubbles: true }));
  assert.equal(f.placeholder.textContent, 'Default');
  assert.equal(f.tab().defaultPrevented, false);
  f.editor.dispatchEvent(new f.window.Event('compositionend', { bubbles: true }));
  assert.deepEqual(f.composition, [true, false]);
  assert.equal(f.manualInputs, 2);
  f.binding.setSuggestion('Third suggestion');
  f.editor.setAttribute('data-composer-composing', '');
  assert.equal(f.tab().defaultPrevented, false);
  f.binding.dispose();
  assert.equal(f.placeholder.textContent, 'Default');
});

test('a changed or incompatible composer degrades silently and disposal removes listeners', () => {
  const f = fixture();
  f.placeholder.innerHTML = '<span>Default</span>';
  f.binding.setSuggestion('Suggested reply');
  assert.equal(f.placeholder.textContent, 'Default');
  assert.equal(f.tab().defaultPrevented, false);
  f.binding.dispose();
  f.editor.dispatchEvent(new f.window.Event('beforeinput', { bubbles: true }));
  assert.equal(f.manualInputs, 0);
  assert.equal(f.tab().defaultPrevented, false);
});

test('an editor replaced during composition releases the composition latch', async () => {
  const f = fixture();
  f.editor.dispatchEvent(new f.window.Event('compositionstart', { bubbles: true }));
  const replacement = f.editor.cloneNode(true);
  f.editor.replaceWith(replacement);
  await f.window.happyDOM.waitUntilComplete();
  assert.deepEqual(f.composition, [true, false]);
  assert.equal(f.manualInputs, 1);
  f.binding.dispose();
});
