/** Modal dialogs, on the native `<dialog>`: a title, some content, two buttons. */

export interface DialogOptions {
  title: string;
  /** Paragraphs (strings) and controls, in order. */
  body: ReadonlyArray<string | Node>;
  confirm: string;
  /** The other button; null for none (a message to acknowledge). Default "Cancel". */
  cancel?: string | null;
  /** Draw the confirm button as destructive. */
  danger?: boolean;
  /** Why it cannot be confirmed yet, shown in the dialog. */
  validate?: () => string | undefined;
}

/** Show a dialog; true when confirmed, false when cancelled or escaped. */
export function openDialog(options: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const returnTo = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "dialog";
    const title = document.createElement("h2");
    title.id = "dialog-title";
    title.textContent = options.title;
    dialog.setAttribute("aria-labelledby", title.id);

    const form = document.createElement("form");
    form.method = "dialog";
    form.appendChild(title);
    for (const part of options.body) {
      if (typeof part === "string") {
        const text = document.createElement("p");
        text.textContent = part;
        form.appendChild(text);
      } else {
        form.appendChild(part);
      }
    }
    const error = document.createElement("p");
    error.className = "error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    form.appendChild(error);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    let confirmed = false;
    if (options.cancel !== null) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = options.cancel ?? "Cancel";
      cancel.addEventListener("click", () => dialog.close());
      actions.appendChild(cancel);
    }
    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.textContent = options.confirm;
    confirm.classList.toggle("danger", options.danger === true);
    actions.appendChild(confirm);
    form.appendChild(actions);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const problem = options.validate?.();
      error.hidden = problem === undefined;
      error.textContent = problem ?? "";
      if (problem === undefined) {
        confirmed = true;
        dialog.close();
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (returnTo instanceof HTMLElement) {
        returnTo.focus({ preventScroll: true });
      }
      resolve(confirmed);
    });
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    dialog.showModal();
    const first = form.querySelector<HTMLElement>("input, select, textarea");
    (first ?? confirm).focus();
    if (first instanceof HTMLInputElement && first.type === "text") {
      first.select();
    }
  });
}

/** A labelled control for a dialog. */
export function dialogField(label: string, control: HTMLElement): HTMLLabelElement {
  const field = document.createElement("label");
  field.className = "field";
  const text = document.createElement("span");
  text.textContent = label;
  field.append(text, control);
  return field;
}

/** A checkbox or radio with its label, for a dialog. */
export function dialogChoice(
  type: "checkbox" | "radio",
  label: string,
  options: { name?: string; checked?: boolean } = {},
): { field: HTMLLabelElement; input: HTMLInputElement } {
  const field = document.createElement("label");
  field.className = type;
  const input = document.createElement("input");
  input.type = type;
  input.checked = options.checked ?? false;
  if (options.name !== undefined) {
    input.name = options.name;
  }
  field.append(input, ` ${label}`);
  return { field, input };
}

export function textInput(value = ""): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  return input;
}
