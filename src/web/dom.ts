/** Small DOM helpers shared across views. */

/** Get a required element by id, throwing if it is missing. */
export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing element #${id}`);
  }
  return node as T;
}

/** Show a message in a node, or hide the node when the message is undefined. */
export function showError(node: HTMLElement, message: string | undefined): void {
  if (message === undefined) {
    node.hidden = true;
    node.textContent = "";
  } else {
    node.hidden = false;
    node.textContent = message;
  }
}

/**
 * Mark the step a tool is on in its step list (`<ol class="steps">`): the
 * steps before `current` are done, `current` is the current one, the rest are
 * upcoming. A `current` past the last step marks every step done.
 */
export function setStep(listId: string, current: number): void {
  el(listId)
    .querySelectorAll("li")
    .forEach((step, index) => {
      step.classList.toggle("done", index < current);
      if (index === current) {
        step.setAttribute("aria-current", "step");
      } else {
        step.removeAttribute("aria-current");
      }
    });
}
