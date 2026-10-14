// Event delegation: elements declare data-action="name"; modules register a
// handler per (event type, name). One listener per event type on the document.

import { reportError } from './api.js';

const handlers = new Map();   // 'click' -> Map(name -> fn)

export function onAction(type, name, fn) {
  if (!handlers.has(type)) handlers.set(type, new Map());
  handlers.get(type).set(name, fn);
}

export function installDelegation(root = document) {
  for (const type of ['click', 'input', 'change', 'submit']) {
    root.addEventListener(type, event => {
      const el = event.target instanceof Element ? event.target.closest('[data-action]') : null;
      if (!el) return;
      const fn = handlers.get(type)?.get(el.dataset.action);
      if (!fn) return;
      if (type === 'submit') event.preventDefault();
      try {
        const result = fn(event, el);
        if (result && typeof result.catch === 'function') result.catch(err => reportError(err, 'Something went wrong'));
      } catch (err) {
        reportError(err, 'Something went wrong');
      }
    });
  }
}
