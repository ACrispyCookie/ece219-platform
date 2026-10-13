import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
// jsdom has no top-layer dialog implementation. Production uses native modal
// inertness; tests exercise explicit keyboard handling and actual button choice.
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true,
  value: function () {
    this.setAttribute('open', '');
  },
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true,
  value: function () {
    this.removeAttribute('open');
  },
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});
