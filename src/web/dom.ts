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
